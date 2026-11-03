import { describe, expect, it } from "vitest";
import type { Category } from "@/lib/category";
import { spendByCategory, spendSlices, spendTotal } from "@/lib/spend";
import { normalizeShop } from "@/lib/shop";

/**
 * spendSlices(parcels, { all, c, s }) in src/lib/spend.ts decides what ?c= and ?s= narrow, for a
 * month and for the whole period alike:
 *
 *   | part                          | narrowed by |
 *   | total, bars, the order list   | c and s     |
 *   | the per-category rows         | s only      |
 *   | the per-shop rows             | c only      |
 *
 * c: Category | null (未分類) | undefined (no filter), as categoryParam gives it.
 * s: the shop through normalizeShop, compared in full; undefined or "" is no filter.
 * all: over the whole period, parcels with no order date stay out of every figure ("counted" =
 * parcels with an order date); the order list still has them.
 *
 * Returns { picked, orders, byCategory, byShop, undated }:
 *   picked     counted, by c and s           -> spendTotal and withEmptyMonths(spendByMonth(...))
 *   orders     the order list, by c and s    -> all: every parcel (undated too); a month: = picked
 *   byCategory counted, by s only            -> spendByCategory
 *   byShop     counted, by c only            -> the per-shop rows
 *   undated    over all: how many parcels with no order date pass c and s; a month: 0
 */

type P = { id: string; ordered_at: string | null; total_amount: number | null; category: string | null; shop: string; shop_key: string | null };
let n = 0;
const p = (shop: string, shop_key: string | null, ordered_at: string | null, total_amount: number | null, category: Category | null): P => ({
  id: `p${++n}`,
  shop,
  shop_key,
  ordered_at,
  total_amount,
  category,
});

const A1 = p("Amazon.co.jp", "amazon", "2026-10-05", 1000, "food");
const A2 = p("アマゾン", "amazon", "2026-10-10", 2000, null);
const Y = p("テスト電機", "other", "2026-10-12", 5000, "electronics");
const Y2 = p("テスト電機", "other", "2026-10-20", 300, "food");
const U = p("テスト電機", "other", null, 400, "food");
const UA = p("Amazon.co.jp", "amazon", null, 50, null);
const MONTH = [A1, A2, Y, Y2];
const EVERY = [A1, A2, Y, Y2, U, UA];

const ids = (rows: P[]) => rows.map((r) => r.id).sort();
const slice = (parcels: P[], all: boolean, c: Category | null | undefined, s: string | undefined) => spendSlices(parcels, { all, c, s });

describe("spendSlices: a month", () => {
  it("narrows nothing with neither c nor s", () => {
    const r = slice(MONTH, false, undefined, undefined);
    expect(ids(r.picked)).toEqual(ids(MONTH));
    expect(ids(r.orders)).toEqual(ids(MONTH));
    expect(ids(r.byCategory)).toEqual(ids(MONTH));
    expect(ids(r.byShop)).toEqual(ids(MONTH));
    expect(r.undated).toBe(0);
  });

  it("c only: total and orders narrowed, the category rows whole, the shop rows narrowed", () => {
    const r = slice(MONTH, false, "food", undefined);
    expect(ids(r.picked)).toEqual(ids([A1, Y2]));
    expect(spendTotal(r.picked).total).toBe(1300);
    expect(ids(r.orders)).toEqual(ids([A1, Y2]));
    expect(ids(r.byCategory)).toEqual(ids(MONTH));
    expect(ids(r.byShop)).toEqual(ids([A1, Y2]));
  });

  it("s only: total and orders narrowed, the category rows narrowed, the shop rows whole", () => {
    const r = slice(MONTH, false, undefined, "テスト電機");
    expect(ids(r.picked)).toEqual(ids([Y, Y2]));
    expect(ids(r.orders)).toEqual(ids([Y, Y2]));
    expect(ids(r.byCategory)).toEqual(ids([Y, Y2]));
    expect(spendByCategory(r.byCategory).map((x) => x.category)).toEqual(["electronics", "food"]);
    expect(ids(r.byShop)).toEqual(ids(MONTH));
  });

  it("c and s: total and orders by both, each breakdown by the other one only", () => {
    const r = slice(MONTH, false, "food", "テスト電機");
    expect(ids(r.picked)).toEqual([Y2.id]);
    expect(ids(r.orders)).toEqual([Y2.id]);
    expect(ids(r.byCategory)).toEqual(ids([Y, Y2]));
    expect(ids(r.byShop)).toEqual(ids([A1, Y2]));
  });

  it("takes Amazon's two names as one shop", () => {
    expect(new Set(MONTH.map(normalizeShop)).size).toBe(2);
    const r = slice(MONTH, false, undefined, "Amazon");
    expect(ids(r.picked)).toEqual(ids([A1, A2]));
    expect(spendTotal(r.picked).total).toBe(3000);
  });

  it("narrows to 未分類 with c = null", () => {
    const r = slice(MONTH, false, null, undefined);
    expect(ids(r.picked)).toEqual([A2.id]);
    expect(ids(r.byShop)).toEqual([A2.id]);
  });

  it("narrows to nothing for a shop not in the month (the chip stays to take it off)", () => {
    const r = slice(MONTH, false, undefined, "どこにも無い店");
    expect(r.picked).toEqual([]);
    expect(r.orders).toEqual([]);
    expect(r.byCategory).toEqual([]);
    expect(ids(r.byShop)).toEqual(ids(MONTH));
  });

  it("reads s = \"\" as no filter", () => {
    expect(ids(slice(MONTH, false, undefined, "").picked)).toEqual(ids(MONTH));
  });

  it("[Codex-P3] compares a shop name over 100 characters in full", () => {
    const a = p(`${"長".repeat(100)}A店`, null, "2026-10-01", 10, "food");
    const b = p(`${"長".repeat(100)}B店`, null, "2026-10-02", 20, "food");
    expect(ids(slice([...MONTH, a, b], false, undefined, a.shop).picked)).toEqual([a.id]);
  });
});

describe("spendSlices: the whole period", () => {
  it("keeps parcels with no order date out of the figures, in the order list", () => {
    const r = slice(EVERY, true, undefined, undefined);
    expect(ids(r.picked)).toEqual(ids(MONTH));
    expect(ids(r.byCategory)).toEqual(ids(MONTH));
    expect(ids(r.byShop)).toEqual(ids(MONTH));
    expect(ids(r.orders)).toEqual(ids(EVERY));
    expect(r.undated).toBe(2);
  });

  it("narrows the undated count and the list by c and s too", () => {
    const r = slice(EVERY, true, "food", "テスト電機");
    expect(ids(r.picked)).toEqual([Y2.id]);
    expect(ids(r.orders)).toEqual(ids([Y2, U]));
    expect(r.undated).toBe(1);
    expect(ids(r.byCategory)).toEqual(ids([Y, Y2]));
    expect(ids(r.byShop)).toEqual(ids([A1, Y2]));
  });

  it("s only over the whole period", () => {
    const r = slice(EVERY, true, undefined, "Amazon");
    expect(ids(r.picked)).toEqual(ids([A1, A2]));
    expect(ids(r.orders)).toEqual(ids([A1, A2, UA]));
    expect(r.undated).toBe(1);
  });

  it("c = null over the whole period", () => {
    const r = slice(EVERY, true, null, undefined);
    expect(ids(r.picked)).toEqual([A2.id]);
    expect(ids(r.orders)).toEqual(ids([A2, UA]));
    expect(r.undated).toBe(1);
  });
});
