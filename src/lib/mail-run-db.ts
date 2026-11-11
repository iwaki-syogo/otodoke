import type { AdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/lib/db/database.types";

type Filter = { method: string; args: unknown[] };
const OWNED_TABLES = new Set(["emails", "extractions", "parcels", "parcel_items"]);

/**
 * Keep the existing filing queries, but execute mutations through a service-only
 * transaction that locks the mail and checks its current run and lease. Reads use
 * the normal client. A lease check followed by an ordinary write would race takeover.
 */
export function withMailRun(db: AdminClient, emailId: string, runId: string): AdminClient {
  return new Proxy(db, {
    get(target, property) {
      if (property === "rpc") {
        return (name: string, args: Json) => {
          if (name === "create_mail_parcel" || name === "update_mail_parcel" || name === "ensure_mail_parcel_items") {
            return Reflect.apply(Reflect.get(target, property), target, [name, { ...(args as object), p_email_id: emailId, p_run_id: runId }]);
          }
          if (name === "claim_claude_call" || name === "claim_claude_call_v2") {
            return db.rpc("mail_run_write", {
              p_email_id: emailId, p_run_id: runId, p_table: name,
              p_operation: "claim", p_values: args, p_filters: [],
            });
          }
          return Reflect.apply(Reflect.get(target, property), target, [name, args]);
        };
      }
      if (property !== "from") {
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      }
      return (table: string) => {
        const query = Reflect.apply(Reflect.get(target, "from"), target, [table]);
        if (!OWNED_TABLES.has(table)) return query;
        let operation: string | null = null;
        let values: Json = null;
        let returning = false;
        let singular: string | null = null;
        const filters: Filter[] = [];
        const wrap = (builder: object): object => new Proxy(builder, {
          get(chain, method) {
            if (method === "then" && operation) {
              return (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => db.rpc("mail_run_write", {
                p_email_id: emailId, p_run_id: runId, p_table: table, p_operation: operation!,
                p_values: values, p_filters: filters as unknown as Json,
              }).then(({ data, error }) => {
                if (error) return { data: null, error };
                if (!Array.isArray(data)) return { data: null, error: { message: "mail_run_write returned no rows", code: "XX000" } };
                if ((singular === "single" && data.length !== 1) || (singular === "maybeSingle" && data.length > 1)) return { data: null, error: { message: "expected one owned row", code: "PGRST116" } };
                return { data: returning ? singular ? data[0] ?? null : data : null, error: null };
              }).then(resolve, reject);
            }
            const fn = Reflect.get(chain, method);
            if (typeof fn !== "function") return fn;
            return (...args: unknown[]) => {
              if (["insert", "update", "delete"].includes(String(method))) {
                operation = String(method);
                values = (args[0] ?? null) as Json;
              } else if (method === "select" && operation) returning = true;
              else if (method === "single" || method === "maybeSingle") singular = String(method);
              else if (operation && ["eq", "in", "or"].includes(String(method))) filters.push({ method: String(method), args });
              return wrap(fn.apply(chain, args));
            };
          },
        });
        return wrap(query);
      };
    },
  });
}
