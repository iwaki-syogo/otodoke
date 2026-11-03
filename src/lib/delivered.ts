/** Delivered parcels grouped by the month they were ordered, for the delivered page. */

export const NO_ORDER_DATE_LABEL = "注文日不明";

/**
 * Newest month first, labelled 「2026年5月に注文」; within a month the newest order date
 * first. Parcels with no order date go last, under 「注文日不明」.
 */
export function groupByOrderMonth<P extends { ordered_at: string | null }>(parcels: P[]): Array<{ label: string; parcels: P[] }> {
  const dated = parcels.filter((p) => /^\d{4}-\d{2}/.test(p.ordered_at ?? ""));
  const undated = parcels.filter((p) => !dated.includes(p));
  // Plain code-unit comparison: ISO dates sort correctly, and no locale can change it.
  const sorted = [...dated].sort((a, b) => ((a.ordered_at as string) < (b.ordered_at as string) ? 1 : (a.ordered_at as string) > (b.ordered_at as string) ? -1 : 0));

  const groups: Array<{ label: string; parcels: P[] }> = [];
  let month = "";
  for (const p of sorted) {
    const ym = (p.ordered_at as string).slice(0, 7);
    if (ym !== month) {
      month = ym;
      const [y, m] = ym.split("-").map(Number);
      groups.push({ label: `${y}年${m}月に注文`, parcels: [] });
    }
    groups[groups.length - 1].parcels.push(p);
  }
  if (undated.length > 0) groups.push({ label: NO_ORDER_DATE_LABEL, parcels: undated });
  return groups;
}
