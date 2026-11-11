import { demoInput, loadDemoEntries } from "@/lib/demo";
import { SAMPLE_PROVIDER_ID } from "@/lib/mail-keys";
import { MailBeingReadError, processInboundEmail } from "@/lib/pipeline";
import { readAll } from "@/lib/supabase/read-all";
import type { AdminClient } from "@/lib/supabase/admin";

/**
 * The sample load and the reset, as plain functions: shared by the web's Server Actions
 * (src/app/app/settings/actions.ts, which add the redirects) and the iOS app's endpoints
 * (src/app/api/demo/**, which add the JSON answer). Neither redirects nor revalidates here.
 */

export type LoadDemoResult = { ok: true; processed: number; busy: boolean } | { ok: false; processed: number; message: string; name: string };

const MARK_CHUNK = 100;

/**
 * The sample's delivered parcels count as received. The mail processing only ever says 配達済み (a
 * mail said it came; the person's word is theirs), so without this the made-up year of deliveries
 * would sit in 配達済み and, after two weeks, in 要確認. Only parcels that sample mails belong to
 * are touched: a real parcel of the same account is left as it is.
 */
async function receiveSampleParcels(db: AdminClient, userId: string): Promise<void> {
  const sampleMails = await readAll<{ id: string }>(() =>
    db.from("emails").select("id", { count: "exact" }).eq("user_id", userId).like("provider_email_id", SAMPLE_PROVIDER_ID),
  );
  if (sampleMails.length === 0) return;
  const sampleIds = new Set(sampleMails.map((m) => m.id));
  const links = await readAll<{ email_id: string; parcel_id: string | null }>(() =>
    db.from("extractions").select("email_id, parcel_id", { count: "exact" }).eq("user_id", userId),
  );
  const parcelIds = [...new Set(links.filter((l) => sampleIds.has(l.email_id) && l.parcel_id !== null).map((l) => l.parcel_id as string))];
  const at = new Date().toISOString();
  for (let i = 0; i < parcelIds.length; i += MARK_CHUNK) {
    const { error } = await db
      .from("parcels")
      .update({ received_at: at })
      .in("id", parcelIds.slice(i, i + MARK_CHUNK))
      .eq("user_id", userId)
      .eq("status", "delivered")
      .is("received_at", null);
    if (error) throw new Error(`sample parcels: ${error.message}`);
  }
}

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
    await receiveSampleParcels(db, userId);
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
