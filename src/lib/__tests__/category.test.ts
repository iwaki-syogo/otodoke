import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CATEGORIES,
  CATEGORY_SOURCES,
  PARCEL_SOURCES,
  UNCATEGORIZED_LABEL,
  categoryColor,
  categoryLabel,
  isCategory,
  type Category,
} from "@/lib/category";

const KEYS = ["food", "daily", "hobby", "fashion", "electronics", "beauty", "other"] as const;
const LABELS: Record<(typeof KEYS)[number], string> = {
  food: "食費",
  daily: "日用品",
  hobby: "趣味・レジャー",
  fashion: "ファッション",
  electronics: "家電・ガジェット",
  beauty: "美容・健康",
  other: "その他",
};

describe("category definition", () => {
  it("has exactly the seven keys, in this order", () => {
    expect([...CATEGORIES]).toEqual([...KEYS]);
  });

  it("accepts only the seven keys", () => {
    for (const k of KEYS) expect(isCategory(k)).toBe(true);
    for (const v of ["", "Food", "FOOD", "toys", "unknown", " food", "food ", null, undefined, 1, {}, ["food"]]) {
      expect(isCategory(v), JSON.stringify(v)).toBe(false);
    }
  });

  it("names every category, and null as 未分類", () => {
    for (const k of KEYS) expect(categoryLabel(k)).toBe(LABELS[k]);
    expect(categoryLabel(null)).toBe("未分類");
    expect(UNCATEGORIZED_LABEL).toBe("未分類");
  });

  it("gives every category and 未分類 its own colour", () => {
    const colours = [...KEYS.map((k) => categoryColor(k as Category)), categoryColor(null)];
    for (const c of colours) {
      expect(typeof c).toBe("string");
      expect(c.length).toBeGreaterThan(0);
    }
    expect(new Set(colours).size).toBe(KEYS.length + 1);
  });

  it("lists who set a category and where a parcel came from", () => {
    expect([...CATEGORY_SOURCES]).toEqual(["auto", "user"]);
    expect([...PARCEL_SOURCES]).toEqual(["mail", "manual"]);
  });
});

/** The keys and names live in src/lib/category.ts only; everything else imports them. */
describe("one place for the category definition", () => {
  const SRC = path.resolve(__dirname, "../..");
  const OWNER = path.join(SRC, "lib", "category.ts");
  const TESTS = path.join(SRC, "lib", "__tests__");

  function sourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const p = path.join(dir, name);
      if (statSync(p).isDirectory()) return p === TESTS ? [] : sourceFiles(p);
      return /\.(ts|tsx)$/.test(name) && p !== OWNER ? [p] : [];
    });
  }

  // "food", "daily", "hobby" and "other" are ordinary words (shop_key uses "other"), so only the
  // keys that mean nothing else are checked, plus every display name written as a whole string.
  const KEY_LITERAL = /(["'`])(electronics|fashion|beauty)\1/;
  const LABEL_LITERAL = new RegExp(`(["'\`])(${Object.values(LABELS).filter((l) => l !== "その他").join("|")})\\1`);

  it("no other source file spells out the keys or the names", () => {
    const offenders = sourceFiles(SRC).filter((file) => {
      const text = readFileSync(file, "utf8");
      return KEY_LITERAL.test(text) || LABEL_LITERAL.test(text);
    });
    expect(offenders.map((f) => path.relative(SRC, f))).toEqual([]);
  });
});
