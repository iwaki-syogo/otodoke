import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { acceptAnswers, affordableCount, createBudget, estimateCallUsd, parseCategorizeArgs, toBatches } from "@/lib/categorize";
import { PRICES } from "../../../scripts/prices";

/**
 * Pure parts of the one-off categorizer (src/lib/categorize.ts; the script is scripts/categorize.ts):
 * - toBatches(items, size = 40): consecutive groups of at most `size`.
 * - acceptAnswers(batchIds, answers) -> Map<id, Category>: keeps an answer only when its id is in
 *   the batch, it is answered once, and the category is one of the seven. A bad entry is dropped
 *   on its own; a malformed answer as a whole gives an empty map.
 * - estimateCallUsd({ inputChars, maxTokens }, price): a generous estimate made before the call
 *   (at least one input token per character, plus max_tokens of output).
 * - createBudget(maxUsd): reserve(usd) -> boolean (false, and nothing reserved, when it would go
 *   over); settle(reservedUsd, actualUsd) swaps a reservation for the real cost; spent().
 *   A failed call whose charge is unknown is never settled, so its reservation stays counted.
 * - affordableCount(items, estimate, leftUsd): how many items from the front of a batch fit in
 *   what is left (0 means stop before sending anything).
 * - parseCategorizeArgs(argv): { user, apply, maxUsd }; dry run by default; --apply needs --max-usd.
 */

describe("toBatches", () => {
  const ids = (n: number) => Array.from({ length: n }, (_, i) => `id-${i}`);

  it("makes no batch for no parcels", () => {
    expect(toBatches(ids(0))).toEqual([]);
  });
  it("makes one batch of 40", () => {
    const b = toBatches(ids(40));
    expect(b.map((x) => x.length)).toEqual([40]);
  });
  it("splits 41 into 40 and 1, in order", () => {
    const b = toBatches(ids(41));
    expect(b.map((x) => x.length)).toEqual([40, 1]);
    expect(b.flat()).toEqual(ids(41));
  });
});

describe("acceptAnswers", () => {
  const batch = ["a", "b", "c", "d"];

  it("keeps answers for ids in the batch with one of the seven categories", () => {
    const m = acceptAnswers(batch, [
      { id: "a", category: "food" },
      { id: "b", category: "electronics" },
    ]);
    expect(Object.fromEntries(m)).toEqual({ a: "food", b: "electronics" });
  });

  it("drops an id that is not in the batch", () => {
    expect([...acceptAnswers(batch, [{ id: "zzz", category: "food" }]).keys()]).toEqual([]);
  });

  it("drops an id answered twice", () => {
    const m = acceptAnswers(batch, [
      { id: "a", category: "food" },
      { id: "a", category: "hobby" },
      { id: "b", category: "daily" },
    ]);
    expect(m.has("a")).toBe(false);
    expect(m.get("b")).toBe("daily");
  });

  it("drops a category outside the seven, and null, leaving the parcel uncategorised", () => {
    const m = acceptAnswers(batch, [
      { id: "a", category: "toys" },
      { id: "b", category: null },
      { id: "c", category: "beauty" },
    ]);
    expect(Object.fromEntries(m)).toEqual({ c: "beauty" });
  });

  it("drops a malformed entry without losing the others", () => {
    const m = acceptAnswers(batch, [{ category: "food" }, "a", null, { id: 3, category: "food" }, { id: "d", category: "other" }]);
    expect(Object.fromEntries(m)).toEqual({ d: "other" });
  });

  it("gives nothing for an answer that is not a list", () => {
    expect(acceptAnswers(batch, { a: "food" }).size).toBe(0);
    expect(acceptAnswers(batch, null).size).toBe(0);
  });
});

describe("cost guard", () => {
  const haiku = PRICES["claude-haiku-5-5"];

  it("estimates at least one token per character plus max_tokens of output", () => {
    const usd = estimateCallUsd({ inputChars: 12_000, maxTokens: 2_000 }, haiku);
    const floor = (12_000 * haiku[0] + 2_000 * haiku[1]) / 1_000_000;
    expect(usd).toBeGreaterThanOrEqual(floor);
  });

  it("estimates more for more text", () => {
    expect(estimateCallUsd({ inputChars: 20_000, maxTokens: 2_000 }, haiku)).toBeGreaterThan(estimateCallUsd({ inputChars: 10_000, maxTokens: 2_000 }, haiku));
  });

  it("stops before a call whose estimate would pass the limit", () => {
    const budget = createBudget(1);
    expect(budget.reserve(0.6)).toBe(true);
    expect(budget.reserve(0.5)).toBe(false);
    expect(budget.spent()).toBeCloseTo(0.6, 9);
    expect(budget.reserve(0.4)).toBe(true);
    expect(budget.spent()).toBeCloseTo(1, 9);
  });

  it("swaps a reservation for the real cost after a call", () => {
    const budget = createBudget(1);
    budget.reserve(0.6);
    budget.settle(0.6, 0.1);
    expect(budget.spent()).toBeCloseTo(0.1, 9);
    expect(budget.reserve(0.8)).toBe(true);
  });

  it("keeps the reservation of a failed call counted", () => {
    const budget = createBudget(1);
    budget.reserve(0.7); // the call fails; we cannot tell whether it was charged
    expect(budget.reserve(0.4)).toBe(false);
    expect(budget.spent()).toBeCloseTo(0.7, 9);
  });

  it("sends a smaller batch when the whole one does not fit, and nothing when one item does not", () => {
    const items = Array.from({ length: 40 }, (_, i) => i);
    const perItem = (xs: number[]) => xs.length * 0.01;
    expect(affordableCount(items, perItem, 1)).toBe(40);
    expect(affordableCount(items, perItem, 0.155)).toBe(15);
    expect(affordableCount(items, perItem, 0.005)).toBe(0);
  });
});

describe("parseCategorizeArgs", () => {
  it("needs --user", () => {
    expect(() => parseCategorizeArgs([])).toThrow();
  });

  it("is a dry run by default", () => {
    expect(parseCategorizeArgs(["--user", "someone@example.test"])).toMatchObject({ user: "someone@example.test", apply: false });
    expect(parseCategorizeArgs(["--user", "someone@example.test", "--dry-run"])).toMatchObject({ apply: false });
  });

  it("needs --max-usd with --apply", () => {
    expect(() => parseCategorizeArgs(["--user", "someone@example.test", "--apply"])).toThrow();
    expect(parseCategorizeArgs(["--user", "someone@example.test", "--apply", "--max-usd", "0.5"])).toMatchObject({ apply: true, maxUsd: 0.5 });
  });

  it("refuses a limit that is not a positive number", () => {
    for (const v of ["abc", "0", "-1", ""]) expect(() => parseCategorizeArgs(["--user", "someone@example.test", "--apply", "--max-usd", v]), v).toThrow();
  });
});

describe("shared prices", () => {
  it("moves PRICES to scripts/prices.ts unchanged", () => {
    expect(PRICES["claude-haiku-5-5"]).toEqual([0.1, 0.5, 0.01, 0.125]);
    expect(PRICES["claude-sonnet-5-5"]).toEqual([2, 10, 0.1, 2.5]);
    expect(PRICES["claude-opus-5-5"]).toEqual([4, 20, 0.2, 5]);
  });

  it("has eval.ts use the shared table instead of its own", () => {
    const evalSource = readFileSync(path.resolve(__dirname, "../../../scripts/eval.ts"), "utf8");
    expect(evalSource).toMatch(/import\s*\{[^}]*\bPRICES\b[^}]*\}\s*from\s*["']\.\/prices(\.ts)?["']/);
    expect(evalSource).not.toMatch(/const\s+PRICES\b/);
  });

  it("writes the record of changed ids under fixtures/raw/ only", () => {
    const script = readFileSync(path.resolve(__dirname, "../../../scripts/categorize.ts"), "utf8");
    expect(script).toMatch(/fixtures["'`]?\s*[,/]\s*["'`]?raw\b/);
    expect(script).not.toMatch(/@[a-z0-9-]+\.(com|jp|net|org)\b/i);
  });
});
