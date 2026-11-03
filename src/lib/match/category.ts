import { isCategory, type Category, type CategorySource } from "@/lib/category";

/**
 * Rules for writing a parcel's category. Pure: the pipeline, the twin merge and the bulk
 * categorizer all decide with these, then write what they return.
 *
 * A category the person chose (category_source = "user") is never replaced automatically.
 * An automatic one is written when the parcel has none, or when a reading is the first to
 * bring item names (a carrier notice that named nothing came first). Null never overwrites.
 */

export type ParcelCategory = { category: Category | null; category_source: CategorySource | null };

/** What a parcel row holds; values outside the known keys read as no category. */
type Stored = { category: string | null; category_source: string | null };
/** A parcel row's category with when the row last changed, to tell which choice is newer. */
type StoredAt = Stored & { updated_at?: string | null };

const NONE: ParcelCategory = { category: null, category_source: null };

function stored(p: Stored): ParcelCategory {
  if (!isCategory(p.category)) return NONE;
  return { category: p.category, category_source: p.category_source === "user" ? "user" : "auto" };
}

const auto = (category: Category): ParcelCategory => ({ category, category_source: "auto" });

/** A new parcel: the reading's category as "auto", or nothing. */
export function categoryForInsert(read: Category | null): ParcelCategory {
  return read ? auto(read) : { ...NONE };
}

/**
 * A reading joins an existing parcel. Answers the columns to change, or {} to leave them.
 * The bulk categorizer calls it with bringsFirstItems = false for parcels that have none.
 */
export function categoryForUpdate(current: Stored, read: Category | null, bringsFirstItems: boolean): Partial<ParcelCategory> {
  if (current.category_source === "user" || !read) return {};
  if (stored(current).category === null || bringsFirstItems) return auto(read);
  return {};
}

/**
 * Two parcels found to be one. `rebuilt` is the category decided again from all the mails.
 * A user's choice wins: when several rows hold one, the row changed last (updated_at) wins, and
 * on a tie or without times the kept parcel's first, then an absorbed one's. Then the rebuilt
 * category; an automatic one already there is kept rather than lost to a null.
 */
export function categoryForTwins(keep: StoredAt, absorbed: StoredAt[], rebuilt: Stored): ParcelCategory {
  const rows = [keep, ...absorbed];
  const all = rows.map(stored);
  let chosen: ParcelCategory | null = null;
  let chosenAt = "";
  for (const [i, c] of all.entries()) {
    if (c.category_source !== "user") continue;
    const at = rows[i].updated_at ?? "";
    // Plain comparison of ISO times in one format; no locale can reorder it.
    if (chosen === null || at > chosenAt) {
      chosen = c;
      chosenAt = at;
    }
  }
  if (chosen) return chosen;
  const fresh = stored(rebuilt);
  if (fresh.category) return auto(fresh.category);
  const kept = all.find((c) => c.category !== null)?.category;
  return kept ? auto(kept) : { ...NONE };
}
