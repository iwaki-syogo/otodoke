import { CATEGORIES, isCategory, type Category } from "@/lib/category";

/** Totals for the spend screen. Only parcels whose amount was read count toward money. */

type SpendParcel = { ordered_at: string | null; total_amount: number | null; category: string | null };

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
