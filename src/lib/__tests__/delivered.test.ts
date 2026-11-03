import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { groupByOrderMonth } from "@/lib/delivered";
import type { ParcelRow } from "@/lib/match";

/**
 * groupByOrderMonth(parcels) -> Array<{ label: string; parcels: P[] }>
 * Delivered parcels by the month they were ordered: newest month first, labelled
 * 「2026年5月に注文」; within a month the newest order date first; parcels without an
 * order date last, under 「注文日不明」.
 */

const p = (id: string, ordered_at: string | null) => ({ id, ordered_at, status: "delivered" }) as ParcelRow;
const shape = (groups: ReturnType<typeof groupByOrderMonth>) => groups.map((g) => [g.label, g.parcels.map((x) => x.id)]);

describe("groupByOrderMonth", () => {
  it("puts the newest month on top", () => {
    const groups = groupByOrderMonth([p("a", "2026-09-10"), p("b", "2026-11-02"), p("c", "2026-10-31")]);
    expect(shape(groups)).toEqual([
      ["2026年11月に注文", ["b"]],
      ["2026年10月に注文", ["c"]],
      ["2026年9月に注文", ["a"]],
    ]);
  });

  it("orders each month newest order date first", () => {
    const groups = groupByOrderMonth([p("a", "2026-05-03"), p("b", "2026-05-28"), p("c", "2026-05-15")]);
    expect(shape(groups)).toEqual([["2026年5月に注文", ["b", "c", "a"]]]);
  });

  it("puts parcels with no order date last, as 「注文日不明」", () => {
    const groups = groupByOrderMonth([p("x", null), p("a", "2026-05-03"), p("y", null)]);
    expect(groups.map((g) => g.label)).toEqual(["2026年5月に注文", "注文日不明"]);
    expect(groups[1].parcels.map((q) => q.id).sort()).toEqual(["x", "y"]);
  });

  it("does not mix the same month of different years", () => {
    const groups = groupByOrderMonth([p("old", "2025-05-20"), p("new", "2026-05-01")]);
    expect(shape(groups)).toEqual([
      ["2026年5月に注文", ["new"]],
      ["2025年5月に注文", ["old"]],
    ]);
  });

  it("returns no groups for no parcels", () => {
    expect(groupByOrderMonth([])).toEqual([]);
  });

  it("keeps every parcel exactly once", () => {
    const input = Array.from({ length: 50 }, (_, i) => p(`id${i}`, i % 7 === 0 ? null : `202${5 + (i % 2)}-${String((i % 12) + 1).padStart(2, "0")}-${String((i % 27) + 1).padStart(2, "0")}`));
    const ids = groupByOrderMonth(input).flatMap((g) => g.parcels.map((q) => q.id));
    expect(ids.sort()).toEqual(input.map((q) => q.id).sort());
  });
});

describe("delivered page wiring", () => {
  const read = (rel: string) => readFileSync(path.resolve(__dirname, "../../app/app", rel), "utf8");

  it("reads every delivered parcel with readAll and says 「読み込めませんでした」 on failure", () => {
    const page = read("delivered/page.tsx");
    expect(page).toContain("readAll");
    expect(page).toContain("groupByOrderMonth");
    expect(page).toContain("読み込めませんでした");
  });

  it("drops 「届いた（30 日）」 from the parcel list and links to the delivered page", () => {
    const list = read("page.tsx");
    expect(list).not.toContain("届いた（30 日）");
    expect(list).toContain("DeliveredLink");
  });

  it("keeps the 荷物 tab selected on /app/delivered", () => {
    expect(read("tab-bar.tsx")).toContain("/app/delivered");
  });
});
