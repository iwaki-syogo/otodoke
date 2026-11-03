import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Category } from "@/lib/category";
import type { ParcelRow } from "@/lib/match";
import { sharePercent, spendByCategory, spendByMonth } from "@/lib/spend";

/**
 * Pure totals for the spend screen (src/lib/spend.ts):
 * - spendByCategory(parcels) -> Array<{ category: Category | null; amount: number; share: number }>
 *     priced parcels only, largest amount first, null = 未分類, share = amount / total (0..1).
 * - spendByMonth(parcels) -> Array<{ month: "YYYY-MM"; total: number; segments: Array<{ category; amount }> }>
 *     by order month, oldest first, segments stacked by category in the same order in every
 *     month. Parcels without an order date or an amount are not on the bars.
 */

let n = 0;
const p = (ordered_at: string | null, total_amount: number | null, category: Category | null) =>
  ({ id: `p${++n}`, ordered_at, total_amount, category, category_source: category ? "auto" : null, status: "delivered" }) as unknown as ParcelRow;

const amountOf = (rows: ReturnType<typeof spendByCategory>, c: Category | null) => rows.find((r) => r.category === c)?.amount;

describe("spendByCategory", () => {
  const parcels = [p("2026-11-01", 1000, "food"), p("2026-11-02", 3000, "electronics"), p("2026-11-03", 500, "food"), p("2026-11-04", 1500, null), p("2026-11-05", null, "beauty")];

  it("adds up each category, with 未分類 as null", () => {
    const rows = spendByCategory(parcels);
    expect(amountOf(rows, "food")).toBe(1500);
    expect(amountOf(rows, "electronics")).toBe(3000);
    expect(amountOf(rows, null)).toBe(1500);
  });

  it("leaves out parcels whose amount could not be read", () => {
    const rows = spendByCategory(parcels);
    expect(amountOf(rows, "beauty") ?? 0).toBe(0);
    expect(rows.reduce((s, r) => s + r.amount, 0)).toBe(6000);
  });

  it("puts the largest first", () => {
    const amounts = spendByCategory(parcels).map((r) => r.amount);
    expect(amounts).toEqual([...amounts].sort((a, b) => b - a));
    expect(spendByCategory(parcels)[0].category).toBe("electronics");
  });

  it("gives each its share of the total", () => {
    const rows = spendByCategory(parcels);
    expect(rows.find((r) => r.category === "electronics")!.share).toBeCloseTo(0.5, 6);
    expect(rows.reduce((s, r) => s + r.share, 0)).toBeCloseTo(1, 6);
  });

  it("returns nothing for no priced parcels", () => {
    expect(spendByCategory([])).toEqual([]);
    expect(spendByCategory([p("2026-11-01", null, "food")]).filter((r) => r.amount > 0)).toEqual([]);
  });
});

describe("spendByMonth", () => {
  const parcels = [
    p("2026-09-10", 2000, "food"),
    p("2026-10-05", 1000, "food"),
    p("2026-10-20", 4000, "hobby"),
    p("2026-10-21", 700, null),
    p("2026-11-01", 300, "hobby"),
    p("2026-11-02", 900, "food"),
    p(null, 99999, "food"),
    p("2026-11-03", null, "food"),
  ];
  const months = spendByMonth(parcels);

  it("has one bar per order month, oldest first", () => {
    expect(months.map((m) => m.month)).toEqual(["2026-09", "2026-10", "2026-11"]);
  });

  it("stacks each month by category", () => {
    const oct = months.find((m) => m.month === "2026-10")!;
    expect(oct.total).toBe(5700);
    const seg = (c: Category | null) => oct.segments.find((s) => s.category === c)?.amount;
    expect(seg("food")).toBe(1000);
    expect(seg("hobby")).toBe(4000);
    expect(seg(null)).toBe(700);
    expect(oct.segments.reduce((s, x) => s + x.amount, 0)).toBe(oct.total);
  });

  it("keeps the same category order in every month", () => {
    const order = (m: (typeof months)[number]) => m.segments.filter((s) => s.amount > 0).map((s) => String(s.category));
    const oct = order(months[1]);
    const nov = order(months[2]);
    const shared = oct.filter((c) => nov.includes(c));
    expect(nov.filter((c) => shared.includes(c))).toEqual(shared);
  });

  it("leaves parcels without an order date or an amount off the bars, so the bars add up to the all-time total", () => {
    const bars = months.reduce((s, m) => s + m.total, 0);
    expect(bars).toBe(2000 + 1000 + 4000 + 700 + 300 + 900);
  });

  it("does not mix the same month of different years", () => {
    const m = spendByMonth([p("2025-11-01", 100, "food"), p("2026-11-01", 200, "food")]);
    expect(m.map((x) => [x.month, x.total])).toEqual([
      ["2025-11", 100],
      ["2026-11", 200],
    ]);
  });
});

describe("spend screen wiring", () => {
  const page = readFileSync(path.resolve(__dirname, "../../app/app/spend/page.tsx"), "utf8");
  const pkg = JSON.parse(readFileSync(path.resolve(__dirname, "../../../package.json"), "utf8")) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };

  it("offers the whole period and reads it with readAll", () => {
    expect(page).toMatch(/["'`]all["'`]/);
    expect(page).toContain("readAll");
  });

  it("keeps the per-shop breakdown under the categories", () => {
    expect(page).toContain("店ごと");
  });

  it("adds no chart library", () => {
    const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
    expect(deps.filter((d) => /chart|recharts|d3|victory|nivo|visx|plotly|echarts/i.test(d))).toEqual([]);
  });
});

describe("sharePercent", () => {
  it("reads 0% for nothing spent", () => {
    expect(sharePercent(0)).toBe("0%");
  });

  it("reads <1% for an amount above 0 that would round to 0%", () => {
    expect(sharePercent(400 / 82_044)).toBe("<1%");
    expect(sharePercent(0.0049)).toBe("<1%");
    expect(sharePercent(1e-9)).toBe("<1%");
  });

  it("rounds to a whole percent from 0.5% up", () => {
    expect(sharePercent(0.005)).toBe("1%");
    expect(sharePercent(0.0149)).toBe("1%");
    expect(sharePercent(0.5)).toBe("50%");
    expect(sharePercent(1)).toBe("100%");
  });

  it("is what the breakdown shows, for a month and for all time", () => {
    const source = readFileSync(path.resolve(__dirname, "../../app/app/spend/page.tsx"), "utf8");
    expect(source).toContain("sharePercent(r.share)");
    expect(source).not.toMatch(/Math\.round\(r\.share/);
  });
});
