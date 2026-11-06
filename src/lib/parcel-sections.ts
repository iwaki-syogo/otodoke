import { isLate, lastExpectedDay, needsCheck, type ParcelRow } from "@/lib/match";

/** The parcel list's sections, worked out from every parcel in the database's order. */
export interface ParcelSections {
  /** Not delivered and not cancelled, in the order given. */
  open: ParcelRow[];
  /** 要確認: two weeks past the date with no word, in the order given. */
  toCheck: ParcelRow[];
  /** 配達中: out for delivery and not late, in the order given. */
  delivering: ParcelRow[];
  /** もうすぐ届く: everything else on its way, by next arrival. */
  soon: ParcelRow[];
  /** 注文中: ordered or unknown and not late, in the order given. */
  ordered: ParcelRow[];
}

export function parcelSections(parcels: ParcelRow[], today: string): ParcelSections {
  const open = parcels.filter((p) => p.status !== "delivered" && p.status !== "cancelled");
  // Two weeks past the date with no word: ask the user instead of guessing.
  const toCheck = open.filter((p) => needsCheck(p, today));
  const active = open.filter((p) => !needsCheck(p, today));
  const delivering = active.filter((p) => p.status === "out_for_delivery" && !isLate(p, today));
  const ordered = active.filter((p) => ["ordered", "unknown"].includes(p.status) && !isLate(p, today));
  // Everything else on its way, including a parcel past its date that may still come.
  const soon = active.filter((p) => !delivering.includes(p) && !ordered.includes(p)).sort(byNextArrival(today));
  return { open, toCheck, delivering, soon, ordered };
}

/** What arrives next comes first, then what is running late, then what has no date yet. */
export function byNextArrival(today: string) {
  const rank = (p: ParcelRow) => (!p.expected_date ? 2 : (lastExpectedDay(p) as string) >= today ? 0 : 1);
  return (a: ParcelRow, b: ParcelRow) => rank(a) - rank(b) || (a.expected_date ?? "").localeCompare(b.expected_date ?? "");
}
