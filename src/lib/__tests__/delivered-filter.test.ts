import { describe, expect, it } from "vitest";
import { CATEGORIES, UNCATEGORIZED_LABEL, categoryLabel } from "@/lib/category";
import { deliveredFilterOptions, deliveredHref, filterDelivered, itemNamesByParcel } from "@/lib/delivered";
import type { ParcelRow } from "@/lib/match";
import { NONE, firstParam } from "@/lib/shop";

/**
 * Search and filters on /app/delivered (src/lib/delivered.ts):
 * - itemNamesByParcel(items: Array<{ parcel_id: string; name: string }>) -> Map<parcel id, item names>
 * - filterDelivered(parcels, itemNames, { q?, s?, c?, m? }) -> the parcels that pass every given
 *   condition (AND). The values are the raw URL strings (already through firstParam):
 *     q: partial match after trimming, NFKC and lower case, on the title, the shop as stored, the
 *        shop through normalizeShop and the item names; only its first 100 characters count;
 *        empty narrows nothing.
 *     s: normalizeShop(p) === s, compared in full (never cut); narrows nothing unless one of the
 *        given parcels is of that shop.
 *     c: through categoryParam: one of the seven, NONE (未分類, categoryOf null), else nothing.
 *     m: "YYYY-MM" with a month of 01 to 12 narrows to that order month; any other value nothing.
 * - deliveredFilterOptions(parcels) -> { shops, months, categories }
 *     shops: each shop once through normalizeShop, most parcels first, ties in code-unit order;
 *     months: the order months present, newest first (no undated);
 *     categories: the seven then 未分類, as { value: key | NONE, label }.
 * - deliveredHref({ q?, s?, c?, m? }) -> "/app/delivered" with only the non-empty values.
 */

let n = 0;
const p = (over: Partial<ParcelRow>) =>
  ({ id: `p${++n}`, shop: "テスト店", shop_key: null, title: null, category: null, ordered_at: null, status: "delivered", ...over }) as ParcelRow;

const ids = (rows: ParcelRow[]) => rows.map((r) => r.id).sort();

const AMZ1 = p({ shop: "Amazon.co.jp", shop_key: "amazon", title: "USBケーブル", category: "electronics", ordered_at: "2026-10-05" });
const AMZ2 = p({ shop: "アマゾン", shop_key: "amazon", title: "洗剤 詰め替え", category: "daily", ordered_at: "2026-09-20" });
const SHOP = p({ shop: "テスト雑貨", shop_key: "other", title: "ノート", category: null, ordered_at: "2026-10-30" });
const FOOD = p({ shop: "テスト食品", shop_key: "other", title: "お米 5kg", category: "food", ordered_at: "2026-08-01" });
const UNDATED = p({ shop: "テスト雑貨", shop_key: "other", title: "ペン", category: "hobby", ordered_at: null });
const ODD = p({ shop: "テスト雑貨", shop_key: "other", title: "シール", category: "toys", ordered_at: "2026-10-01" });
const ALL = [AMZ1, AMZ2, SHOP, FOOD, UNDATED, ODD];

const ITEMS = itemNamesByParcel([
  { parcel_id: AMZ1.id, name: "ｶﾞﾁｬｶﾞﾁｬ ABC 充電器" },
  { parcel_id: AMZ1.id, name: "変換アダプタ" },
  { parcel_id: SHOP.id, name: "方眼ノート Ａ５" },
]);

describe("itemNamesByParcel", () => {
  it("groups the item names under their parcel", () => {
    const m = itemNamesByParcel([
      { parcel_id: "a", name: "x" },
      { parcel_id: "b", name: "y" },
      { parcel_id: "a", name: "z" },
    ]);
    expect([...(m.get("a") ?? [])].sort()).toEqual(["x", "z"]);
    expect(m.get("b")).toEqual(["y"]);
    expect(m.get("c")).toBeUndefined();
  });
});

describe("filterDelivered: q", () => {
  it("finds a parcel by a word only in its item names", () => {
    expect(ids(filterDelivered(ALL, ITEMS, { q: "変換アダプタ" }))).toEqual([AMZ1.id]);
  });

  it("finds by the title and by the shop", () => {
    expect(ids(filterDelivered(ALL, ITEMS, { q: "お米" }))).toEqual([FOOD.id]);
    expect(ids(filterDelivered(ALL, ITEMS, { q: "テスト食品" }))).toEqual([FOOD.id]);
  });

  it("finds Amazon's parcels by 「Amazon」 even when the shop is stored under another name", () => {
    expect(ids(filterDelivered(ALL, ITEMS, { q: "amazon" }))).toEqual(ids([AMZ1, AMZ2]));
  });

  it("ignores full-width / half-width and upper / lower case", () => {
    expect(ids(filterDelivered(ALL, ITEMS, { q: "ＡＢＣ" }))).toEqual([AMZ1.id]);
    expect(ids(filterDelivered(ALL, ITEMS, { q: "abc" }))).toEqual([AMZ1.id]);
    expect(ids(filterDelivered(ALL, ITEMS, { q: "ガチャ" }))).toEqual([AMZ1.id]);
    expect(ids(filterDelivered(ALL, ITEMS, { q: "a5" }))).toEqual([SHOP.id]);
    expect(ids(filterDelivered(ALL, ITEMS, { q: "usbケーブル" }))).toEqual([AMZ1.id]);
  });

  it("drops spaces around the word, and an empty word narrows nothing", () => {
    expect(ids(filterDelivered(ALL, ITEMS, { q: "  お米  " }))).toEqual([FOOD.id]);
    expect(ids(filterDelivered(ALL, ITEMS, { q: "" }))).toEqual(ids(ALL));
    expect(ids(filterDelivered(ALL, ITEMS, { q: "   " }))).toEqual(ids(ALL));
  });

  it("finds nothing for a word nowhere", () => {
    expect(filterDelivered(ALL, ITEMS, { q: "存在しない語" })).toEqual([]);
  });

  it("searches with the first 100 characters of a longer word", () => {
    const long = p({ title: `${"あ".repeat(100)}X`, ordered_at: "2026-10-02" });
    const q = `${"あ".repeat(100)}Y`;
    expect(q).toHaveLength(101);
    expect(ids(filterDelivered([...ALL, long], ITEMS, { q }))).toEqual([long.id]);
  });
});

describe("filterDelivered: s", () => {
  it("takes Amazon's two names as one shop", () => {
    expect(ids(filterDelivered(ALL, ITEMS, { s: "Amazon" }))).toEqual(ids([AMZ1, AMZ2]));
  });

  it("narrows to another shop", () => {
    expect(ids(filterDelivered(ALL, ITEMS, { s: "テスト雑貨" }))).toEqual(ids([SHOP, UNDATED, ODD]));
  });

  it("narrows nothing for a shop not in the data", () => {
    expect(ids(filterDelivered(ALL, ITEMS, { s: "無い店" }))).toEqual(ids(ALL));
    expect(ids(filterDelivered(ALL, ITEMS, { s: "" }))).toEqual(ids(ALL));
  });

  it("[Codex-P3] compares a shop name over 100 characters in full, through the URL and back", () => {
    const nameA = `${"長".repeat(100)}A店`;
    const nameB = `${"長".repeat(100)}B店`;
    const a = p({ shop: nameA, ordered_at: "2026-10-03" });
    const b = p({ shop: nameB, ordered_at: "2026-10-04" });
    const rows = [...ALL, a, b];
    expect(deliveredFilterOptions(rows).shops).toEqual(expect.arrayContaining([nameA, nameB]));
    const href = deliveredHref({ s: nameA });
    const s = firstParam(new URL(href, "http://localhost").searchParams.getAll("s"));
    expect(s).toBe(nameA);
    expect(ids(filterDelivered(rows, ITEMS, { s }))).toEqual([a.id]);
  });
});

describe("filterDelivered: c", () => {
  it("narrows to a category", () => {
    expect(ids(filterDelivered(ALL, ITEMS, { c: "food" }))).toEqual([FOOD.id]);
  });

  it("narrows to 未分類 with none, a stored value outside the seven included", () => {
    expect(ids(filterDelivered(ALL, ITEMS, { c: NONE }))).toEqual(ids([SHOP, ODD]));
  });

  it("narrows nothing for an unknown value", () => {
    expect(ids(filterDelivered(ALL, ITEMS, { c: "toys" }))).toEqual(ids(ALL));
    expect(ids(filterDelivered(ALL, ITEMS, { c: "" }))).toEqual(ids(ALL));
  });
});

describe("filterDelivered: m", () => {
  it("narrows to the order month", () => {
    expect(ids(filterDelivered(ALL, ITEMS, { m: "2026-10" }))).toEqual(ids([AMZ1, SHOP, ODD]));
  });

  it("finds nothing for a well-formed month with no orders", () => {
    expect(filterDelivered(ALL, ITEMS, { m: "2025-01" })).toEqual([]);
  });

  it("narrows nothing for a malformed month", () => {
    for (const m of ["2026-13", "2026-00", "2026-1", "all", "", "2026-10-01"]) expect(ids(filterDelivered(ALL, ITEMS, { m })), m).toEqual(ids(ALL));
  });
});

describe("filterDelivered: together", () => {
  it("needs every condition (AND)", () => {
    expect(ids(filterDelivered(ALL, ITEMS, { s: "テスト雑貨", m: "2026-10" }))).toEqual(ids([SHOP, ODD]));
    expect(ids(filterDelivered(ALL, ITEMS, { s: "テスト雑貨", m: "2026-10", c: NONE, q: "方眼" }))).toEqual([SHOP.id]);
    expect(filterDelivered(ALL, ITEMS, { s: "Amazon", c: "food" })).toEqual([]);
  });

  it("returns every parcel with no condition", () => {
    expect(ids(filterDelivered(ALL, ITEMS, {}))).toEqual(ids(ALL));
  });

  it("ignores the bad values and keeps the good ones", () => {
    expect(ids(filterDelivered(ALL, ITEMS, { s: "無い店", c: "toys", m: "2026-13", q: "お米" }))).toEqual([FOOD.id]);
  });
});

describe("deliveredFilterOptions", () => {
  const options = deliveredFilterOptions(ALL);

  it("lists each shop once through normalizeShop, most parcels first, ties in code-unit order", () => {
    // テスト雑貨 3, Amazon 2, テスト食品 1
    expect(options.shops).toEqual(["テスト雑貨", "Amazon", "テスト食品"]);
    const tie = deliveredFilterOptions([p({ shop: "b店" }), p({ shop: "a店" }), p({ shop: "B店" })]);
    expect(tie.shops).toEqual(["B店", "a店", "b店"]);
  });

  it("lists the order months present, newest first, without undated parcels", () => {
    expect(options.months).toEqual(["2026-10", "2026-09", "2026-08"]);
  });

  it("offers the seven categories then 未分類", () => {
    expect(options.categories).toEqual([...CATEGORIES.map((c) => ({ value: c, label: categoryLabel(c) })), { value: NONE, label: UNCATEGORIZED_LABEL }]);
  });

  it("is empty but for the categories with no parcels", () => {
    const none = deliveredFilterOptions([]);
    expect(none.shops).toEqual([]);
    expect(none.months).toEqual([]);
    expect(none.categories).toHaveLength(8);
  });
});

describe("deliveredHref", () => {
  const parse = (href: string) => {
    const u = new URL(href, "http://localhost");
    return { path: u.pathname, params: Object.fromEntries(u.searchParams) };
  };

  it("is the bare page with no values", () => {
    expect(deliveredHref({})).toBe("/app/delivered");
    expect(deliveredHref({ q: "", s: "", c: "", m: "" })).toBe("/app/delivered");
  });

  it("puts in only the values given", () => {
    expect(parse(deliveredHref({ q: "お米", s: "", c: NONE, m: undefined }))).toEqual({ path: "/app/delivered", params: { q: "お米", c: NONE } });
    expect(parse(deliveredHref({ q: "a&b=c", s: "Amazon", c: "food", m: "2026-10" }))).toEqual({ path: "/app/delivered", params: { q: "a&b=c", s: "Amazon", c: "food", m: "2026-10" } });
  });
});
