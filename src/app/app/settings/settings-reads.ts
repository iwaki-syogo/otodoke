import type { createClient } from "@/lib/supabase/server";
import { forwardingConfirmUrl } from "@/lib/forwarding";
import { SAMPLE_PROVIDER_ID } from "@/lib/mail-keys";
import { UNREAD_FILTER } from "@/lib/unread";

/**
 * The reads the 設定 pages share. Plain functions (not a "use server" file), each told apart on
 * failure by null / a flag, never by an empty value: a read that failed must not look like
 * "nothing to do". The database's own message stays in the server log.
 */
type Supabase = Awaited<ReturnType<typeof createClient>>;

/** The key in use. `failed` is true when it could not be read: not knowing is not "no key". */
export async function readActiveKey(supabase: Supabase, where: string) {
  const { data, error } = await supabase
    .from("user_keys")
    .select("key_id, created_at")
    .not("activated_at", "is", null)
    .is("retired_at", null)
    .maybeSingle();
  if (error) console.error(`${where} (key):`, error.message);
  return { key: data ?? null, failed: Boolean(error) };
}

/** How many mails are still unread; null when the count could not be read. */
export async function readUnreadCount(supabase: Supabase, where: string): Promise<number | null> {
  const { count, error } = await supabase.from("emails").select("id", { count: "exact", head: true }).or(UNREAD_FILTER());
  if (error || count === null) {
    console.error(`${where} (unread count):`, error?.message ?? "no count");
    return null;
  }
  return count;
}

/** How many confirmation mails are looked through: a forged one without Google's link must not hide the real one. */
const CONFIRMATION_LOOKBACK = 10;

/**
 * Gmail's approval link: from the newest forwarding confirmation (by created_at, the clock the
 * after-check uses) whose link is Google's own. Anyone who knows the inbound address can send a
 * look-alike confirmation without a valid link, so the newest mail alone is not enough: the last
 * few are looked through. `at` is that mail's created_at. `failed` when it could not be read.
 */
export async function readConfirmUrl(supabase: Supabase, where: string): Promise<{ url: string | null; failed: boolean; at: string | null }> {
  const { data, error } = await supabase
    .from("emails")
    .select("forwarding_confirm_url, text_body, html_body, created_at")
    .eq("classification", "forwarding_confirmation")
    // created_at is always set; nulls last anyway, so a row without it can never win.
    .order("created_at", { ascending: false, nullsFirst: false })
    .limit(CONFIRMATION_LOOKBACK);
  if (error) {
    console.error(`${where} (confirmation):`, error.message);
    return { url: null, failed: true, at: null };
  }
  // Checked again when shown: only Google's own page is ever linked.
  for (const row of data ?? []) {
    const url = forwardingConfirmUrl(row.forwarding_confirm_url ?? "") ?? forwardingConfirmUrl(row.text_body ?? row.html_body ?? "");
    if (url) return { url, failed: false, at: (row.created_at as string | null) ?? null };
  }
  return { url: null, failed: false, at: null };
}

/** How many mails were dropped, counted by the database (no rows are read); null when it failed. */
export async function readDroppedCount(supabase: Supabase, where: string): Promise<number | null> {
  const { count, error } = await supabase.from("screen_events").select("id", { count: "exact", head: true }).eq("decision", "dropped");
  if (error || count === null) {
    console.error(`${where} (dropped count):`, error?.message ?? "no count");
    return null;
  }
  return count;
}

/**
 * What has come in so far (the empty parcel list's rule):
 * - "approval": the newest valid Gmail confirmation exists and nothing else (no ordinary mail, no
 *   screen_events row) arrived after it. If the after-check cannot be read, still "approval":
 *   the card says an approval already done can be ignored, so showing it is the safe side.
 * - "received": something arrived after the confirmation, or there is no usable confirmation but
 *   other mail (a stored mail or one the screen dropped; screen_events keeps those 14 days).
 * - "none": nothing. The public samples never count (no sample is a Gmail confirmation).
 */
export type MailSoFar = "none" | "approval" | "received";

type Head = { count: number | null; error: { message: string } | null };

/**
 * How many ordinary mails (not samples, not confirmations) and screen_events rows arrived after
 * `at`; null when any of the reads failed.
 */
async function countArrivedAfter(supabase: Supabase, userId: string, where: string, at: string): Promise<number | null> {
  const head = { count: "exact", head: true } as const;
  const [all, samples, confirmations, screened] = await Promise.all([
    supabase.from("emails").select("id", head).eq("user_id", userId).gt("created_at", at),
    supabase.from("emails").select("id", head).eq("user_id", userId).gt("created_at", at).like("provider_email_id", SAMPLE_PROVIDER_ID),
    supabase.from("emails").select("id", head).eq("user_id", userId).gt("created_at", at).eq("classification", "forwarding_confirmation"),
    supabase.from("screen_events").select("id", head).eq("user_id", userId).gt("created_at", at),
  ]);
  for (const [what, r] of [["emails", all], ["samples", samples], ["confirmations", confirmations], ["screen_events", screened]] as Array<[string, Head]>) {
    if (r.error || r.count === null) {
      console.error(`${where} (after confirmation, ${what}):`, r.error?.message ?? "no count");
      return null;
    }
  }
  return (all.count ?? 0) - (samples.count ?? 0) - (confirmations.count ?? 0) + (screened.count ?? 0);
}

/** `where` names the page in the server log; null when the confirmation or the plain counts failed (the caller decides what that means). */
export async function readMailSoFar(supabase: Supabase, userId: string, where: string): Promise<MailSoFar | null> {
  const confirmation = await readConfirmUrl(supabase, where);
  if (confirmation.failed) return null;
  if (confirmation.url && confirmation.at) {
    const later = await countArrivedAfter(supabase, userId, where, confirmation.at);
    return later === null || later <= 0 ? "approval" : "received";
  }
  const head = { count: "exact", head: true } as const;
  const [all, samples, confirmations, screened] = await Promise.all([
    supabase.from("emails").select("id", head).eq("user_id", userId),
    supabase.from("emails").select("id", head).eq("user_id", userId).like("provider_email_id", SAMPLE_PROVIDER_ID),
    supabase.from("emails").select("id", head).eq("user_id", userId).eq("classification", "forwarding_confirmation"),
    supabase.from("screen_events").select("id", head).eq("user_id", userId),
  ]);
  for (const [what, r] of [["emails", all], ["samples", samples], ["confirmations", confirmations], ["screen_events", screened]] as Array<[string, Head]>) {
    if (r.error) {
      console.error(`${where} (${what}):`, r.error.message);
      return null;
    }
  }
  const forwarded = (all.count ?? 0) - (samples.count ?? 0) - (confirmations.count ?? 0);
  if (forwarded > 0 || (screened.count ?? 0) > 0) return "received";
  return (confirmations.count ?? 0) > 0 ? "approval" : "none";
}

/**
 * The 「承認待ち」 badge on the settings list (the cards on the forwarding page and /app/welcome
 * do not use this: they show whenever a confirmation with Google's link exists). Waiting means the
 * newest confirmation exists and nothing arrived after it (same rule as the empty list's
 * "approval"). `failed` when the confirmation or any supporting read failed.
 */
export async function readApprovalBadge(supabase: Supabase, userId: string, where: string): Promise<{ waiting: boolean; failed: boolean }> {
  const confirmation = await readConfirmUrl(supabase, where);
  if (confirmation.failed) return { waiting: false, failed: true };
  if (!confirmation.url || !confirmation.at) return { waiting: false, failed: false };
  const later = await countArrivedAfter(supabase, userId, where, confirmation.at);
  if (later === null) return { waiting: false, failed: true };
  return { waiting: later <= 0, failed: false };
}
