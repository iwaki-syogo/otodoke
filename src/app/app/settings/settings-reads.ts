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

/** Gmail's approval link from the newest forwarding confirmation; `failed` when it could not be read. */
export async function readConfirmUrl(supabase: Supabase, where: string): Promise<{ url: string | null; failed: boolean }> {
  const { data, error } = await supabase
    .from("emails")
    .select("forwarding_confirm_url, text_body, html_body, sent_at")
    .eq("classification", "forwarding_confirmation")
    .order("sent_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    console.error(`${where} (confirmation):`, error.message);
    return { url: null, failed: true };
  }
  // Checked again when shown: only Google's own page is ever linked.
  const url = data ? (forwardingConfirmUrl(data.forwarding_confirm_url ?? "") ?? forwardingConfirmUrl(data.text_body ?? data.html_body ?? "")) : null;
  return { url, failed: false };
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
 * What has come in so far (the empty parcel list and the approval cards share this one rule):
 * - "received": forwarded mail of the person's own, a stored mail or one the screen dropped
 *   (screen_events keeps those 14 days).
 * - "approval": only Gmail's forwarding confirmation. Gmail forwards nothing until it is approved.
 * - "none": nothing. The public samples never count (no sample is a Gmail confirmation).
 */
export type MailSoFar = "none" | "approval" | "received";

/** `where` names the page in the server log; null when any of the reads failed (the caller decides what that means). */
export async function readMailSoFar(supabase: Supabase, userId: string, where: string): Promise<MailSoFar | null> {
  const head = { count: "exact", head: true } as const;
  const [all, samples, confirmations, screened] = await Promise.all([
    supabase.from("emails").select("id", head).eq("user_id", userId),
    supabase.from("emails").select("id", head).eq("user_id", userId).like("provider_email_id", SAMPLE_PROVIDER_ID),
    supabase.from("emails").select("id", head).eq("user_id", userId).eq("classification", "forwarding_confirmation"),
    supabase.from("screen_events").select("id", head).eq("user_id", userId),
  ]);
  for (const [what, r] of [["emails", all], ["samples", samples], ["confirmations", confirmations], ["screen_events", screened]] as const) {
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
 * Gmail's approval link, only while it is still to be done: once other mail has come in (the same
 * rule as the empty parcel list's "received"), Gmail is forwarding and the link is not offered.
 * `failed` when the link or that rule could not be read: neither "waiting" nor "done".
 */
export async function readPendingApproval(supabase: Supabase, userId: string, where: string): Promise<{ url: string | null; failed: boolean }> {
  const confirmation = await readConfirmUrl(supabase, where);
  if (confirmation.failed || !confirmation.url) return confirmation;
  const mail = await readMailSoFar(supabase, userId, where);
  if (mail === null) return { url: null, failed: true };
  return mail === "received" ? { url: null, failed: false } : confirmation;
}
