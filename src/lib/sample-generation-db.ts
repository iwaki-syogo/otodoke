import type { AdminClient } from "@/lib/supabase/admin";

export const SAMPLE_GENERATION_HEADER = "x-otodoke-sample-generation";
export const SAMPLE_USER_HEADER = "x-otodoke-sample-user";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
interface GenerationScope { userId: string; generation: string; base: AdminClient }
const scopes = new WeakMap<AdminClient, GenerationScope>();
const SCOPE = Symbol("otodoke mail generation");

/** A confirmed clear intentionally cancels the request; retrying it could recreate its mail. */
export class MailGenerationExpiredError extends Error {
  constructor() { super("mail work was cleared; start it again"); this.name = "MailGenerationExpiredError"; }
}

/** Fix the clear generation once, before looking up or copying real-mail work. */
export async function beginMailGeneration(db: AdminClient, userId: string): Promise<AdminClient> {
  // withMailRun and other transparent proxies forward this private metadata property.
  const scope = scopes.get(db) ?? Reflect.get(db, SCOPE) as GenerationScope | undefined;
  if (scope) {
    if (scope.userId !== userId) throw new Error("mail generation owner mismatch");
    return db;
  }
  return beginSampleLoad(db, userId);
}

/** Read the durable generation before reading the sample or starting any of its writes. */
export async function beginSampleLoad(db: AdminClient, userId: string): Promise<AdminClient> {
  const { data, error } = await db.rpc("begin_sample_load", { p_user_id: userId });
  if (error) throw new Error(`sample generation: ${error.message}`);
  if (typeof data !== "string" || !UUID.test(data)) throw new Error("sample generation returned no generation");
  return withSampleGeneration(db, userId, data);
}

/**
 * Each request carries the same generation, including the pipeline's owned RPCs and the final
 * received-at writes. The database compares and locks it in the write transaction. A JS-only
 * check before a query cannot protect a query delayed until after another request clears it.
 */
export function withSampleGeneration(db: AdminClient, userId: string, generation: string | null): AdminClient {
  if (!generation || !UUID.test(generation)) throw new Error("sample mail has no generation; load the sample again");
  // An unread sample uses its stored generation, even inside a newly started real-mail batch.
  // Replace a scope instead of nesting header setters which could restore the newer generation.
  const base = scopes.get(db)?.base ?? db;
  const scope = { userId, generation, base };
  type Context = { name: string; args: unknown };
  const checkCancellation = async (result: unknown, context?: Context): Promise<unknown> => {
    const error = result && typeof result === "object" ? (result as { error?: { code?: string; message?: string } }).error : undefined;
    if (error?.code !== "55000") return result;
    if (error.message !== "sample load was cleared; load it again" && error.message !== "sample generation or owner is missing") return result;
    if (error.message === "sample generation or owner is missing") {
      // An owned RPC loses the email owner after clear deletes its row. Do not confuse an
      // existing row of another owner, malformed headers or a failed lookup with that case.
      const args = context?.args as { p_email_id?: unknown } | undefined;
      if (!context || !["mail_run_write", "create_mail_parcel", "update_mail_parcel", "ensure_mail_parcel_items"].includes(context.name) || typeof args?.p_email_id !== "string") return result;
      try {
        const mail = await base.from("emails").select("user_id").eq("id", args.p_email_id).maybeSingle();
        if (mail.error || mail.data) return result;
      } catch {
        return result;
      }
    }
    // Compare only. Keep this request's captured generation, never adopt the new one.
    try {
      const current = await base.rpc("begin_sample_load", { p_user_id: userId });
      if (!current.error && typeof current.data === "string" && UUID.test(current.data) && current.data !== generation) throw new MailGenerationExpiredError();
    } catch (error) {
      if (error instanceof MailGenerationExpiredError) throw error;
      // Unknown database failures retain the original failure and the webhook's retry path.
    }
    return result;
  };
  const wrap = (builder: object, context?: Context): object => new Proxy(builder, {
    get(chain, property) {
      if (property === "then") {
        return (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => {
          const setHeader = Reflect.get(chain, "setHeader");
          if (typeof setHeader !== "function") throw new Error("sample database builder cannot set request headers");
          const headed = setHeader.call(chain, SAMPLE_USER_HEADER, userId);
          headed.setHeader(SAMPLE_GENERATION_HEADER, generation);
          const response = Reflect.get(headed, "then").call(headed);
          return Promise.resolve(response).then((result) => checkCancellation(result, context)).then(resolve, reject);
        };
      }
      const value = Reflect.get(chain, property);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => wrap(value.apply(chain, args), context);
    },
  });
  const scoped = new Proxy(base, {
    get(target, property) {
      if (property === SCOPE) return scope;
      if (property === "from" || property === "rpc") return (...args: unknown[]) => wrap(Reflect.apply(Reflect.get(target, property), target, args), property === "rpc" ? { name: String(args[0]), args: args[1] } : undefined);
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  scopes.set(scoped, scope);
  return scoped;
}
