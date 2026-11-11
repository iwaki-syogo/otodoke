import { isLate, isReceived, lastExpectedDay, needsCheck, type ParcelRow } from "@/lib/match";

/** The parcel list's sections, worked out from every parcel in the database's order. */
export interface ParcelSections {
  /** Not delivered and not cancelled, in the order given. */
  open: ParcelRow[];
  /** 配達済み: delivered, not yet said to be received, and not yet old enough to be asked about. In the order given. */
  arrived: ParcelRow[];
  /** 要確認: two weeks past the date with no word, or two weeks since the delivery with no word from the person. In the order given. */
  toCheck: ParcelRow[];
  /** 配達中: out for delivery and not late, in the order given. */
  delivering: ParcelRow[];
  /** もうすぐ届く: everything else on its way, by next arrival. */
  soon: ParcelRow[];
  /** 注文中: ordered or unknown and not late, in the order given. */
  ordered: ParcelRow[];
}

/**
 * Received parcels (受け取り済み) and cancelled ones are in no section: they have their own pages.
 * A delivered parcel stays in 配達済み until the person says 受け取った; after two weeks it moves
 * to 要確認 (needsCheck), and is never moved on its own before that or after.
 */
export function parcelSections(parcels: ParcelRow[], today: string): ParcelSections {
  const open = parcels.filter((p) => p.status !== "delivered" && p.status !== "cancelled");
  // Two weeks past the date with no word: ask the user instead of guessing.
  const toCheck = parcels.filter((p) => needsCheck(p, today));
  const arrived = parcels.filter((p) => p.status === "delivered" && !isReceived(p) && !needsCheck(p, today));
  const active = open.filter((p) => !needsCheck(p, today));
  const delivering = active.filter((p) => p.status === "out_for_delivery" && !isLate(p, today));
  const ordered = active.filter((p) => ["ordered", "unknown"].includes(p.status) && !isLate(p, today));
  // Everything else on its way, including a parcel past its date that may still come.
  const soon = active.filter((p) => !delivering.includes(p) && !ordered.includes(p)).sort(byNextArrival(today));
  return { open, arrived, toCheck, delivering, soon, ordered };
}

/** What arrives next comes first, then what is running late, then what has no date yet. */
export function byNextArrival(today: string) {
  const rank = (p: ParcelRow) => (!p.expected_date ? 2 : (lastExpectedDay(p) as string) >= today ? 0 : 1);
  return (a: ParcelRow, b: ParcelRow) => rank(a) - rank(b) || (a.expected_date ?? "").localeCompare(b.expected_date ?? "");
}
