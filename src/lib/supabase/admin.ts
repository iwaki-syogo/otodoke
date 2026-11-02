import { createClient as createSupabaseClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/db/database.types";
import { env, requireEnv } from "@/lib/env";

export type AdminClient = SupabaseClient<Database>;

/**
 * Service-role client. Bypasses RLS, so it is used only by server code that has
 * already decided which user a row belongs to (the inbound webhook, the demo loader).
 * Never import this from client components.
 */
export function createAdminClient(): AdminClient {
  return createSupabaseClient<Database>(env().NEXT_PUBLIC_SUPABASE_URL, requireEnv("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
