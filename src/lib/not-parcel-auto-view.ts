import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/db/database.types";
import { excludedToastText } from "@/lib/not-parcel-auto-toast";

/** One row of excluded_parcels(), only the columns the views below read. */
export interface ExcludedViewRow {
  parcel_id: string;
  kind: string;
  excluded_at: string;
  status: string;
}

/** One row of excluded_parcels_unseen(): the mark's own time, which is what "seen" is compared with. */
export interface MarkTime {
  parcel_id: string;
  created_at: string;
}

/** Taken out by the app itself, and not arrived (not delivered, not cancelled): the parcels the row under the list is about. */
export const isOpenAuto = (row: Pick<ExcludedViewRow, "kind" | "status">) =>
  row.kind === "rule" && row.status !== "delivered" && row.status !== "cancelled";

/** The open automatic ones first, then the rest; each group keeps the order the database gave (newest first). */
export function orderExcluded<T extends Pick<ExcludedViewRow, "kind" | "status">>(rows: readonly T[]): T[] {
  return [...rows.filter(isOpenAuto), ...rows.filter((row) => !isOpenAuto(row))];
}

/** The newest mark time (created_at, from excluded_parcels_unseen) among the open automatic rows that are shown. null when none is shown: nothing is written then. */
export function seenUntilOf(rows: readonly ExcludedViewRow[], marks: readonly MarkTime[] | null): string | null {
  if (!marks) return null;
  const createdAt = new Map(marks.map((m) => [m.parcel_id, m.created_at]));
  let best: { at: string; time: number } | null = null;
  for (const row of rows) {
    if (!isOpenAuto(row)) continue;
    const at = createdAt.get(row.parcel_id);
    if (at === undefined) continue;
    const time = Date.parse(at);
    if (Number.isNaN(time)) continue;
    if (!best || time > best.time) best = { at, time };
  }
  return best ? best.at : null;
}

/** The mark times, or null when they could not be read (then nothing is written). */
export async function readMarkTimes(supabase: SupabaseClient<Database>): Promise<MarkTime[] | null> {
  try {
    const { data, error } = await supabase.rpc("excluded_parcels_unseen");
    if (error || !Array.isArray(data)) return null;
    return data;
  } catch {
    return null;
  }
}

/** "yes" / "no" only from a clean boolean. A failed or odd answer is "failed", never read as "no". */
export async function readOpenAutoExclusion(supabase: SupabaseClient<Database>): Promise<"yes" | "no" | "failed"> {
  try {
    const { data, error } = await supabase.rpc("has_open_auto_exclusion");
    if (error) {
      console.error("has_open_auto_exclusion:", error.message);
      return "failed";
    }
    return data === true ? "yes" : data === false ? "no" : "failed";
  } catch (error) {
    console.error("has_open_auto_exclusion:", error instanceof Error ? error.message : String(error));
    return "failed";
  }
}

/**
 * The words of the list's notice for /app?excluded=<id>. The notice is only for a parcel the person took out themselves
 * (a mark of kind user is there now): a made-up or someone else's id, or an automatic mark, gives null and no notice.
 * A failed read gives null as well. Then the one sentence that fits whether the app will do it by itself from now on.
 */
export async function excludedNoticeText(supabase: SupabaseClient<Database>, parcelId: string): Promise<string | null> {
  try {
    const { data, error } = await supabase.rpc("excluded_parcels");
    if (error || !Array.isArray(data)) return null;
    if (!data.some((row) => row.parcel_id === parcelId && row.kind === "user")) return null;
  } catch {
    return null;
  }
  return excludedToastText(supabase, parcelId);
}
