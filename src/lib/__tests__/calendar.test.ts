import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { upcomingByDay } from "@/lib/calendar";
import type { ParcelRow } from "@/lib/match";
import { findAll, hasClasses, linksTo, parseHtml, textOf } from "./html-tree";

/**
 * upcomingByDay(parcels, today, first, last): the calendar's parcels from today on, grouped by
 * the day they are listed under. Returns a Map "YYYY-MM-DD" -> parcels (input order kept).
 * A parcel is listed while its last expected day is today or later, and not when delivered or
 * cancelled. A window that runs across today is listed on max(first day of the window, today,
 * first day of the month). Days outside the month are not listed.
 */

const TODAY = "2026-11-03";
const NOV = { first: "2026-11-01", last: "2026-11-30" };
const DEC = { first: "2026-12-01", last: "2026-12-31" };
const OCT = { first: "2026-10-01", last: "2026-10-31" };

let n = 0;
function p(over: Partial<ParcelRow>): ParcelRow {
  return { id: `p${++n}`, status: "shipped", expected_date: null, expected_date_end: null, ...over } as ParcelRow;
}

const days = (m: Map<string, ParcelRow[]>) => [...m.keys()].sort();
const idsOn = (m: Map<string, ParcelRow[]>, day: string) => (m.get(day) ?? []).map((x) => x.id);

describe("upcomingByDay", () => {
  it("lists a window that runs across today under today", () => {
    const w = p({ expected_date: "2026-11-01", expected_date_end: "2026-11-05" });
    const m = upcomingByDay([w], TODAY, NOV.first, NOV.last);
    expect(days(m)).toEqual([TODAY]);
    expect(idsOn(m, TODAY)).toEqual([w.id]);
  });

  it("drops a parcel whose last day was yesterday", () => {
    const one = p({ expected_date: "2026-11-02" });
    const window = p({ expected_date: "2026-10-30", expected_date_end: "2026-11-02" });
    expect(days(upcomingByDay([one, window], TODAY, NOV.first, NOV.last))).toEqual([]);
  });

  it("keeps a parcel whose last day is today", () => {
    const one = p({ expected_date: TODAY });
    const window = p({ expected_date: "2026-10-28", expected_date_end: TODAY });
    const m = upcomingByDay([one, window], TODAY, NOV.first, NOV.last);
    expect(days(m)).toEqual([TODAY]);
    expect(idsOn(m, TODAY)).toEqual([one.id, window.id]);
  });

  it("leaves out delivered and cancelled parcels, even with a date ahead", () => {
    const delivered = p({ status: "delivered", expected_date: "2026-11-10" });
    const cancelled = p({ status: "cancelled", expected_date: "2026-11-10" });
    const open = p({ status: "ordered", expected_date: "2026-11-10" });
    const m = upcomingByDay([delivered, cancelled, open], TODAY, NOV.first, NOV.last);
    expect(days(m)).toEqual(["2026-11-10"]);
    expect(idsOn(m, "2026-11-10")).toEqual([open.id]);
  });

  it("lists a window that began before the month on the month's first day", () => {
    const w = p({ expected_date: "2026-11-28", expected_date_end: "2026-12-03" });
    const m = upcomingByDay([w], TODAY, DEC.first, DEC.last);
    expect(days(m)).toEqual([DEC.first]);
  });

  it("lists a future single date on its own day", () => {
    const a = p({ expected_date: "2026-11-20" });
    const b = p({ expected_date: "2026-11-20" });
    const c = p({ expected_date: "2026-11-04" });
    const m = upcomingByDay([a, b, c], TODAY, NOV.first, NOV.last);
    expect(days(m)).toEqual(["2026-11-04", "2026-11-20"]);
    expect(idsOn(m, "2026-11-20")).toEqual([a.id, b.id]);
  });

  it("lists nothing for a month that is already over", () => {
    const old = p({ expected_date: "2026-10-15" });
    expect(days(upcomingByDay([old], TODAY, OCT.first, OCT.last))).toEqual([]);
  });

  it("never lists a day before today, so past cells get no link", () => {
    const parcels = [
      p({ expected_date: "2026-11-01" }),
      p({ expected_date: "2026-11-01", expected_date_end: "2026-11-09" }),
      p({ expected_date: "2026-10-20", expected_date_end: "2026-11-03" }),
      p({ expected_date: "2026-11-15" }),
    ];
    for (const day of days(upcomingByDay(parcels, TODAY, NOV.first, NOV.last))) expect(day >= TODAY, day).toBe(true);
  });

  it("does not list days outside the month", () => {
    const next = p({ expected_date: "2026-12-02" });
    expect(days(upcomingByDay([next], TODAY, NOV.first, NOV.last))).toEqual([]);
  });

  it("does not list a parcel with no expected date", () => {
    expect(days(upcomingByDay([p({ expected_date: null })], TODAY, NOV.first, NOV.last))).toEqual([]);
  });
});

/**
 * PageLink({ href, label, count? }) from src/app/app/page-link.tsx (replaces DeliveredLink): a
 * framed row that is one link as a whole, the label underlined, and on the right the count (only
 * when given, as 「1,234 件」) and 「›」. Used for 届いた荷物 and キャンセルした荷物 in the list and
 * 届いた荷物 in the calendar.
 */
describe("PageLink", () => {
  type Props = { href: string; label: string; count?: number };
  const render = async (props: Props) => {
    const { PageLink } = (await import("@/app/app/page-link")) as unknown as { PageLink: (p: Props) => ReturnType<typeof createElement> };
    return parseHtml(renderToStaticMarkup(createElement(PageLink, props)));
  };

  it("is one framed link to the href that holds the whole row", async () => {
    const root = await render({ href: "/app/delivered", label: "届いた荷物" });
    const links = findAll(root, (n) => n.tag === "a");
    expect(links).toHaveLength(1);
    expect(linksTo(root, "/app/delivered")).toHaveLength(1);
    // Nothing of the row is outside the link.
    expect(textOf(links[0])).toBe(textOf(root));
    expect(hasClasses(links[0], "rounded-xl", "border", "border-neutral-200", "bg-white", "px-4", "py-3"), links[0].attrs.class).toBe(true);
  });

  it("underlines the label, and only the label", async () => {
    const root = await render({ href: "/app/delivered", label: "届いた荷物", count: 12 });
    const underlined = findAll(root, (n) => hasClasses(n, "underline", "underline-offset-4"));
    expect(underlined.map((n) => textOf(n).trim())).toEqual(["届いた荷物"]);
  });

  it("puts the count and 「›」 to the right of the label", async () => {
    const text = textOf(await render({ href: "/app/cancelled", label: "キャンセルした荷物", count: 1234 }));
    expect(text).toMatch(/^\s*キャンセルした荷物\s*1,234\s*件\s*›\s*$/);
  });

  it("shows 0 as 「0 件」", async () => {
    expect(textOf(await render({ href: "/app/cancelled", label: "キャンセルした荷物", count: 0 }))).toMatch(/0\s*件/);
  });

  it("shows no count without one", async () => {
    const text = textOf(await render({ href: "/app/delivered", label: "届いた荷物" }));
    expect(text).toMatch(/^\s*届いた荷物\s*›\s*$/);
    expect(text).not.toContain("件");
  });
});

describe("calendar page", () => {
  const source = readFileSync(path.resolve(__dirname, "../../app/app/calendar/page.tsx"), "utf8");

  it("draws from upcomingByDay and offers 「届いた荷物 ›」 as a PageLink without a count", () => {
    expect(source).toContain("upcomingByDay");
    expect(source).toMatch(/import\s*\{\s*PageLink\s*\}\s*from\s*["']\.\.\/page-link["']/);
    const uses = source.match(/<PageLink\b[^>]*\/>/g) ?? [];
    expect(uses).toHaveLength(1);
    expect(uses[0]).toMatch(/href=\{?\s*["']\/app\/delivered["']/);
    expect(uses[0]).toMatch(/label=\{?\s*["']届いた荷物["']/);
    expect(uses[0]).not.toMatch(/\bcount=/);
    expect(source).not.toContain("DeliveredLink");
  });

  it("says 「この月の予定はありません」 for a month with nothing ahead", () => {
    expect(source).toContain("この月の予定はありません");
  });
});
