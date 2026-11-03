import { monthParam, todayJst } from "@/lib/format";
import { spendMonthParam } from "@/lib/spend";

/** URLs and bounds for the month picker on the calendar and the spend page. */

/** The earliest month the picker offers. */
export const MONTH_MIN = "2020-01";

/** The latest month the picker offers: December of next year. */
export function monthMax(today: string = todayJst()): string {
  return `${Number(today.slice(0, 4)) + 1}-12`;
}

/**
 * `${basePath}?m=<month>` with each non-empty value of `keep` after it. A malformed month becomes
 * this month, the way each page reads `?m=`.
 */
export function monthHref(basePath: string, month: string, keep: Record<string, string | undefined> = {}, today: string = todayJst()): string {
  const m = basePath === "/app/spend" ? spendMonthParam(month, today) : monthParam(month, today);
  const q = new URLSearchParams({ m });
  for (const [key, value] of Object.entries(keep)) if (value) q.set(key, value);
  return `${basePath}?${q.toString()}`;
}
