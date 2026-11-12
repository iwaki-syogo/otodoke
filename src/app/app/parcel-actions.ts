"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { todayJst } from "@/lib/format";
import { isReceivedAt, needsCheck } from "@/lib/match";
import { createClient } from "@/lib/supabase/server";
import { undeliveredStatus } from "@/lib/undelivered";

import { RECEIPT_CHUNK_SIZE, type MarkReceivedResult, type ReceivedReceipt, type ReceiptKey, type RestoreResult } from "@/lib/receipt";
import type { Json } from "@/lib/db/database.types";

const Receipt = z.object({ id: z.uuid(), receipt_id: z.uuid(), received_at: z.iso.datetime({ offset: true }), updated_at: z.iso.datetime({ offset: true }),
  previous_status: z.string().min(1), previous_received_at: z.union([z.null(),z.iso.datetime({ offset:true })]) });

/** The user's own session, and their id for a condition on top of row-level security. */
async function signedIn() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user ? { supabase, userId: user.id } : null;
}

/** Mark a single bounded request. The UI splits larger visible selections transparently. */
export async function markDelivered(ids: string[]): Promise<number> {
  return (await deliver(ids)).saved;
}

/** The receipt contains the real pre-press state and post-write version read by the database. */
export async function markDeliveredForUndo(ids: string[]): Promise<MarkReceivedResult> {
  return await deliver(ids);
}

async function deliver(ids: string[]): Promise<MarkReceivedResult> {
  // Reject the raw request first: deduplicating first would let repeated ids bypass the budget.
  if (!Array.isArray(ids) || ids.length > RECEIPT_CHUNK_SIZE) throw new Error("too many receipt ids");
  const clean = [...new Set(ids.filter((id) => z.uuid().safeParse(id).success))];
  if (clean.length === 0) return { saved: 0, written: [] };
  const session = await signedIn();
  if (!session) return { saved: 0, written: [] };
  try {
    const { data, error } = await session.supabase.rpc("mark_parcels_received", { p_ids: clean });
    if (error) throw new Error(error.message);
    if (!Array.isArray(data)) throw new Error("received parcels were not confirmed");
    const rows = new Map<string, typeof data>();
    for (const row of data) {
      if (row && clean.includes(row.id)) rows.set(row.id, [...(rows.get(row.id) ?? []), row]);
    }
    const written: ReceivedReceipt[] = []; let saved = 0;
    for (const id of clean) {
      const matches = rows.get(id);
      if (matches?.length !== 1) continue;
      const row = matches[0];
      if (row.outcome === "written") {
        const parsed = Receipt.safeParse(row);
        if (parsed.success) { written.push(parsed.data); saved++; }
      } else if (row.outcome === "already_received") saved++;
    }
    return { saved, written };
  } finally {
    // An unanswered transaction may have committed; reload its actual state.
    revalidatePath("/app", "layout");
  }
}

/** Undo trusts only the server journal identified by a receipt key, never a caller's old status. */
export async function restoreStatuses(items: ReceiptKey[]): Promise<RestoreResult> {
  if (!Array.isArray(items) || items.length > RECEIPT_CHUNK_SIZE) throw new Error("too many undo receipts");
  const result: RestoreResult = { restored: [], changed: [], failed: [] };
  const failed = new Set<string>(); const clean = new Map<string, ReceiptKey>();
  for (const item of items) {
    if (!item || typeof item.id !== "string") throw new Error("invalid undo receipt");
    const parsed = z.object({ id: z.uuid(), receipt_id: z.uuid() }).safeParse(item);
    if (!parsed.success) { failed.add(item.id); continue; }
    const prior = clean.get(parsed.data.id);
    if (prior && prior.receipt_id !== parsed.data.receipt_id) { failed.add(item.id); clean.delete(item.id); continue; }
    if (!failed.has(item.id)) clean.set(item.id, parsed.data);
  }
  result.failed = [...failed];
  if (clean.size === 0) return result;
  let session;
  try { session = await signedIn(); } catch { session = null; }
  if (!session) return { ...result, failed: [...new Set([...result.failed,...clean.keys()])] };
  try {
    const { data, error } = await session.supabase.rpc("restore_parcel_receipts", { p_receipts: [...clean.values()] as unknown as Json });
    if (error) throw new Error(error.message);
    if (!Array.isArray(data)) throw new Error("undo result was not confirmed");
    const rows = new Map<string, typeof data>();
    for (const row of data) {
      if (row && clean.has(row.id)) rows.set(row.id, [...(rows.get(row.id) ?? []), row]);
    }
    for (const id of clean.keys()) {
      const matches = rows.get(id);
      if (matches?.length === 1 && ["restored", "changed", "failed"].includes(matches[0].outcome)) {
        result[matches[0].outcome as "restored" | "changed" | "failed"].push(id);
      } else (result.unconfirmed ??= []).push(id);
    }
    return result;
  } catch (error) {
    console.error("restoreStatuses:", error instanceof Error ? error.message : String(error));
    // A lost answer may follow a committed undo; retain local refusals without inferring an RPC refusal.
    return { ...result, unconfirmed: [...clean.keys()] };
  } finally {
    revalidatePath("/app", "layout");
  }
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
