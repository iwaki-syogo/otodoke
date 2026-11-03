import { CATEGORIES, isCategory, type Category } from "@/lib/category";
import { monthParam, shiftMonth } from "@/lib/format";

/** Totals for the spend screen. Only parcels whose amount was read count toward money. */

type SpendParcel = { ordered_at: string | null; total_amount: number | null; category: string | null };

/** The month a `?m=` names: "YYYY-MM" with a month of 01 to 12, else this month. */
export function spendMonthParam(m: string | undefined, today: string): string {
  return monthParam(m, today);
}

/** The total card: the sum of the amounts read, how many had one, and how many did not. */
export function spendTotal(parcels: SpendParcel[]): { total: number; priced: number; unpriced: number } {
  const priced = parcels.filter((p) => p.total_amount !== null);
  return { total: priced.reduce((s, p) => s + (p.total_amount ?? 0), 0), priced: priced.length, unpriced: parcels.length - priced.length };
}

/** A stored category, or null (未分類) for none or a value outside the seven. */
export function categoryOf(p: { category: string | null }): Category | null {
  return isCategory(p.category) ? p.category : null;
}

/** The fixed order categories stack and list in when amounts tie: the seven, then 未分類. */
const ORDER: Array<Category | null> = [...CATEGORIES, null];

function sumByCategory(parcels: SpendParcel[]): Map<Category | null, number> {
  const sums = new Map<Category | null, number>();
  for (const p of parcels) {
    if (p.total_amount === null) continue;
    const c = categoryOf(p);
    sums.set(c, (sums.get(c) ?? 0) + p.total_amount);
  }
  return sums;
}

/** Each category's amount and share of the total, largest first; null is 未分類. */
export function spendByCategory(parcels: SpendParcel[]): Array<{ category: Category | null; amount: number; share: number }> {
  const sums = sumByCategory(parcels);
  const total = [...sums.values()].reduce((s, v) => s + v, 0);
  return ORDER.filter((c) => sums.has(c))
    .map((category) => {
      const amount = sums.get(category) ?? 0;
      return { category, amount, share: total > 0 ? amount / total : 0 };
    })
    .sort((a, b) => b.amount - a.amount);
}

/**
 * One bar per order month, oldest first, stacked by category in the same fixed order every
 * month. Parcels with no order date or no amount are not on the bars.
 */
export function spendByMonth(parcels: SpendParcel[]): Array<{ month: string; total: number; segments: Array<{ category: Category | null; amount: number }> }> {
  const byMonth = new Map<string, SpendParcel[]>();
  for (const p of parcels) {
    if (p.total_amount === null || !/^\d{4}-\d{2}/.test(p.ordered_at ?? "")) continue;
    const month = (p.ordered_at as string).slice(0, 7);
    byMonth.set(month, [...(byMonth.get(month) ?? []), p]);
  }
  // Plain comparison of "YYYY-MM": no locale can reorder it.
  const months = [...byMonth.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return months.map((month) => {
    const sums = sumByCategory(byMonth.get(month) ?? []);
    const segments = ORDER.filter((c) => (sums.get(c) ?? 0) > 0).map((category) => ({ category, amount: sums.get(category) ?? 0 }));
    return { month, total: segments.reduce((s, x) => s + x.amount, 0), segments };
  });
}

type MonthBar = ReturnType<typeof spendByMonth>[number];

/** Longest run of months the bars fill in; a stray year in a reading must not draw thousands of bars. */
const MAX_FILLED_MONTHS = 240;

/**
 * The bars with every month from the first to the last, a month without spending as 0, so the
 * time axis does not skip. Left as given when the run is longer than MAX_FILLED_MONTHS.
 */
export function withEmptyMonths(months: MonthBar[]): MonthBar[] {
  if (months.length < 2) return months;
  const first = months[0].month;
  const last = months[months.length - 1].month;
  const byMonth = new Map(months.map((m) => [m.month, m]));
  const out: MonthBar[] = [];
  for (let month = first; month <= last; month = shiftMonth(month, 1)) {
    if (out.length >= MAX_FILLED_MONTHS) return months;
    out.push(byMonth.get(month) ?? { month, total: 0, segments: [] });
  }
  return out;
}

/** Round numbers for the y axis: 0 up to a clean top that covers `max`, at most 4 steps. */
export function axisTicks(max: number): number[] {
  if (max <= 0) return [0];
  const raw = max / 4;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = Math.max(1, [1, 2, 5, 10].map((k) => k * pow).find((s) => s >= raw) ?? 10 * pow);
  const ticks: number[] = [];
  for (let v = 0; v < max + step; v += step) {
    ticks.push(v);
    if (v >= max) break;
  }
  return ticks;
}
