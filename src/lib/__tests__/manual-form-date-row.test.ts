import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ManualForm } from "@/app/app/parcels/manual-form";
import type { ParcelRow } from "@/lib/match";
import { ancestorsOf, classesOf, findAll, parseHtml } from "./html-tree";

/**
 * The same check as "puts each date field on a row of its own" in manual-form.test.ts, on one
 * parsed tree, so the parents can be compared as the same element.
 */
const edited = {
  id: "11111111-1111-4111-8111-111111111111",
  user_id: "u",
  source: "manual",
  title: "テスト用の品名",
  shop: "テスト雑貨店",
  ordered_at: "2026-10-30",
  expected_date: null,
  total_amount: null,
  category: null,
  tracking_number: null,
  carrier: null,
  requires_presence: null,
  status: "ordered",
} as unknown as ParcelRow;

describe("date fields share the column of the other fields", () => {
  for (const [screen, parcel] of [["register", null], ["edit", edited]] as const) {
    it(`${screen}: each date <label> sits in the same element as 品名 and 金額`, () => {
      const root = parseHtml(renderToStaticMarkup(createElement(ManualForm, { parcel, today: "2026-11-03" })));
      const inputs = findAll(root, (n) => n.tag === "input");
      const byName = (name: string) => inputs.filter((n) => n.attrs.name === name)[0];
      const column = ancestorsOf(byName("title"))[1];
      expect(ancestorsOf(byName("total_amount"))[1]).toBe(column);
      const dates = inputs.filter((n) => n.attrs.type === "date");
      expect(dates).toHaveLength(2);
      for (const d of dates) {
        const [label, row] = ancestorsOf(d);
        expect(label.tag).toBe("label");
        expect(row).toBe(column);
        for (const a of ancestorsOf(d)) expect(classesOf(a).filter((c) => /^grid-cols-/.test(c))).toEqual([]);
      }
    });
  }
});
