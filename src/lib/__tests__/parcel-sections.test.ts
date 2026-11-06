import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ParcelRow } from "@/lib/match";
import { byNextArrival, parcelSections } from "@/lib/parcel-sections";

/**
 * [iOS batch 1, task 2] The list's sections and the order of 「もうすぐ届く」 move from
 * src/app/app/page.tsx into src/lib/parcel-sections.ts so the iOS app can be checked against them.
 * The move must not change what the list shows: every expectation here is worked out by hand
 * from page.tsx as it was before the move (lines 48-55 and byNextArrival at 156-159).
 *
 * Contract:
 *   parcelSections(parcels, today) -> { open, toCheck, delivering, soon, ordered }
 *     open       = not delivered and not cancelled, in the order given
 *     toCheck    = open && needsCheck, in the order given
 *     delivering = open && !needsCheck && out_for_delivery && !isLate, in the order given
 *     ordered    = open && !needsCheck && (ordered | unknown) && !isLate, in the order given
 *     soon       = the rest of open && !needsCheck, sorted by byNextArrival(today) (a stable sort)
 *   byNextArrival(today) -> comparator: date still ahead (rank 0), then late (1), then no date (2);
 *     within a rank by expected_date as text.
 */

const TODAY = "2026-11-04"; // a Wednesday; two weeks back is 2026-10-21

let seq = 0;
function row(title: string, over: Partial<ParcelRow>): ParcelRow {
  seq += 1;
  return {
    id: `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`,
    user_id: "00000000-0000-4000-8000-0000000000aa",
    shop: "テスト店",
    shop_key: null,
    title,
    status: "shipped",
    source: "mail",
    category: null,
    category_source: null,
    carrier: null,
    tracking_number: null,
    tracking_url: null,
    order_number: null,
    ordered_at: null,
    expected_date: null,
    expected_date_end: null,
    expected_text: null,
    expected_window_start: null,
    expected_window_end: null,
    last_email_at: null,
    needs_review: false,
    requires_presence: null,
    presence_evidence: null,
    total_amount: null,
    created_at: "2026-11-01T00:00:00+00:00",
    updated_at: "2026-11-01T00:00:00.000000+00:00",
    ...over,
  };
}

const titles = (xs: ParcelRow[]) => xs.map((p) => p.title);

describe("parcelSections", () => {
  it("leaves delivered and cancelled parcels out of every section", () => {
    const rows = [
      row("delivered", { status: "delivered", expected_date: "2026-11-01" }),
      row("cancelled", { status: "cancelled", expected_date: "2026-11-05" }),
      row("shipped", { status: "shipped", expected_date: "2026-11-05" }),
    ];
    const s = parcelSections(rows, TODAY);
    expect(titles(s.open)).toEqual(["shipped"]);
    expect(titles(s.toCheck)).toEqual([]);
    expect(titles(s.delivering)).toEqual([]);
    expect(titles(s.ordered)).toEqual([]);
    expect(titles(s.soon)).toEqual(["shipped"]);
  });

  it("asks about a parcel 14 days or more past its last day, and not at 13", () => {
    const rows = [
      row("15 days", { expected_date: "2026-10-20" }),
      row("14 days", { expected_date: "2026-10-21" }),
      row("13 days", { expected_date: "2026-10-22" }),
      row("window ends 13 days ago", { expected_date: "2026-10-01", expected_date_end: "2026-10-22" }),
      row("ordered long ago", { status: "ordered", expected_date: "2026-10-20" }),
    ];
    const s = parcelSections(rows, TODAY);
    expect(titles(s.toCheck)).toEqual(["15 days", "14 days", "ordered long ago"]);
    // Not asked yet, but late: on its way in 「もうすぐ届く」.
    expect(titles(s.soon)).toEqual(["window ends 13 days ago", "13 days"]);
  });

  it("without a date, counts two weeks from the last mail's day in JST", () => {
    const rows = [
      // 2026-10-21 23:59:59 JST: on the cutoff day.
      row("mail on the cutoff day", { last_email_at: "2026-10-21T14:59:59Z" }),
      // 2026-10-22 00:00:00 JST: the next day.
      row("mail a day after", { last_email_at: "2026-10-21T15:00:00Z" }),
      row("no mail time", { last_email_at: null }),
    ];
    const s = parcelSections(rows, TODAY);
    expect(titles(s.toCheck)).toEqual(["mail on the cutoff day"]);
    expect(titles(s.soon)).toEqual(["mail a day after", "no mail time"]);
  });

  it("puts out-for-delivery in 配達中 unless late, and ordered/unknown in 注文中 unless late", () => {
    const rows = [
      row("ofd today", { status: "out_for_delivery", expected_date: "2026-11-04" }),
      row("ofd late", { status: "out_for_delivery", expected_date: "2026-11-03" }),
      row("ofd no date", { status: "out_for_delivery" }),
      row("ordered ahead", { status: "ordered", expected_date: "2026-11-10" }),
      row("unknown no date", { status: "unknown" }),
      row("ordered late", { status: "ordered", expected_date: "2026-11-02" }),
      row("attempted", { status: "attempted", expected_date: "2026-11-05" }),
    ];
    const s = parcelSections(rows, TODAY);
    expect(titles(s.delivering)).toEqual(["ofd today", "ofd no date"]);
    expect(titles(s.ordered)).toEqual(["ordered ahead", "unknown no date"]);
    expect(titles(s.soon)).toEqual(["attempted", "ordered late", "ofd late"]);
    expect(titles(s.open)).toEqual(titles(rows));
  });

  it("orders 「もうすぐ届く」 by next arrival: ahead, then late, then no date; ties keep the given order", () => {
    const rows = [
      row("late 11/2", { expected_date: "2026-11-02" }),
      row("no date 1", {}),
      row("ahead 11/6", { expected_date: "2026-11-06" }),
      row("ahead 11/5 first", { expected_date: "2026-11-05" }),
      row("late 11/1", { expected_date: "2026-11-01" }),
      row("no date 2", {}),
      row("ahead 11/5 second", { expected_date: "2026-11-05" }),
      // A window that started in the past and ends on or after today is still ahead.
      row("window 11/1-11/5", { expected_date: "2026-11-01", expected_date_end: "2026-11-05" }),
    ];
    const expected = [
      "window 11/1-11/5",
      "ahead 11/5 first",
      "ahead 11/5 second",
      "ahead 11/6",
      "late 11/1",
      "late 11/2",
      "no date 1",
      "no date 2",
    ];
    expect(titles(parcelSections(rows, TODAY).soon)).toEqual(expected);
    expect(titles([...rows].sort(byNextArrival(TODAY)))).toEqual(expected);
  });

  it("keeps the given order inside 要確認, 配達中 and 注文中", () => {
    const rows = [
      row("check b", { expected_date: "2026-10-01" }),
      row("ordered b", { status: "ordered", expected_date: "2026-11-20" }),
      row("ofd b", { status: "out_for_delivery", expected_date: "2026-11-09" }),
      row("check a", { expected_date: "2026-09-01" }),
      row("ordered a", { status: "ordered", expected_date: "2026-11-10" }),
      row("ofd a", { status: "out_for_delivery", expected_date: "2026-11-05" }),
    ];
    const s = parcelSections(rows, TODAY);
    expect(titles(s.toCheck)).toEqual(["check b", "check a"]);
    expect(titles(s.ordered)).toEqual(["ordered b", "ordered a"]);
    expect(titles(s.delivering)).toEqual(["ofd b", "ofd a"]);
  });

  it("answers empty sections for no parcels", () => {
    const s = parcelSections([], TODAY);
    expect(s).toEqual({ open: [], toCheck: [], delivering: [], soon: [], ordered: [] });
  });
});

describe("the parcel list page uses the moved functions", () => {
  const page = readFileSync(path.resolve(__dirname, "../../app/app/page.tsx"), "utf8");

  it("imports parcelSections from @/lib/parcel-sections", () => {
    expect(page).toMatch(/import\s*\{[^}]*\bparcelSections\b[^}]*\}\s*from\s*"@\/lib\/parcel-sections"/);
  });

  it("no longer keeps its own copy of byNextArrival or the section filters", () => {
    expect(page).not.toMatch(/function\s+byNextArrival\b/);
    expect(page).not.toMatch(/\.filter\(\(p\)\s*=>\s*needsCheck\(/);
  });
});
