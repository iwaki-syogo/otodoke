import type { createClient } from "@/lib/supabase/server";
import { forwardingConfirmUrl } from "@/lib/forwarding";
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
