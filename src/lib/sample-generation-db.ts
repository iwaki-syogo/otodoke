import type { AdminClient } from "@/lib/supabase/admin";

export const SAMPLE_GENERATION_HEADER = "x-otodoke-sample-generation";
export const SAMPLE_USER_HEADER = "x-otodoke-sample-user";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  const wrap = (builder: object): object => new Proxy(builder, {
    get(chain, property) {
      if (property === "then") {
        return (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => {
          const setHeader = Reflect.get(chain, "setHeader");
          if (typeof setHeader !== "function") throw new Error("sample database builder cannot set request headers");
          const headed = setHeader.call(chain, SAMPLE_USER_HEADER, userId);
          headed.setHeader(SAMPLE_GENERATION_HEADER, generation);
          return Reflect.get(headed, "then").call(headed, resolve, reject);
        };
      }
      const value = Reflect.get(chain, property);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => wrap(value.apply(chain, args));
    },
  });
  return new Proxy(db, {
    get(target, property) {
      if (property === "from" || property === "rpc") return (...args: unknown[]) => wrap(Reflect.apply(Reflect.get(target, property), target, args));
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
