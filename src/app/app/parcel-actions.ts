"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { undeliveredStatus } from "@/lib/undelivered";

/** Statuses a parcel may be put back to after it was marked as received by hand (delivered: back to 配達済み). */
const RESTORABLE = ["ordered", "shipped", "out_for_delivery", "attempted", "unknown", "delivered"];
const MAX_AT_ONCE = 500;

/** A timestamp the client sends back for an undo: an instant, or null for "not received". */
const PreviousReceivedAt = z.union([z.null(), z.iso.datetime({ offset: true })]);

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
 * database trigger would fill received_at too, but this does not rely on it). Answers how many
 * rows changed.
 */
export async function markDelivered(ids: string[]): Promise<number> {
  const clean = ids.filter((id) => typeof id === "string" && id.length > 0).slice(0, MAX_AT_ONCE);
  if (clean.length === 0) return 0;
  const session = await signedIn();
  if (!session) return 0;
  const { data, error } = await session.supabase
    .from("parcels")
    .update({ status: "delivered", received_at: new Date().toISOString() })
    .in("id", clean)
    .eq("user_id", session.userId)
    .neq("status", "cancelled")
    .select("id");
  if (error) throw new Error(error.message);
  revalidatePath("/app", "layout");
  return data.length;
}

/**
 * Undo: puts parcels marked by hand back to the status and received_at each had before (the
 * received_at is null for a parcel that was not received before). Only a parcel that is still as
 * the mark left it (delivered and received) goes back: one the person changed since stays.
 */
export async function restoreStatuses(items: { id: string; status: string; received_at?: string | null }[]): Promise<void> {
  const clean: { id: string; status: string; received_at: string | null }[] = [];
  for (const it of items.slice(0, MAX_AT_ONCE)) {
    const previous = PreviousReceivedAt.safeParse(it.received_at ?? null);
    if (typeof it.id !== "string" || !RESTORABLE.includes(it.status) || !previous.success) continue;
    // Back to not-received only makes sense as delivered; a received_at on any other status is refused.
    if (previous.data !== null && it.status !== "delivered") continue;
    clean.push({ id: it.id, status: it.status, received_at: previous.data });
  }
  if (clean.length === 0) return;
  const session = await signedIn();
  if (!session) return;
  const groups = new Map<string, { status: string; received_at: string | null; ids: string[] }>();
  for (const it of clean) {
    const key = `${it.status}|${it.received_at ?? ""}`;
    const group = groups.get(key) ?? { status: it.status, received_at: it.received_at, ids: [] };
    group.ids.push(it.id);
    groups.set(key, group);
  }
  for (const { status, received_at, ids } of groups.values()) {
    const { error } = await session.supabase
      .from("parcels")
      .update({ status, received_at })
      .in("id", ids)
      .eq("user_id", session.userId)
      .eq("status", "delivered")
      .not("received_at", "is", null);
    if (error) throw new Error(error.message);
  }
  revalidatePath("/app", "layout");
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
 * 配達済み, still delivered, with received_at cleared. check_dismissed_at is set in the same write: the
 * person has just answered, so 要確認 must not ask again at once (a parcel received long ago, moved to
 * received by the migration, would come straight back otherwise). Only a delivered parcel that has received_at
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
    .select("status,received_at,updated_at")
    .eq("id", parsed.data)
    .eq("user_id", session.userId)
    .maybeSingle();
  if (readError) {
    console.error("markNotReceived:", readError.message);
    return { ok: false, error: NOT_UPDATED };
  }
  if (!row || row.status !== "delivered" || row.received_at === null) return { ok: false, error: NOT_UPDATED };

  const { data, error } = await session.supabase
    .from("parcels")
    .update({ received_at: null, check_dismissed_at: new Date().toISOString() })
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
