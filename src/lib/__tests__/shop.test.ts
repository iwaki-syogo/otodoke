import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CATEGORIES } from "@/lib/category";
import { NONE, categoryParam, firstParam, normalizeShop } from "@/lib/shop";

/**
 * src/lib/shop.ts, shared by the delivered page (?s=) and the spend page (?c= / ?s=):
 * - normalizeShop({ shop, shop_key }) -> string: "Amazon" when shop_key is "amazon" (Amazon signs
 *   its mails under several names), else the shop as stored.
 * - NONE = "none": 未分類 in ?c=.
 * - firstParam(v: string | string[] | undefined) -> string | undefined: the first of an array.
 * - categoryParam(c: string | string[] | undefined) -> Category | null | undefined:
 *   one of the seven -> it, NONE -> null (未分類), anything else -> undefined (no filter).
 */

describe("normalizeShop", () => {
  it("reads every name Amazon signs under as one 「Amazon」", () => {
    expect(normalizeShop({ shop: "Amazon.co.jp", shop_key: "amazon" })).toBe("Amazon");
    expect(normalizeShop({ shop: "アマゾン", shop_key: "amazon" })).toBe("Amazon");
    expect(normalizeShop({ shop: "Amazon", shop_key: "amazon" })).toBe("Amazon");
  });

  it("keeps any other shop as it is stored", () => {
    expect(normalizeShop({ shop: "テスト電機", shop_key: "other" })).toBe("テスト電機");
    expect(normalizeShop({ shop: "Amazon.co.jp", shop_key: "rakuten" })).toBe("Amazon.co.jp");
  });

  it("keeps the shop when there is no shop_key", () => {
    expect(normalizeShop({ shop: "テスト雑貨", shop_key: null })).toBe("テスト雑貨");
  });
});

describe("NONE", () => {
  it("is 「none」", () => {
    expect(NONE).toBe("none");
  });
});

describe("firstParam", () => {
  it("takes a string as it is", () => {
    expect(firstParam("abc")).toBe("abc");
  });

  it("takes the first of an array", () => {
    expect(firstParam(["a", "b"])).toBe("a");
  });

  it("is undefined for an empty array and for nothing", () => {
    expect(firstParam([])).toBeUndefined();
    expect(firstParam(undefined)).toBeUndefined();
  });
});

describe("categoryParam", () => {
  it("takes each of the seven as itself", () => {
    for (const c of CATEGORIES) expect(categoryParam(c), c).toBe(c);
  });

  it("reads 「none」 as 未分類 (null)", () => {
    expect(categoryParam(NONE)).toBeNull();
    expect(categoryParam("none")).toBeNull();
  });

  it("reads anything else as no filter (undefined)", () => {
    for (const c of ["toys", "", "Food", "FOOD", " food", "None", "null", "undefined"]) expect(categoryParam(c), JSON.stringify(c)).toBeUndefined();
    expect(categoryParam(undefined)).toBeUndefined();
    expect(categoryParam([])).toBeUndefined();
  });

  it("reads the first of an array", () => {
    expect(categoryParam(["none", CATEGORIES[0]])).toBeNull();
    expect(categoryParam([CATEGORIES[0], "none"])).toBe(CATEGORIES[0]);
    expect(categoryParam(["toys", CATEGORIES[0]])).toBeUndefined();
  });
});

describe("spend page uses src/lib/shop.ts", () => {
  const page = readFileSync(path.resolve(__dirname, "../../app/app/spend/page.tsx"), "utf8");

  it("imports normalizeShop, NONE and categoryParam from @/lib/shop and uses them", () => {
    for (const name of ["normalizeShop", "NONE", "categoryParam"]) {
      expect(page, name).toMatch(new RegExp(`import\\s*\\{[^}]*\\b${name}\\b[^}]*\\}\\s*from\\s*["']@/lib/shop["']`));
    }
    expect(page).toContain("normalizeShop(");
    expect(page).toContain("categoryParam(");
  });

  it("no longer spells the Amazon rule or NONE itself", () => {
    expect(page).not.toMatch(/shop_key\s*===\s*["']amazon["']/);
    expect(page).not.toMatch(/const\s+NONE\b/);
  });
});
