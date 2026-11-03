import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { spendByMonth, spendMonthParam, spendTotal, withEmptyMonths } from "@/lib/spend";

/** Review follow-ups on the spend screen: [SEC-N6] the month in ?m=, [QA-6] the total card, [N5] the bars. */

const p = (ordered_at: string | null, total_amount: number | null, category: string | null = "food") => ({ ordered_at, total_amount, category });

describe("[SEC-N6] spendMonthParam", () => {
  it("takes a month of 01 to 12", () => {
    expect(spendMonthParam("2026-01", "2026-11-03")).toBe("2026-01");
    expect(spendMonthParam("2025-12", "2026-11-03")).toBe("2025-12");
  });

  it("falls back to this month for anything else", () => {
    for (const m of ["2026-13", "2026-00", "2026-1", "2026-011", "all", "", undefined]) {
      expect(spendMonthParam(m, "2026-11-03"), String(m)).toBe("2026-11");
    }
  });
});

describe("[QA-6] spendTotal", () => {
  it("sums the amounts read and counts the rest", () => {
    expect(spendTotal([p("2026-11-01", 1000), p("2026-11-02", 0), p("2026-11-03", null)])).toEqual({ total: 1000, priced: 2, unpriced: 1 });
    expect(spendTotal([])).toEqual({ total: 0, priced: 0, unpriced: 0 });
  });

  it("is given the parcels both ?c= and ?s= narrow (spendSlices' picked), for a month and for the whole period", () => {
    const page = readFileSync(path.resolve(__dirname, "../../app/app/spend/page.tsx"), "utf8");
    expect(page).toContain("spendSlices(");
    expect(page).toMatch(/spendTotal\(\s*(?:\w+\.)?picked\s*\)/);
    // The old rule narrowed the total over the whole period only.
    expect(page).not.toMatch(/narrowed\s*\?\s*picked\s*:\s*counted/);
    expect(page).not.toMatch(/const narrowed = all && only !== undefined/);
  });
});

describe("[N5] withEmptyMonths", () => {
  it("puts every month between the first and the last on the axis, empty ones as 0", () => {
    const months = withEmptyMonths(spendByMonth([p("2026-03-10", 2000), p("2026-06-01", 500, "hobby")]));
    expect(months.map((m) => [m.month, m.total])).toEqual([
      ["2026-03", 2000],
      ["2026-04", 0],
      ["2026-05", 0],
      ["2026-06", 500],
    ]);
    expect(months[1].segments).toEqual([]);
  });

  it("crosses a year", () => {
    const months = withEmptyMonths(spendByMonth([p("2025-11-01", 100), p("2026-02-01", 200)]));
    expect(months.map((m) => m.month)).toEqual(["2025-11", "2025-12", "2026-01", "2026-02"]);
  });

  it("leaves zero or one month as it is", () => {
    expect(withEmptyMonths([])).toEqual([]);
    expect(withEmptyMonths(spendByMonth([p("2026-11-01", 100)])).map((m) => m.month)).toEqual(["2026-11"]);
  });

  it("does not fill a run of decades a stray year would make", () => {
    const months = withEmptyMonths(spendByMonth([p("1990-01-01", 100), p("2026-11-01", 200)]));
    expect(months.map((m) => m.month)).toEqual(["1990-01", "2026-11"]);
  });

  it("is what the whole-period bars draw, from the parcels both ?c= and ?s= narrow", () => {
    const page = readFileSync(path.resolve(__dirname, "../../app/app/spend/page.tsx"), "utf8");
    expect(page).toMatch(/withEmptyMonths\(spendByMonth\(\s*(?:\w+\.)?picked\s*\)\)/);
  });
});
