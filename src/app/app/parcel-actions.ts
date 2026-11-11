"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { todayJst } from "@/lib/format";
import { isReceivedAt, needsCheck } from "@/lib/match";
import { createClient } from "@/lib/supabase/server";
import { undeliveredStatus } from "@/lib/undelivered";

/** Statuses a parcel may be put back to after it was marked as received by hand (delivered: back to 配達済み). */
const RESTORABLE = ["ordered", "shipped", "out_for_delivery", "attempted", "unknown", "delivered"];
const MAX_AT_ONCE = 500;

/** A timestamp the client sends back for an undo: an instant, or null for "not received". */
const PreviousReceivedAt = z.union([z.null(), z.iso.datetime({ offset: true })]);
/** The received_at the press being undone wrote: the undo only touches a row that still has exactly it. */
const WrittenAt = z.iso.datetime({ offset: true });

/** The user's own session, and their id for a condition on top of row-level security. */
async function signedIn() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user ? { supabase, userId: user.id } : null;
}

/**
 * The user says they received these parcels (受け取った). Runs with the user's own session, so
 * row-level security limits it to their parcels. Writes status and received_at together (the
 * database trigger would fill received_at too, but this does not rely on it). A parcel that is
 * already received is not written again (its received_at stays) and counts as saved. Answers how
 * many parcels are received now.
 */
export async function markDelivered(ids: string[]): Promise<number> {
  return (await deliver(ids)).saved;
}

/**
 * Like markDelivered, and says which parcels this call wrote (with the received_at it wrote). 元に戻す
 * is offered for those only: a parcel that was already received was not changed, so there is nothing
 * of this press to take back.
 */
export async function markDeliveredForUndo(ids: string[]): Promise<{ saved: number; written: { id: string; received_at: string }[] }> {
  return await deliver(ids);
}

async function deliver(ids: string[]): Promise<{ saved: number; written: { id: string; received_at: string }[] }> {
  const none = { saved: 0, written: [] };
  const clean = ids.filter((id) => typeof id === "string" && id.length > 0).slice(0, MAX_AT_ONCE);
  if (clean.length === 0) return none;
  const session = await signedIn();
  if (!session) return none;
  const at = new Date().toISOString();
  const { data, error } = await session.supabase
    .from("parcels")
    .update({ status: "delivered", received_at: at })
    .in("id", clean)
    .eq("user_id", session.userId)
    .neq("status", "cancelled")
    // Only a parcel not received yet is written: pressing again after a lost answer keeps the first time.
    .is("received_at", null)
    .select("id");
  if (error) throw new Error(error.message);
  const written = new Set(data.map((row) => row.id));
  // A parcel left alone because it is already received counts as saved; a cancelled one does not.
  const rest = clean.filter((id) => !written.has(id));
  let already = 0;
  if (rest.length > 0) {
    const { data: rows, error: readError } = await session.supabase
      .from("parcels")
      .select("id,status,received_at")
      .in("id", rest)
      .eq("user_id", session.userId);
    if (readError) throw new Error(readError.message);
    already = new Set(rows.filter((row) => row.status === "delivered" && row.received_at !== null).map((row) => row.id)).size;
  }
  revalidatePath("/app", "layout");
  return { saved: written.size + already, written: [...written].map((id) => ({ id, received_at: at })) };
}

/** leftReceived: at least one parcel asked for was not put back (it changed since, or was refused). */
type RestoreResult = { leftReceived: boolean };

/**
 * Undo: puts parcels marked by hand back to the status and received_at each had before (the
 * received_at is null for a parcel that was not received before). Only a parcel that is still as
 * the mark left it (delivered, with the received_at that mark wrote) goes back: one the person
 * changed or received again since stays.
 */
export async function restoreStatuses(items: { id: string; status: string; received_at?: string | null; written_at: string }[]): Promise<RestoreResult> {
  const asked = new Set(items.slice(0, MAX_AT_ONCE).map((it) => it.id).filter((id) => typeof id === "string"));
  let restored = 0;
  const clean: { id: string; status: string; received_at: string | null; written_at: string }[] = [];
  for (const it of items.slice(0, MAX_AT_ONCE)) {
    const previous = PreviousReceivedAt.safeParse(it.received_at ?? null);
    const written = WrittenAt.safeParse(it.written_at);
    if (typeof it.id !== "string" || !RESTORABLE.includes(it.status) || !previous.success || !written.success) continue;
    // Back to not-received only makes sense as delivered; a received_at on any other status is refused.
    if (previous.data !== null && it.status !== "delivered") continue;
    clean.push({ id: it.id, status: it.status, received_at: previous.data, written_at: written.data });
  }
  if (clean.length === 0) return { leftReceived: asked.size > 0 };
  const session = await signedIn();
  if (!session) return { leftReceived: true };
  const groups = new Map<string, { status: string; received_at: string | null; written_at: string; ids: string[] }>();
  for (const it of clean) {
    const key = `${it.status}|${it.received_at ?? ""}|${it.written_at}`;
    const group = groups.get(key) ?? { status: it.status, received_at: it.received_at, written_at: it.written_at, ids: [] };
    group.ids.push(it.id);
    groups.set(key, group);
  }
  for (const { status, received_at, written_at, ids } of groups.values()) {
    const { data, error } = await session.supabase
      .from("parcels")
      .update({ status, received_at })
      .in("id", ids)
      .eq("user_id", session.userId)
      .eq("status", "delivered")
      // Exactly what the press being undone wrote: a later receive of the same parcel is not taken back.
      .eq("received_at", written_at)
      .select("id");
    if (error) throw new Error(error.message);
    restored += new Set(data.map((row) => row.id)).size;
  }
  revalidatePath("/app", "layout");
  return { leftReceived: restored < asked.size };
}

const NOT_UPDATED = "更新できませんでした。開き直してください";

/**
 * The user says a parcel marked as delivered has not arrived (届いていない). Where it goes back to is
 * decided from the row read here, never from the client; received_at is cleared with it. The update
 * changes it only if it is still the row that was read (same updated_at): if a mail saved the
 * delivery in between, nothing is written and nothing is retried.
 */
export async function markNotDelivered(id: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const parsed = z.uuid().safeParse(id);
  if (!parsed.success) return { ok: false, error: NOT_UPDATED };
  const session = await signedIn();
  if (!session) return { ok: false, error: NOT_UPDATED };

  const { data: row, error: readError } = await session.supabase
    .from("parcels")
    .select("tracking_number,carrier,status,updated_at")
    .eq("id", parsed.data)
    .eq("user_id", session.userId)
    .maybeSingle();
  if (readError) {
    console.error("markNotDelivered:", readError.message);
    return { ok: false, error: NOT_UPDATED };
  }
  if (!row || row.status !== "delivered") return { ok: false, error: NOT_UPDATED };

  const { data, error } = await session.supabase
    .from("parcels")
    .update({ status: undeliveredStatus(row), received_at: null })
    .eq("id", parsed.data)
    .eq("user_id", session.userId)
    .eq("status", "delivered")
    .eq("updated_at", row.updated_at)
    .select("id");
  if (error) {
    console.error("markNotDelivered:", error.message);
    return { ok: false, error: NOT_UPDATED };
  }
  if (!data || data.length !== 1) return { ok: false, error: NOT_UPDATED };
  revalidatePath("/app", "layout");
  return { ok: true };
}

/**
 * The user says a parcel marked as received has not been received (受け取っていない): it goes back to
 * 配達済み, still delivered, with received_at cleared. When the parcel is 14 days or more past its
 * delivery, check_dismissed_at is set in the same write: the person has just answered, so 要確認 must not
 * ask at once (a parcel received long ago, moved to received by the migration, would come straight back
 * otherwise). A parcel answered earlier is not marked, and is asked once on day 14. Only a delivered parcel that has received_at
 * goes back, and only if it is still the row that was read (same updated_at); otherwise nothing is
 * written and nothing is retried.
 */
export async function markNotReceived(id: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const parsed = z.uuid().safeParse(id);
  if (!parsed.success) return { ok: false, error: NOT_UPDATED };
  const session = await signedIn();
  if (!session) return { ok: false, error: NOT_UPDATED };

  const { data: row, error: readError } = await session.supabase
    .from("parcels")
    .select("status,received_at,updated_at,expected_date,expected_date_end,last_email_at")
    .eq("id", parsed.data)
    .eq("user_id", session.userId)
    .maybeSingle();
  if (readError) {
    console.error("markNotReceived:", readError.message);
    return { ok: false, error: NOT_UPDATED };
  }
  if (!row || row.status !== "delivered" || !isReceivedAt(row.received_at)) return { ok: false, error: NOT_UPDATED };
  // 「まだ」 is recorded only when 要確認 would ask at once (14 days or more since the delivery). Answered
  // earlier, the parcel is asked once, on day 14.
  const askedAtOnce = needsCheck({ status: "delivered", expected_date: row.expected_date, expected_date_end: row.expected_date_end, last_email_at: row.last_email_at, received_at: null, check_dismissed_at: null }, todayJst());

  const { data, error } = await session.supabase
    .from("parcels")
    .update(askedAtOnce ? { received_at: null, check_dismissed_at: new Date().toISOString() } : { received_at: null })
    .eq("id", parsed.data)
    .eq("user_id", session.userId)
    .eq("status", "delivered")
    .eq("updated_at", row.updated_at)
    .select("id");
  if (error) {
    console.error("markNotReceived:", error.message);
    return { ok: false, error: NOT_UPDATED };
  }
  if (!data || data.length !== 1) return { ok: false, error: NOT_UPDATED };
  revalidatePath("/app", "layout");
  return { ok: true };
}

/**
 * 「まだ」 on a delivered parcel 要確認 asks about: the parcel leaves 要確認 and stays under 配達済み, and is
 * not asked about again (check_dismissed_at). Only a delivered parcel not received yet; the update holds
 * only while the row is as read (same updated_at), otherwise nothing is written and nothing is retried.
 */
export async function dismissCheck(id: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const parsed = z.uuid().safeParse(id);
  if (!parsed.success) return { ok: false, error: NOT_UPDATED };
  const session = await signedIn();
  if (!session) return { ok: false, error: NOT_UPDATED };

  const { data: row, error: readError } = await session.supabase
    .from("parcels")
    .select("status,received_at,updated_at")
    .eq("id", parsed.data)
    .eq("user_id", session.userId)
    .maybeSingle();
  if (readError) {
    console.error("dismissCheck:", readError.message);
    return { ok: false, error: NOT_UPDATED };
  }
  if (!row || row.status !== "delivered" || row.received_at !== null) return { ok: false, error: NOT_UPDATED };

  const { data, error } = await session.supabase
    .from("parcels")
    .update({ check_dismissed_at: new Date().toISOString() })
    .eq("id", parsed.data)
    .eq("user_id", session.userId)
    .eq("status", "delivered")
    .eq("updated_at", row.updated_at)
    .select("id");
  if (error) {
    console.error("dismissCheck:", error.message);
    return { ok: false, error: NOT_UPDATED };
  }
  if (!data || data.length !== 1) return { ok: false, error: NOT_UPDATED };
  revalidatePath("/app", "layout");
  return { ok: true };
}
