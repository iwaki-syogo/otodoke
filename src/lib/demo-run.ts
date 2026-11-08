import { demoInput, loadDemoEntries } from "@/lib/demo";
import { MailBeingReadError, processInboundEmail } from "@/lib/pipeline";
import type { AdminClient } from "@/lib/supabase/admin";

/**
 * The sample load and the reset, as plain functions: shared by the web's Server Actions
 * (src/app/app/settings/actions.ts, which add the redirects) and the iOS app's endpoints
 * (src/app/api/demo/**, which add the JSON answer). Neither redirects nor revalidates here.
 */

export type LoadDemoResult = { ok: true; processed: number; busy: boolean } | { ok: false; processed: number; message: string; name: string };

/**
 * Feed the anonymized demo mails through the real pipeline for `userId`.
 * Uses precomputed Claude results, so this never calls the API.
 * The client is made inside, so a failure to make it is a failed load (as it was in the action).
 */
export async function runLoadDemo(getDb: () => AdminClient, userId: string): Promise<LoadDemoResult> {
  let processed = 0;
  let otherIsLoading = false;
  try {
    const db = getDb();
    for (const entry of await loadDemoEntries()) {
      let outcome;
      try {
        const input = demoInput(entry, userId);
        outcome = await processInboundEmail(db, input.mail, input.options);
      } catch (err) {
        // A second judge on the shared account is loading this same mail right now. Stop here and
        // leave the rest to them: going on would put the two loads on every other mail in turn
        // (the one behind passes the mails the other has finished and catches up), and two loads
        // filing neighbouring mails of one order at once can make two parcels. The other load
        // finishes the sample. Any other error still stops the load as a failure.
        if (err instanceof MailBeingReadError) {
          otherIsLoading = true;
          break;
        }
        throw err;
      }
      if (outcome.kind === "processed" || outcome.kind === "noted" || outcome.kind === "duplicate") processed++;
    }
  } catch (err) {
    return { ok: false, processed, message: err instanceof Error ? err.message : String(err), name: err instanceof Error ? err.name : typeof err };
  }
  return { ok: true, processed, busy: otherIsLoading };
}

/** Remove everything `userId` has (used to reset a demo account). Null on success, else the message. */
export async function runClearAllParcels(db: AdminClient, userId: string): Promise<string | null> {
  // extractions and parcel_items cascade from parcels / emails.
  const { error: e1 } = await db.from("parcels").delete().eq("user_id", userId);
  const { error: e2 } = await db.from("emails").delete().eq("user_id", userId);
  return e1?.message ?? e2?.message ?? null;
}
