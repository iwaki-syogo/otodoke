import { demoInput, loadDemoEntries, type DemoEntry } from "@/lib/demo";
import { sampleFileOf } from "@/lib/mail-keys";
import { ClaudeUnavailableError } from "@/lib/extract/claude-error";
import { MailBeingReadError, processInboundEmail } from "@/lib/pipeline";
import { isRememberableDomain, personalMailReason } from "@/lib/screen-senders";
import type { AdminClient } from "@/lib/supabase/admin";
import { UNREAD_FILTER } from "@/lib/unread";

/**
 * "This dropped mail was a parcel" and "read the mail that is waiting", as plain functions: shared
 * by the web's Server Actions (src/app/app/settings/actions.ts, which add the redirects and the
 * revalidation) and the iOS app's endpoints (src/app/api/mail/**, which add the JSON answer).
 * Neither redirects nor revalidates here.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isScreenEventId(id: string): boolean {
  return UUID.test(id);
}

export type MarkParcelOutcome = "remembered" | "shared" | "forwarded" | "own";

/**
 * not_found: no such dropped mail of this user (or the id is not a UUID).
 * lookup_failed / mark_failed: the database said no; `message` is for the server log only.
 */
export type MarkParcelResult =
  | { ok: true; outcome: MarkParcelOutcome }
  | { ok: false; code: "not_found" }
  | { ok: false; code: "lookup_failed" | "mark_failed"; message: string };

export async function runMarkWronglyDropped(db: AdminClient, userId: string, userEmail: string | null | undefined, id: string): Promise<MarkParcelResult> {
  if (!isScreenEventId(id)) return { ok: false, code: "not_found" };
  const { data: row, error: readError } = await db.from("screen_events").select("from_domain, subject").eq("id", id).eq("user_id", userId).eq("decision", "dropped").maybeSingle();
  if (readError) return { ok: false, code: "lookup_failed", message: readError.message };
  if (!row) return { ok: false, code: "not_found" };
  // Told by why: a forwarded copy may come from the family, not from the person.
  const personal = personalMailReason(row, userEmail);
  if (personal) return { ok: true, outcome: personal };
  if (!isRememberableDomain(row.from_domain)) return { ok: true, outcome: "shared" };
  const { error } = await db.from("screen_events").update({ flagged_at: new Date().toISOString() }).eq("id", id).eq("user_id", userId);
  if (error) return { ok: false, code: "mark_failed", message: error.message };
  return { ok: true, outcome: "remembered" };
}

export type ReadWaitingResult =
  // unavailable: Claude cannot be used (stopped, not just failing); the loop stopped at that mail.
  | { ok: true; read: number; overLimit: boolean; unavailable: boolean }
  // onlyBusy: every failure was another read taking the same mail (MailBeingReadError), none was a real one.
  | { ok: false; stage: "lookup" | "read"; message: string; read: number; overLimit: boolean; unavailable: boolean; onlyBusy: boolean };

/** Read up to 20 waiting mails; stops when today's allowance runs out. `read` counts the mails processed (every outcome but over_limit). */
export async function runReadWaitingMail(db: AdminClient, userId: string): Promise<ReadWaitingResult> {
  const { data, error } = await db
    .from("emails")
    .select("id, provider_email_id, message_id, from_address, from_name, subject, sent_at, text_body, html_body")
    .eq("user_id", userId)
    .eq("body_state", "plain")
    .or(UNREAD_FILTER())
    .order("sent_at", { ascending: true })
    .limit(20);
  if (error) return { ok: false, stage: "lookup", message: error.message, read: 0, overLimit: false, unavailable: false, onlyBusy: false };

  let failure: string | null = null;
  let realFailure = false;
  let read = 0;
  let overLimit = false;
  let unavailable = false;
  // A sample mail left pending by an interrupted loadDemo is read the way loadDemo reads it
  // (precomputed, never Claude); the entries are loaded once, only if one is waiting.
  let samples: Map<string, DemoEntry> | null = null;
  for (const m of data) {
    try {
      const file = sampleFileOf(m.provider_email_id);
      let outcome;
      if (file !== null) {
        samples ??= new Map((await loadDemoEntries()).map((e) => [e.mail.file, e]));
        const entry = samples.get(file);
        // No sample of that name any more: unreadable, and never a reason to call Claude.
        if (!entry) throw new Error(`sample mail ${file} not found`);
        const input = demoInput(entry, userId);
        outcome = await processInboundEmail(db, input.mail, { ...input.options, replacesEmailId: m.id });
      } else {
        outcome = await processInboundEmail(
          db,
          {
            userId,
            providerEmailId: m.provider_email_id,
            messageId: m.message_id,
            from: m.from_address ?? "",
            fromName: m.from_name,
            subject: m.subject ?? "",
            sentAt: m.sent_at,
            text: m.text_body,
            html: m.html_body,
          },
          // Without a Message-ID the pipeline cannot find this row again, so it is named: the mail is
          // read again in this row, in place (never removed and stored anew, so it cannot be lost).
          m.message_id ? {} : { replacesEmailId: m.id },
        );
      }
      if (outcome.kind === "over_limit") {
        overLimit = true;
        break;
      }
      read++;
    } catch (err) {
      // Claude is stopped: every next mail would fail the same way, so stop here (the mail is kept).
      if (err instanceof ClaudeUnavailableError) {
        unavailable = true;
        break;
      }
      // One unreadable mail must not hold back the ones after it.
      failure = err instanceof Error ? err.message : String(err);
      if (!(err instanceof MailBeingReadError)) realFailure = true;
    }
  }
  if (failure) return { ok: false, stage: "read", message: failure, read, overLimit, unavailable, onlyBusy: !realFailure };
  return { ok: true, read, overLimit, unavailable };
}
