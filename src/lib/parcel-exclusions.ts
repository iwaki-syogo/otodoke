import type { AdminClient } from "@/lib/supabase/admin";
import type { ParcelExclusion } from "@/lib/match";

/** The mark on one parcel (table parcel_exclusions), with the parcel it belongs to. */
export interface ExclusionRow extends ParcelExclusion {
  parcel_id: string;
}

const PAGE = 1000;

/**
 * Every mark of this user. Paged by parcel_id: the table has no `id` column (readAll orders by `id`), and a
 * failed page throws, never an empty list in place of an error.
 */
export async function readExclusions(db: AdminClient, userId: string): Promise<ExclusionRow[]> {
  const rows: ExclusionRow[] = [];
  let total: number | null = null;
  for (;;) {
    const from = rows.length;
    const { data, error, count } = await db
      .from("parcel_exclusions")
      .select("parcel_id, kind, from_domain, relevance, counted", { count: "exact" })
      .eq("user_id", userId)
      .order("parcel_id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`parcel_exclusions lookup failed: ${error.message}`);
    if (total === null) {
      if (count === null) throw new Error("parcel_exclusions lookup returned no count");
      total = count;
    }
    const page = data ?? [];
    rows.push(...page);
    if (rows.length >= total) return rows;
    if (page.length === 0) throw new Error(`parcel_exclusions lookup: expected ${total} rows, got ${rows.length}`);
  }
}
