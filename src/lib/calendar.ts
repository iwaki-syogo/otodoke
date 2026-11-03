import { lastExpectedDay, type ParcelRow } from "@/lib/match";

type CalendarParcel = Pick<ParcelRow, "status" | "expected_date" | "expected_date_end">;

/**
 * The calendar's parcels from today on, grouped by the day they are listed under ("YYYY-MM-DD",
 * input order kept). A parcel is listed while its last expected day is today or later, and never
 * once delivered or cancelled. A window is listed on max(its first day, today, the month's first
 * day), so nothing is ever listed on a past day. Days outside [first, last] are not listed.
 */
export function upcomingByDay<T extends CalendarParcel>(parcels: T[], today: string, first: string, last: string): Map<string, T[]> {
  const byDay = new Map<string, T[]>();
  for (const p of parcels) {
    if (!p.expected_date || p.status === "delivered" || p.status === "cancelled") continue;
    const end = lastExpectedDay(p) as string;
    if (end < today) continue;
    const day = [p.expected_date, today, first].reduce((a, b) => (b > a ? b : a));
    if (day > last || end < first) continue;
    const list = byDay.get(day) ?? [];
    list.push(p);
    byDay.set(day, list);
  }
  return byDay;
}
