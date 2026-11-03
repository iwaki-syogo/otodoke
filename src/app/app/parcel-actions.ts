"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

/** Statuses a parcel may be put back to after it was marked as arrived by hand. */
const RESTORABLE = ["ordered", "shipped", "out_for_delivery", "attempted", "unknown"];
const MAX_AT_ONCE = 500;

/** The user's own session, and their id for a condition on top of row-level security. */
async function signedIn() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user ? { supabase, userId: user.id } : null;
}

/**
 * The user says these parcels have arrived. Runs with the user's own session, so row-level
 * security limits it to their parcels. Answers how many rows changed.
 */
export async function markDelivered(ids: string[]): Promise<number> {
  const clean = ids.filter((id) => typeof id === "string" && id.length > 0).slice(0, MAX_AT_ONCE);
  if (clean.length === 0) return 0;
  const session = await signedIn();
  if (!session) return 0;
  const { data, error } = await session.supabase
    .from("parcels")
    .update({ status: "delivered" })
    .in("id", clean)
    .eq("user_id", session.userId)
    .neq("status", "cancelled")
    .select("id");
  if (error) throw new Error(error.message);
  revalidatePath("/app", "layout");
  return data.length;
}

/** Undo: puts parcels marked by hand back to the status each had before. */
export async function restoreStatuses(items: { id: string; status: string }[]): Promise<void> {
  const clean = items.filter((it) => typeof it.id === "string" && RESTORABLE.includes(it.status)).slice(0, MAX_AT_ONCE);
  if (clean.length === 0) return;
  const session = await signedIn();
  if (!session) return;
  const byStatus = new Map<string, string[]>();
  for (const it of clean) byStatus.set(it.status, [...(byStatus.get(it.status) ?? []), it.id]);
  for (const [status, ids] of byStatus) {
    const { error } = await session.supabase.from("parcels").update({ status }).in("id", ids).eq("user_id", session.userId).eq("status", "delivered");
    if (error) throw new Error(error.message);
  }
  revalidatePath("/app", "layout");
}
