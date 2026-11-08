import { after } from "next/server";
import { sealRemainingPlain } from "@/lib/mail-keys";
import { createAdminClient, type AdminClient } from "@/lib/supabase/admin";

/**
 * Seal the user's remaining plaintext mail after the response has gone out (bounded, see
 * sealRemainingPlain). It never blocks and never fails the caller: outside a request, where
 * `after` is not available, or on any error, it does nothing. `db` is made inside the callback
 * when not given, so a page that only schedules does not build the service-role client up front.
 */
export function scheduleSealRemaining(userId: string, db?: AdminClient): void {
  try {
    after(async () => {
      try {
        await sealRemainingPlain(db ?? createAdminClient(), userId);
      } catch (err) {
        console.error("seal: scheduled run failed:", err instanceof Error ? err.message : "unknown error");
      }
    });
  } catch (err) {
    console.error("seal: could not schedule:", err instanceof Error ? err.message : "unknown error");
  }
}
