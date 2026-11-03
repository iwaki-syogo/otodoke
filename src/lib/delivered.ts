import { CATEGORIES, categoryLabel } from "@/lib/category";
import { NONE, categoryParam, normalizeShop } from "@/lib/shop";
import { categoryOf } from "@/lib/spend";

/** Delivered parcels grouped by the month they were ordered, for the delivered page. */

export const NO_ORDER_DATE_LABEL = "注文日不明";

/**
 * Newest month first, labelled 「2026年5月に注文」; within a month the newest order date
 * first. Parcels with no order date go last, under 「注文日不明」.
 */
export function groupByOrderMonth<P extends { id: string; ordered_at: string | null }>(parcels: P[]): Array<{ label: string; parcels: P[] }> {
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

/* Search and filters on the delivered page: ?q= ?s= ?c= ?m=. */

/** Only this much of a search word counts. */
export const SEARCH_MAX = 100;

type FilterParcel = { id: string; shop: string; shop_key: string | null; title: string | null; category: string | null; ordered_at: string | null };

export type DeliveredFilterValues = { q?: string; s?: string; c?: string; m?: string };

/** The item names of each parcel, by parcel id. */
export function itemNamesByParcel(items: Array<{ parcel_id: string; name: string }>): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const it of items) {
    const names = out.get(it.parcel_id);
    if (names) names.push(it.name);
    else out.set(it.parcel_id, [it.name]);
  }
  return out;
}

/** The search word as it counts: trimmed, then cut to SEARCH_MAX. The one place this is done. */
export function searchWord(q: string | undefined): string {
  return (q ?? "").trim().slice(0, SEARCH_MAX);
}

/** Full-width / half-width and upper / lower case read alike. */
const fold = (s: string) => s.normalize("NFKC").toLowerCase();

const isMonth = (m: string | undefined): m is string => /^\d{4}-(0[1-9]|1[0-2])$/.test(m ?? "");

/**
 * The parcels that pass every given condition. A value that cannot narrow (an unknown category,
 * a shop none of the parcels is of, a malformed month, an empty word) is left out. The shop is
 * compared in full; only the search word is cut to SEARCH_MAX.
 */
export function filterDelivered<P extends FilterParcel>(parcels: P[], itemNames: Map<string, string[]>, values: DeliveredFilterValues): P[] {
  const word = fold(searchWord(values.q)).trim();
  const shop = values.s && parcels.some((p) => normalizeShop(p) === values.s) ? values.s : undefined;
  const category = categoryParam(values.c);
  const month = isMonth(values.m) ? values.m : undefined;

  return parcels.filter((p) => {
    if (shop !== undefined && normalizeShop(p) !== shop) return false;
    if (category !== undefined && categoryOf(p) !== category) return false;
    if (month !== undefined && (p.ordered_at ?? "").slice(0, 7) !== month) return false;
    if (word) {
      const texts = [p.title ?? "", p.shop, normalizeShop(p), ...(itemNames.get(p.id) ?? [])];
      if (!texts.some((t) => fold(t).includes(word))) return false;
    }
    return true;
  });
}

/** What the selects offer: the shops and order months in the data, and every category. */
export function deliveredFilterOptions(parcels: FilterParcel[]): { shops: string[]; months: string[]; categories: Array<{ value: string; label: string }> } {
  const counts = new Map<string, number>();
  for (const p of parcels) {
    const name = normalizeShop(p);
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  // Most parcels first; ties in plain code-unit order, which no locale can change.
  const shops = [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([name]) => name);
  const months = [...new Set(parcels.map((p) => (p.ordered_at ?? "").slice(0, 7)))].filter(isMonth).sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
  const categories = [...CATEGORIES.map((c) => ({ value: c as string, label: categoryLabel(c) })), { value: NONE, label: categoryLabel(null) }];
  return { shops, months, categories };
}

/**
 * The months the month select offers: the data's, plus a well-formed `m` the data does not have
 * (so the select shows what the results are narrowed by). Newest first.
 */
export function monthChoices(months: string[], m: string | undefined): string[] {
  if (!isMonth(m) || months.includes(m)) return months;
  return [...months, m].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
}

/** The delivered page's URL with only the values given. */
export function deliveredHref(values: DeliveredFilterValues): string {
  const params = new URLSearchParams();
  for (const key of ["q", "s", "c", "m"] as const) {
    const v = values[key];
    if (v) params.set(key, v);
  }
  const query = params.toString();
  return query ? `/app/delivered?${query}` : "/app/delivered";
}
