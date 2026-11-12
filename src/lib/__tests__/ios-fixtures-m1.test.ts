import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { upcomingByDay } from "@/lib/calendar";
import { addDays, daysInMonth, monthLabel, monthOf, monthParam, shiftMonth, splitDate, weekdayOf } from "@/lib/format";
import { forwardingConfirmUrl, isForwardingConfirmation } from "@/lib/forwarding";
import { faceToFaceAssumed, type ParcelRow } from "@/lib/match";
import { MONTH_MIN, monthMax } from "@/lib/month-url";
import { NONE, SHOP_LABEL_MAX, categoryParam, firstParam, normalizeShop, shopLabel } from "@/lib/shop";
import {
  axisTicks,
  categoryOf,
  sharePercent,
  spendByCategory,
  spendByMonth,
  spendMonthParam,
  spendSlices,
  spendTotal,
  tickLabel,
  withEmptyMonths,
} from "@/lib/spend";
import { htmlToText } from "@/lib/text/html-to-text";

/**
 * [iOS batch 2, task 4] The sections scripts/ios-fixtures.ts adds for M1, which the Swift differential
 * tests (WebParity3Tests, PresenceAssumedTests, WebParity2Tests.htmlToText) read:
 *   calendar, spend, shop, month, forwarding, match.faceToFaceAssumed, and more htmlToText cases.
 * Pins the key and field names (ios/OtodokeTests/Support/WebExpectedM1.swift decodes the same), that every
 * out is what the TS function answers, and that the cases the plan asks for are there (JS quirks:
 * code-unit order, stable sort, Math.log10, toLocaleString's one decimal, the 240-month cap, the year
 * boundary, today fixed; CX4's refusals; the hostile HTML of 2541793). Task 4 also moves tickLabel from
 * month-bars.tsx to src/lib/spend.ts without changing it.
 * The time-zone independence and the file being the script's current output are pinned by
 * ios-fixtures.test.ts for the whole file.
 */

const ROOT = path.resolve(__dirname, "../../..");
const SCRIPT = path.join(ROOT, "scripts/ios-fixtures.ts");
const TSX = path.join(ROOT, "node_modules/.bin/tsx");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

let fx: Any = null;

beforeAll(() => {
  fx = JSON.parse(execFileSync(TSX, [SCRIPT, "--stdout"], { cwd: ROOT, env: { ...process.env, TZ: "UTC" }, encoding: "utf8", timeout: 60_000 }));
}, 120_000);

afterEach(() => {
  vi.useRealTimers();
});

function freezeAt(today: string) {
  vi.useFakeTimers({ now: new Date(`${today}T03:00:00Z`), toFake: ["Date"] });
}

const PARCEL_COLUMNS = [
  "carrier", "category", "category_source", "check_dismissed_at", "received_at", "created_at", "expected_date", "expected_date_end", "expected_text",
  "expected_window_end", "expected_window_start", "id", "last_email_at", "needs_review", "order_number", "ordered_at",
  "presence_evidence", "requires_presence", "shop", "shop_key", "source", "status", "title", "total_amount",
  "tracking_number", "tracking_url", "updated_at", "user_id",
];

/** Every entry has exactly these keys (null written out, never left undefined: Swift decodes them). */
function fields(xs: Any[], keys: string[]) {
  expect(Array.isArray(xs)).toBe(true);
  expect(xs.length).toBeGreaterThan(0);
  for (const x of xs) expect(Object.keys(x).sort(), JSON.stringify(x).slice(0, 160)).toEqual([...keys].sort());
}

const ids = (xs: ParcelRow[]) => xs.map((p) => p.id);
const filterOf = (c: { c: string | null; cSet: boolean }) => (c.cSet ? (c.c as Any) : undefined);

describe("the M1 sections: names", () => {
  it("has the agreed keys", () => {
    expect(Object.keys(fx.calendar).sort()).toEqual(["upcomingByDay"]);
    expect(Object.keys(fx.spend).sort()).toEqual(
      ["spendMonthParam", "spendTotal", "categoryOf", "spendByCategory", "sharePercent", "spendByMonth", "withEmptyMonths", "axisTicks", "tickLabel", "spendSlices"].sort(),
    );
    expect(Object.keys(fx.shop).sort()).toEqual(["none", "labelMax", "normalizeShop", "shopLabel", "firstParam", "categoryParam"].sort());
    expect(Object.keys(fx.month).sort()).toEqual(
      ["min", "monthMax", "monthOf", "monthLabel", "monthParam", "shiftMonth", "splitDate", "weekdayOf", "addDays", "daysInMonth"].sort(),
    );
    expect(Object.keys(fx.forwarding).sort()).toEqual(["isForwardingConfirmation", "forwardingConfirmUrl", "confirmUrl"].sort());
    expect(Array.isArray(fx.match.faceToFaceAssumed)).toBe(true);
  });

  it("has entries with the agreed field names", () => {
    fields(fx.calendar.upcomingByDay, ["today", "first", "last", "parcels", "out"]);
    fields(fx.spend.spendMonthParam, ["m", "today", "out"]);
    fields(fx.spend.spendTotal, ["parcels", "out"]);
    for (const c of fx.spend.spendTotal) expect(Object.keys(c.out).sort()).toEqual(["priced", "total", "unpriced"]);
    fields(fx.spend.categoryOf, ["in", "out"]);
    fields(fx.spend.spendByCategory, ["parcels", "out"]);
    for (const c of fx.spend.spendByCategory) for (const r of c.out) expect(Object.keys(r).sort()).toEqual(["amount", "category", "share"]);
    fields(fx.spend.sharePercent, ["in", "out"]);
    fields(fx.spend.spendByMonth, ["parcels", "out"]);
    fields(fx.spend.withEmptyMonths, ["in", "out"]);
    fields(fx.spend.axisTicks, ["in", "out"]);
    fields(fx.spend.tickLabel, ["in", "out"]);
    fields(fx.spend.spendSlices, ["parcels", "all", "c", "cSet", "s", "out"]);
    for (const c of fx.spend.spendSlices) expect(Object.keys(c.out).sort()).toEqual(["byCategory", "byShop", "orders", "picked", "undated"]);
    fields(fx.shop.normalizeShop, ["shop", "shop_key", "out"]);
    fields(fx.shop.shopLabel, ["in", "out"]);
    fields(fx.shop.firstParam, ["in", "out"]);
    fields(fx.shop.categoryParam, ["in", "out", "outSet"]);
    fields(fx.month.monthMax, ["today", "out"]);
    fields(fx.month.monthOf, ["in", "out"]);
    fields(fx.month.monthLabel, ["ym", "today", "out"]);
    fields(fx.month.monthParam, ["m", "today", "out"]);
    fields(fx.month.shiftMonth, ["ym", "delta", "out"]);
    fields(fx.month.splitDate, ["in", "out"]);
    fields(fx.month.weekdayOf, ["in", "out"]);
    fields(fx.month.addDays, ["ymd", "days", "out"]);
    fields(fx.month.daysInMonth, ["y", "m", "out"]);
    fields(fx.forwarding.isForwardingConfirmation, ["in", "out"]);
    fields(fx.forwarding.forwardingConfirmUrl, ["in", "out"]);
    fields(fx.forwarding.confirmUrl, ["forwarding_confirm_url", "text_body", "html_body", "out"]);
    fields(fx.match.faceToFaceAssumed, ["parcel", "out"]);
  });

  it("writes whole parcel rows (every column), so Swift decodes them as ParcelRow", () => {
    const rows: Any[] = [
      ...fx.calendar.upcomingByDay.flatMap((c: Any) => c.parcels),
      ...["spendTotal", "spendByCategory", "spendByMonth", "spendSlices"].flatMap((k) => fx.spend[k].flatMap((c: Any) => c.parcels)),
      ...fx.match.faceToFaceAssumed.map((c: Any) => c.parcel),
    ];
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(Object.keys(r).sort()).toEqual([...PARCEL_COLUMNS].sort());
  });
});

describe("the M1 sections: every out is what the Web's own function answers", () => {
  it("calendar", () => {
    for (const c of fx.calendar.upcomingByDay) {
      const got = Object.fromEntries([...upcomingByDay(c.parcels as ParcelRow[], c.today, c.first, c.last)].map(([day, ps]) => [day, ids(ps)]));
      expect(c.out).toEqual(got);
    }
  });

  it("spend", () => {
    for (const c of fx.spend.spendMonthParam) expect(c.out).toBe(spendMonthParam(c.m ?? undefined, c.today));
    for (const c of fx.spend.spendTotal) expect(c.out).toEqual(spendTotal(c.parcels));
    for (const c of fx.spend.categoryOf) expect(c.out).toBe(categoryOf({ category: c.in }));
    for (const c of fx.spend.spendByCategory) expect(c.out).toEqual(spendByCategory(c.parcels));
    for (const c of fx.spend.sharePercent) expect(c.out).toBe(sharePercent(c.in));
    for (const c of fx.spend.spendByMonth) expect(c.out).toEqual(spendByMonth(c.parcels));
    for (const c of fx.spend.withEmptyMonths) expect(c.out).toEqual(withEmptyMonths(c.in));
    for (const c of fx.spend.axisTicks) expect(c.out).toEqual(axisTicks(c.in));
    for (const c of fx.spend.tickLabel) expect(c.out).toBe(tickLabel(c.in));
    for (const c of fx.spend.spendSlices) {
      const s = spendSlices(c.parcels as ParcelRow[], { all: c.all, c: filterOf(c), s: c.s ?? undefined });
      expect(c.out).toEqual({ picked: ids(s.picked), orders: ids(s.orders), byCategory: ids(s.byCategory), byShop: ids(s.byShop), undated: s.undated });
    }
  });

  it("shop", () => {
    expect(fx.shop.none).toBe(NONE);
    expect(fx.shop.labelMax).toBe(SHOP_LABEL_MAX);
    for (const c of fx.shop.normalizeShop) expect(c.out).toBe(normalizeShop({ shop: c.shop, shop_key: c.shop_key }));
    for (const c of fx.shop.shopLabel) expect(c.out).toBe(shopLabel(c.in));
    for (const c of fx.shop.firstParam) expect(c.out).toBe(firstParam(c.in ?? undefined) ?? null);
    for (const c of fx.shop.categoryParam) {
      const v = categoryParam(c.in ?? undefined);
      expect({ out: c.out, outSet: c.outSet }).toEqual({ out: v ?? null, outSet: v !== undefined });
    }
  });

  it("month", () => {
    expect(fx.month.min).toBe(MONTH_MIN);
    for (const c of fx.month.monthMax) expect(c.out).toBe(monthMax(c.today));
    for (const c of fx.month.monthOf) expect(c.out).toBe(monthOf(c.in));
    for (const c of fx.month.monthLabel) {
      freezeAt(c.today);
      expect(c.out, JSON.stringify(c)).toBe(monthLabel(c.ym));
    }
    vi.useRealTimers();
    for (const c of fx.month.monthParam) expect(c.out).toBe(monthParam(c.m ?? undefined, c.today));
    for (const c of fx.month.shiftMonth) expect(c.out).toBe(shiftMonth(c.ym, c.delta));
    for (const c of fx.month.splitDate) expect(c.out).toEqual(splitDate(c.in));
    for (const c of fx.month.weekdayOf) expect(c.out).toBe(weekdayOf(c.in));
    for (const c of fx.month.addDays) expect(c.out).toBe(addDays(c.ymd, c.days));
    for (const c of fx.month.daysInMonth) expect(c.out).toBe(daysInMonth(c.y, c.m));
  });

  it("forwarding, with the settings page's order (CX4)", () => {
    for (const c of fx.forwarding.isForwardingConfirmation) expect(c.out).toBe(isForwardingConfirmation(c.in));
    for (const c of fx.forwarding.forwardingConfirmUrl) expect(c.out).toBe(forwardingConfirmUrl(c.in));
    for (const c of fx.forwarding.confirmUrl) {
      // src/app/app/settings/page.tsx
      const want = forwardingConfirmUrl(c.forwarding_confirm_url ?? "") ?? forwardingConfirmUrl(c.text_body ?? c.html_body ?? "");
      expect(c.out).toBe(want);
    }
  });

  it("faceToFaceAssumed", () => {
    for (const c of fx.match.faceToFaceAssumed) expect(c.out).toBe(faceToFaceAssumed(c.parcel));
  });
});

/** The KEPT cases of html-to-text-hostile.test.ts (2541793): what the regex version gave. */
const KEPT_INPUTS = [
  '<a data-href="https://e.example/a" href="https://e.example/b">two targets</a>',
  '<a href="https://e.example/c" data-href="https://e.example/d">href first</a>',
  "<a href=\"\">empty href</a> and <a href=''>empty too</a>",
  "<A HREF=\"https://e.example/E\">upper case</A> <IMG ALT='Upper alt'>",
  '<a title="a>b" href="https://e.example/f">a ">" in another value</a>',
  '<a href="https://e.example/g>h">a ">" in the href</a>',
  "<a href='https://e.example/i\">mixed quotes</a>",
  '<a href="https://e.example/j">never closed',
  '<a href="https://e.example/k"',
  "<a href=https://e.example/l>unquoted</a>",
  '<a href = "https://e.example/m">spaces around =</a>',
  '<abbr title="x">abbr is not a link</abbr> <a_b href="https://e.example/n">a_b</a_b>',
  '<img src="x.png" alt="一番目" data-alt="二番目"> <img alt=""> <img/alt="slash"> <imgx alt="not an image">',
  '<img alt="no end"',
  'line<br/>two<BR>three<hr class="x">four<br2>five<br',
  "<script>var a = \"<a href='https://e.example/o'>t</a>\";</script>after script",
  "<header>header text</head>tail",
  "<scripts>x</script>y <title>T</TITLE>z <style>unclosed",
  'İİ<a href="https://e.example/p">after a dotted capital I</a>İ<IMG ALT="İ">',
  '<> <<> a < b > c <<a href="https://e.example/q">t</a>',
  '<table><tr><td><a href="https://e.example/r"><b>bold</b> link</a></td><td>2</td></tr></table>',
  '<a href="https://e.example/?a=1&amp;b=2">entities in the href</a>',
  '<a href="https://e.example/unsubscribe">配信停止</a> <a href="#top">top</a> <a href="mailto:a@b.example">mail</a> <a href="https://e.example/x.png?s=1">image</a>',
  '<!-- <a href="https://e.example/s">hidden</a> -->visible',
  '<a href="https://e.example/t"><img src="x.png" alt="picture only"></a>',
  '<a href="https://e.example/u"></a>empty text',
  '<a\nhref="https://e.example/v"\n>newline in the tag</a\n>',
  "<p>一行目</p><div>二行目</div><li>三</li><h2>見出し</h2><td>a</td><th>b</th>&nbsp;&yen;100&hellip;",
  '<a href="https://e.example/w">one</a><a href="https://e.example/x">two</a></a>',
];

/** The repeated units of the HOSTILE cases; the fixture carries them short (1,000 to 5,000 characters). */
const HOSTILE_UNITS = ["<", "<a ", "<img ", "<script", '<a href="x">', "<br ", "<style>", '<img alt="x"', ' href="x"'];

describe("the cases the plan asks for are there", () => {
  it("calendar: a window from last month, past days, closed parcels, two on one day, the month's last day", () => {
    const all: Any[] = fx.calendar.upcomingByDay.flatMap((c: Any) => c.parcels.map((p: Any) => ({ ...p, _c: c })));
    expect(all.some((p) => p.expected_date_end && p.expected_date < p._c.first && p.expected_date_end >= p._c.first)).toBe(true);
    expect(all.some((p) => p.expected_date && p.expected_date < p._c.today && !p.expected_date_end)).toBe(true);
    expect(all.some((p) => p.status === "delivered")).toBe(true);
    expect(all.some((p) => p.status === "cancelled")).toBe(true);
    expect(fx.calendar.upcomingByDay.some((c: Any) => Object.values(c.out).some((xs: Any) => xs.length >= 2))).toBe(true);
    expect(fx.calendar.upcomingByDay.some((c: Any) => Object.keys(c.out).includes(c.last))).toBe(true);
    // December: the next month is in the next year.
    expect(fx.calendar.upcomingByDay.some((c: Any) => c.first.endsWith("-12-01"))).toBe(true);
  });

  it("spend: priced and unpriced, 未分類 and a value outside the seven, Amazon's names, ties", () => {
    const outs = fx.spend.spendTotal.map((c: Any) => c.out);
    expect(outs.some((o: Any) => o.unpriced > 0)).toBe(true);
    expect(fx.spend.categoryOf.some((c: Any) => typeof c.in === "string" && c.out === null)).toBe(true);
    expect(fx.spend.categoryOf.some((c: Any) => c.in === null)).toBe(true);
    const rows: Any[] = fx.spend.spendByCategory.flatMap((c: Any) => c.out);
    expect(rows.some((r) => r.category === null)).toBe(true);
    // Two categories with the same amount: the fixed order (then the stable sort) decides.
    expect(fx.spend.spendByCategory.some((c: Any) => new Set(c.out.map((r: Any) => r.amount)).size < c.out.length)).toBe(true);
    const sliced: Any[] = fx.spend.spendSlices.flatMap((c: Any) => c.parcels);
    expect(sliced.some((p) => p.shop_key === "amazon" && p.shop !== "Amazon")).toBe(true);
  });

  it("spend: the filters both ways, over a month and over the whole period", () => {
    const xs = fx.spend.spendSlices;
    expect(xs.some((c: Any) => c.all && c.out.undated > 0)).toBe(true);
    expect(xs.some((c: Any) => !c.all)).toBe(true);
    expect(xs.some((c: Any) => !c.cSet)).toBe(true);
    expect(xs.some((c: Any) => c.cSet && c.c === null)).toBe(true);
    expect(xs.some((c: Any) => c.cSet && typeof c.c === "string")).toBe(true);
    expect(xs.some((c: Any) => c.s === "Amazon")).toBe(true);
    expect(xs.some((c: Any) => c.cSet && c.s !== null)).toBe(true);
  });

  it("sharePercent: 0, <1%, a half that rounds up, and a value just under a half", () => {
    const outs = fx.spend.sharePercent.map((c: Any) => c.out);
    expect(outs).toContain("0%");
    expect(outs).toContain("<1%");
    expect(outs).toContain("100%");
    expect(fx.spend.sharePercent.some((c: Any) => c.in === 0.125)).toBe(true);
    // 0.285 * 100 is 28.499999999999996 in JavaScript.
    expect(fx.spend.sharePercent.some((c: Any) => c.in === 0.285)).toBe(true);
    expect(fx.spend.sharePercent.some((c: Any) => c.in < 0)).toBe(true);
  });

  it("axisTicks and tickLabel: Math.log10, 万 with one decimal, thousands separators", () => {
    const ins = fx.spend.axisTicks.map((c: Any) => c.in);
    for (const v of [0, 1000, 4000]) expect(ins).toContain(v);
    expect(ins.some((v: number) => v < 0)).toBe(true);
    expect(ins.some((v: number) => !Number.isInteger(v))).toBe(true);
    expect(ins.some((v: number) => v >= 10_000_000)).toBe(true);
    const labels = fx.spend.tickLabel.map((c: Any) => c.out);
    expect(labels.some((l: string) => /^\d+\.\d万$/.test(l))).toBe(true);
    expect(labels.some((l: string) => /^\d+万$/.test(l))).toBe(true);
    expect(labels.some((l: string) => /,\d{3}万$/.test(l))).toBe(true);
    expect(labels.some((l: string) => /^\d,\d{3}$/.test(l))).toBe(true);
    expect(labels).toContain("0");
  });

  it("withEmptyMonths: the year boundary, under two months, and the 240-month cap", () => {
    const xs = fx.spend.withEmptyMonths;
    expect(xs.some((c: Any) => c.in.length >= 2 && c.in[0].month.slice(0, 4) !== c.in[c.in.length - 1].month.slice(0, 4) && c.out.length > c.in.length)).toBe(true);
    expect(xs.some((c: Any) => c.in.length < 2)).toBe(true);
    // Over 240 months: given back as it is.
    expect(xs.some((c: Any) => c.in.length >= 2 && JSON.stringify(c.out) === JSON.stringify(c.in) && Number(c.in[c.in.length - 1].month.slice(0, 4)) - Number(c.in[0].month.slice(0, 4)) >= 20)).toBe(true);
    // Exactly 240 filled: still filled.
    expect(xs.some((c: Any) => c.out.length === 240 && c.in.length < 240)).toBe(true);
  });

  it("shop: the label's cut by code points (a character outside the BMP), the URL values", () => {
    const labels = fx.shop.shopLabel;
    expect(labels.some((c: Any) => [...c.in].length === 40 && c.out === c.in)).toBe(true);
    expect(labels.some((c: Any) => [...c.in].length === 41 && c.out.endsWith("…"))).toBe(true);
    // More than 40 UTF-16 units, at most 40 code points: not cut.
    expect(labels.some((c: Any) => c.in.length > 40 && [...c.in].length <= 40 && c.out === c.in)).toBe(true);
    const cps = fx.shop.categoryParam;
    expect(cps.some((c: Any) => c.in === "none" && c.out === null && c.outSet)).toBe(true);
    expect(cps.some((c: Any) => Array.isArray(c.in))).toBe(true);
    expect(cps.some((c: Any) => !c.outSet)).toBe(true);
    expect(cps.some((c: Any) => c.in === null)).toBe(true);
    expect(fx.shop.firstParam.some((c: Any) => Array.isArray(c.in) && c.in.length === 0)).toBe(true);
    expect(fx.shop.firstParam.some((c: Any) => Array.isArray(c.in) && c.in.length >= 2)).toBe(true);
  });

  it("month: the year boundary both ways, this year and another, bad values, leap days", () => {
    const shifts = fx.month.shiftMonth;
    expect(shifts.some((c: Any) => c.ym.endsWith("-12") && c.delta > 0 && c.out.slice(0, 4) !== c.ym.slice(0, 4))).toBe(true);
    expect(shifts.some((c: Any) => c.ym.endsWith("-01") && c.delta < 0 && c.out.slice(0, 4) !== c.ym.slice(0, 4))).toBe(true);
    expect(shifts.some((c: Any) => Math.abs(c.delta) >= 24)).toBe(true);
    const labels = fx.month.monthLabel;
    expect(labels.some((c: Any) => c.ym.slice(0, 4) === c.today.slice(0, 4))).toBe(true);
    expect(labels.some((c: Any) => c.ym.slice(0, 4) !== c.today.slice(0, 4))).toBe(true);
    for (const bad of ["2026-13", "2026-1", "2026-00", "", null]) expect(fx.month.monthParam.some((c: Any) => c.m === bad), String(bad)).toBe(true);
    expect(fx.month.monthMax.some((c: Any) => c.today.endsWith("-12-31"))).toBe(true);
    expect(fx.month.daysInMonth.some((c: Any) => c.m === 2 && c.out === 29)).toBe(true);
    expect(fx.month.daysInMonth.some((c: Any) => c.m === 2 && c.out === 28)).toBe(true);
    expect(fx.month.addDays.some((c: Any) => c.ymd.slice(0, 4) !== c.out.slice(0, 4))).toBe(true);
    expect(fx.month.addDays.some((c: Any) => c.out === c.ymd && c.days !== 0)).toBe(true);
    expect(fx.month.splitDate.some((c: Any) => c.out === null)).toBe(true);
    expect(fx.month.splitDate.some((c: Any) => c.in.length > 10 && c.out !== null)).toBe(true);
    expect(fx.month.weekdayOf.some((c: Any) => splitDate(c.in) === null)).toBe(true);
  });

  it("forwarding (CX4): Google's page only; another host, a look-alike host and another path are refused", () => {
    const xs = fx.forwarding.forwardingConfirmUrl;
    expect(xs.some((c: Any) => typeof c.out === "string")).toBe(true);
    const refused = (pred: (s: string) => boolean) => xs.some((c: Any) => pred(c.in) && c.out === null);
    expect(refused((s) => /https:\/\/[a-z0-9.-]*evil\.example\/mail\//.test(s) && !s.includes("mail-settings.google.com"))).toBe(true);
    expect(refused((s) => s.includes("mail-settings.google.com.evil.example"))).toBe(true);
    expect(refused((s) => /https:\/\/mail-settings\.google\.com\/(?!mail\/)/.test(s))).toBe(true);
    expect(refused((s) => s.includes("http://mail-settings.google.com/mail/"))).toBe(true);
    expect(refused((s) => s.includes("mail-settings.google.com@"))).toBe(true);
    // The first matching URL wins when there are several.
    expect(xs.some((c: Any) => (c.in.match(/https:\/\//g) ?? []).length >= 2 && typeof c.out === "string")).toBe(true);
    const confirm = fx.forwarding.confirmUrl;
    // A stored value that fails the check: the body is tried.
    expect(confirm.some((c: Any) => c.forwarding_confirm_url && forwardingConfirmUrl(c.forwarding_confirm_url) === null && typeof c.out === "string")).toBe(true);
    // text_body "" is not null: html_body is not looked at.
    expect(confirm.some((c: Any) => c.text_body === "" && c.html_body && forwardingConfirmUrl(c.html_body) !== null && c.out === null)).toBe(true);
    expect(confirm.some((c: Any) => c.text_body === null && c.html_body && typeof c.out === "string")).toBe(true);
    expect(confirm.some((c: Any) => c.forwarding_confirm_url === null && c.text_body === null && c.html_body === null && c.out === null)).toBe(true);
    const from = fx.forwarding.isForwardingConfirmation;
    expect(from.some((c: Any) => c.out === true && c.in !== c.in.trim().toLowerCase())).toBe(true);
    expect(from.some((c: Any) => c.out === false)).toBe(true);
  });

  it("faceToFaceAssumed: both answers, Amazon, and each stored value", () => {
    const xs = fx.match.faceToFaceAssumed;
    expect(xs.some((c: Any) => c.out === true)).toBe(true);
    expect(xs.some((c: Any) => c.out === false && c.parcel.requires_presence === true)).toBe(true);
    expect(xs.some((c: Any) => c.out === false && c.parcel.requires_presence === false)).toBe(true);
    expect(xs.some((c: Any) => c.out === false && c.parcel.requires_presence === null && c.parcel.shop_key === "amazon")).toBe(true);
  });

  it("htmlToText (2541793): every KEPT case and each hostile shape, short", () => {
    const inputs: string[] = fx.text.htmlToText.map((c: Any) => c.in);
    for (const k of KEPT_INPUTS) expect(inputs, k.slice(0, 60)).toContain(k);
    for (const unit of HOSTILE_UNITS) {
      const found = inputs.some((s) => s.length >= 1_000 && s.length <= 5_000 && s.includes(unit.repeat(Math.max(2, Math.floor(200 / unit.length)))));
      expect(found, unit).toBe(true);
    }
    for (const c of fx.text.htmlToText) expect(c.out).toBe(htmlToText(c.in));
  });
});

describe("task 4: tickLabel lives in src/lib/spend.ts, behaviour unchanged", () => {
  it("answers as month-bars.tsx did", () => {
    expect(tickLabel(0)).toBe("0");
    expect(tickLabel(8000)).toBe("8,000");
    expect(tickLabel(9999)).toBe("9,999");
    expect(tickLabel(10_000)).toBe("1万");
    expect(tickLabel(12_345)).toBe("1.2万");
    expect(tickLabel(15_500)).toBe("1.6万");
    expect(tickLabel(50_000)).toBe("5万");
    expect(tickLabel(125_000)).toBe("12.5万");
    expect(tickLabel(100_000_000)).toBe("10,000万");
  });

  it("month-bars.tsx uses it and keeps no copy", () => {
    const bars = readFileSync(path.join(ROOT, "src/app/app/spend/month-bars.tsx"), "utf8");
    expect(bars).not.toMatch(/function\s+tickLabel\b/);
    expect(bars).toMatch(/import\s*\{[^}]*\btickLabel\b[^}]*\}\s*from\s*"@\/lib\/spend"/);
  });
});
