/**
 * Writes ios/OtodokeTests/Fixtures/web-expected.json: hand-written, made-up inputs run through the
 * Web's own TypeScript functions. The iOS differential tests (WebParity1Tests / WebParity2Tests,
 * and for batch 2 WebParity3Tests / PresenceAssumedTests) check the Swift ports against it. No real mail, order number, tracking number or person here.
 *
 *   npm run ios:fixtures                              write the file and the crypto vectors (below)
 *   npx tsx scripts/ios-fixtures.ts --stdout          print web-expected.json instead (never a vector)
 *   NODE_ENV=test npx tsx scripts/ios-fixtures.ts --crypto-out <dir>   write only the two vector files, into <dir>
 *   npx tsx scripts/ios-fixtures.ts --password-out <dir>              write only password-v1.json, into <dir>
 *
 * The crypto vectors (batch 2, task 13) go to ios/OtodokeTests/Fixtures/crypto/, which ios/.gitignore keeps
 * out of git: envelope-v1.json is fixtures/crypto/envelope-v1.json byte for byte, and negative-v1.json holds
 * envelopes sealed by the Web's own sealBytes (its test injection, so NODE_ENV=test) whose plaintext is wrong.
 * password-v1.json (iOS build 3) is fixtures/crypto/password-v1.json byte for byte, into the same place.
 *
 * The output does not depend on the machine's time zone or clock: every "today" is given, and the
 * functions that read today's year themselves run with the clock frozen at noon JST of that day.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fromBase64, utf8 } from "../src/lib/crypto/bytes";
import { mailAad, sealBytes } from "../src/lib/crypto/envelope";
import { amazonOrderTrackingUrl, identifyCarrier, normalizeTracking, trackingLinkFor } from "../src/lib/carriers";
import { CATEGORIES, UNCATEGORIZED_LABEL, categoryColor, categoryLabel, isCategory } from "../src/lib/category";
import { upcomingByDay } from "../src/lib/calendar";
import {
  RELEVANCE_LABEL,
  STATUS_LABEL,
  addDays,
  daysInMonth,
  formatDateJa,
  formatDateTimeJa,
  formatWindow,
  monthLabel,
  monthOf,
  monthParam,
  relativeDateJa,
  shiftMonth,
  splitDate,
  todayJst,
  weekdayOf,
  yen,
} from "../src/lib/format";
import { forwardingConfirmUrl, isForwardingConfirmation } from "../src/lib/forwarding";
import { faceToFace, faceToFaceAssumed, isLate, lastExpectedDay, needsCheck, type ParcelRow } from "../src/lib/match";
import { MONTH_MIN, monthMax } from "../src/lib/month-url";
import { parcelSections } from "../src/lib/parcel-sections";
import { isHttpsUrl } from "../src/lib/safe-url";
import { NONE, SHOP_LABEL_MAX, categoryParam, firstParam, normalizeShop, shopLabel } from "../src/lib/shop";
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
} from "../src/lib/spend";
import { decodeEntities, htmlToText, stripInvisible } from "../src/lib/text/html-to-text";
import {
  NO_ORDER_DATE_LABEL,
  SEARCH_MAX,
  deliveredFilterOptions,
  filterDelivered,
  groupByOrderMonth,
  itemNamesByParcel,
  monthChoices,
  searchWord,
  type DeliveredFilterValues,
} from "../src/lib/delivered";
import { undeliveredStatus } from "../src/lib/undelivered";
import { UNREAD_FILTER } from "../src/lib/unread";

const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(ROOT, "ios/OtodokeTests/Fixtures/web-expected.json");
/** The crypto vectors' default place: outside git (ios/.gitignore). */
const CRYPTO_OUT = path.join(ROOT, "ios/OtodokeTests/Fixtures/crypto");
/** The canonical vector file (scripts/crypto-vectors.ts), copied byte for byte, never by hand. */
const CRYPTO_SOURCE = path.join(ROOT, "fixtures/crypto/envelope-v1.json");
/** The canonical password-v1 vectors (scripts/crypto-password-v1-vectors.ts), copied byte for byte, never by hand. */
const PASSWORD_SOURCE = path.join(ROOT, "fixtures/crypto/password-v1.json");

// ---------------------------------------------------------------------------------------------
// The clock, frozen for the functions that read it themselves (formatDateJa reads this year).

const RealDate = Date;

/** Runs fn with `new Date()` and `Date.now()` at noon JST of `today` (03:00 UTC). */
function atNoonJst<T>(today: string, fn: () => T): T {
  const fixed = RealDate.parse(`${today}T03:00:00Z`);
  if (Number.isNaN(fixed)) throw new Error(`bad today: ${today}`);
  class FrozenDate extends RealDate {
    constructor(...args: [] | [string | number | Date]) {
      if (args.length === 0) super(fixed);
      else super(args[0]);
    }
    static now() {
      return fixed;
    }
  }
  globalThis.Date = FrozenDate as DateConstructor;
  try {
    return fn();
  } finally {
    globalThis.Date = RealDate;
  }
}

// ---------------------------------------------------------------------------------------------
// Made-up parcel rows: every column of public.parcels.

const USER = "00000000-0000-4000-8000-0000000000aa";

function parcel(id: string, over: Partial<ParcelRow>): ParcelRow {
  // The iOS app (build 13) knows only the old meaning of delivered: arrived, off the list. A delivered
  // row here is a received one (received_at set) so the Web answers as that app does; a row that is
  // delivered and not received is the Web's new 配達済み, which the app does not have yet.
  const received_at = over.status === "delivered" ? "2026-11-01T00:00:00+00:00" : null;
  return {
    id,
    user_id: USER,
    shop: "テスト店",
    shop_key: null,
    title: "テスト商品",
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
    received_at,
    check_dismissed_at: null,
    total_amount: null,
    created_at: "2026-10-01T00:00:00+00:00",
    updated_at: "2026-10-01T00:00:00.123456+00:00",
    ...over,
  };
}

/** A made-up UUID whose text order follows (group, n). */
const pid = (group: number, n: number) => `00000000-0000-4000-8000-${String(group).padStart(4, "0")}${String(n).padStart(8, "0")}`;

/** The database's order: expected_date ↑ nulls last, last_email_at ↓ nulls last (as time), id ↑. */
function dbCompare(a: ParcelRow, b: ParcelRow): number {
  if (a.expected_date !== b.expected_date) {
    if (a.expected_date === null) return 1;
    if (b.expected_date === null) return -1;
    return a.expected_date < b.expected_date ? -1 : 1;
  }
  const ta = a.last_email_at === null ? null : RealDate.parse(a.last_email_at);
  const tb = b.last_email_at === null ? null : RealDate.parse(b.last_email_at);
  if (ta !== tb) {
    if (ta === null) return 1;
    if (tb === null) return -1;
    return ta > tb ? -1 : 1;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** The rows are written by hand in the database's order; stop if they are not. */
function inDbOrder(rows: ParcelRow[]): ParcelRow[] {
  for (let i = 1; i < rows.length; i++) {
    if (dbCompare(rows[i - 1], rows[i]) >= 0) throw new Error(`not in the database's order: ${rows[i - 1].id} before ${rows[i].id}`);
  }
  return rows;
}

// ---------------------------------------------------------------------------------------------
// format

const todayJstCases = [
  "2026-11-03T14:59:59Z", // 23:59:59 JST, still the 3rd
  "2026-11-03T15:00:00Z", // 00:00 JST, already the 4th
  "2026-11-04T03:00:00Z", // the same day in UTC and JST
  "2026-12-31T14:59:59.999Z",
  "2026-12-31T15:00:00.000Z", // the new year in JST
  "2027-01-01T00:00:00+09:00",
].map((now) => ({ now, out: todayJst(new RealDate(now)) }));

const formatDateJaInputs: Array<{ ymd: string | null; withYear?: boolean; today: string }> = [
  { ymd: "2026-11-05", today: "2026-11-04" },
  { ymd: "2026-11-05", withYear: true, today: "2026-11-04" },
  { ymd: "2026-11-05", withYear: false, today: "2026-11-04" },
  { ymd: "2026-12-31", today: "2026-12-31" },
  { ymd: "2027-01-01", today: "2026-12-31" }, // next year: the year is shown
  { ymd: "2026-12-31", today: "2027-01-01" }, // last year: the year is shown
  { ymd: "2027-01-01", today: "2027-01-01" },
  { ymd: "2028-02-29", today: "2028-02-28" },
  { ymd: "2026-11-05T10:00:00", today: "2026-11-04" }, // only the date part is read
  { ymd: "未定", today: "2026-11-04" }, // not a date: given back as is
  { ymd: "", today: "2026-11-04" },
  { ymd: null, today: "2026-11-04" },
];
const formatDateJaCases = formatDateJaInputs.map((c) => ({
  ...c,
  out: atNoonJst(c.today, () => formatDateJa(c.ymd, c.withYear === undefined ? {} : { withYear: c.withYear })),
}));

const relativeDateJaInputs: Array<{ ymd: string | null; today: string }> = [
  { ymd: "2026-11-04", today: "2026-11-04" },
  { ymd: "2026-11-05", today: "2026-11-04" },
  { ymd: "2026-11-03", today: "2026-11-04" },
  { ymd: "2026-11-10", today: "2026-11-04" },
  { ymd: "2026-10-30", today: "2026-11-04" },
  { ymd: "2027-01-01", today: "2026-12-31" }, // 明日 across the year
  { ymd: "2026-12-31", today: "2027-01-01" }, // 昨日 across the year
  { ymd: "2027-01-02", today: "2026-12-31" },
  { ymd: "2028-02-29", today: "2028-02-28" },
  { ymd: "2028-03-01", today: "2028-02-29" },
  { ymd: null, today: "2026-11-04" },
];
const relativeDateJaCases = relativeDateJaInputs.map((c) => ({ ...c, out: atNoonJst(c.today, () => relativeDateJa(c.ymd, c.today)) }));

const formatWindowCases = (
  [
    ["08:00:00", "12:00:00"],
    ["08:00", "12:00"],
    ["08:00:00", "13:00:00"],
    ["14:00:00", "16:00:00"],
    ["19:00:00", null],
    [null, "21:00:00"],
    [null, null],
  ] as Array<[string | null, string | null]>
).map(([start, end]) => ({ start, end, out: formatWindow(start, end) }));

const yenCases = [null, 0, 980, 1000, 1234, 1234567].map((n) => ({ n, out: yen(n) }));

const formatDateTimeJaInputs: Array<{ iso: string | null; today: string }> = [
  { iso: "2026-11-02T09:00:00Z", today: "2026-11-04" },
  { iso: "2026-11-03T14:59:59Z", today: "2026-11-04" },
  { iso: "2026-11-03T15:00:00Z", today: "2026-11-04" }, // the next day in JST
  { iso: "2026-11-03T23:45:10.123456+00:00", today: "2026-11-04" }, // microseconds, as PostgREST sends
  { iso: "2026-11-04T08:05:00+09:00", today: "2026-11-04" },
  { iso: "2026-12-31T15:30:00Z", today: "2026-12-31" }, // next year in JST
  { iso: "2026-12-31T14:30:00Z", today: "2027-01-01" }, // last year
  { iso: "まだ時刻ではない", today: "2026-11-04" }, // not a time: given back as is
  { iso: "", today: "2026-11-04" },
  { iso: null, today: "2026-11-04" },
];
const formatDateTimeJaCases = formatDateTimeJaInputs.map((c) => ({ ...c, out: atNoonJst(c.today, () => formatDateTimeJa(c.iso)) }));

// ---------------------------------------------------------------------------------------------
// match

const M = 1; // id group for the match cases
const matchRows = {
  noDate: parcel(pid(M, 1), {}),
  oneDate: parcel(pid(M, 2), { expected_date: "2026-11-05" }),
  window: parcel(pid(M, 3), { expected_date: "2026-11-01", expected_date_end: "2026-11-05" }),
};

const lastExpectedDayCases = Object.values(matchRows).map((p) => ({ parcel: p, out: lastExpectedDay(p) }));

const needsCheckInputs: Array<{ parcel: ParcelRow; today: string }> = [
  { parcel: parcel(pid(M, 10), { expected_date: "2026-10-21" }), today: "2026-11-04" }, // 14 days: ask
  { parcel: parcel(pid(M, 11), { expected_date: "2026-10-22" }), today: "2026-11-04" }, // 13 days: not yet
  { parcel: parcel(pid(M, 12), { expected_date: "2026-10-01", expected_date_end: "2026-10-22" }), today: "2026-11-04" },
  { parcel: parcel(pid(M, 13), { expected_date: "2026-09-01", status: "delivered" }), today: "2026-11-04" },
  { parcel: parcel(pid(M, 14), { expected_date: "2026-09-01", status: "cancelled" }), today: "2026-11-04" },
  { parcel: parcel(pid(M, 15), { expected_date: "2026-09-01", status: "ordered" }), today: "2026-11-04" },
  // No date: two weeks from the last mail's day in JST.
  { parcel: parcel(pid(M, 16), { last_email_at: "2026-10-21T14:59:59Z" }), today: "2026-11-04" },
  { parcel: parcel(pid(M, 17), { last_email_at: "2026-10-21T15:00:00Z" }), today: "2026-11-04" },
  { parcel: parcel(pid(M, 18), { last_email_at: "2026-10-21T23:59:59+09:00" }), today: "2026-11-04" },
  { parcel: parcel(pid(M, 19), { last_email_at: "2026-10-21T14:59:59.999999+00:00" }), today: "2026-11-04" },
  { parcel: parcel(pid(M, 20), {}), today: "2026-11-04" },
  // Across the year.
  { parcel: parcel(pid(M, 21), { expected_date: "2026-12-18" }), today: "2027-01-01" },
  { parcel: parcel(pid(M, 22), { expected_date: "2026-12-19" }), today: "2027-01-01" },
];
const needsCheckCases = needsCheckInputs.map((c) => ({ ...c, out: needsCheck(c.parcel, c.today) }));

const isLateInputs: Array<{ parcel: ParcelRow; today: string }> = [
  { parcel: parcel(pid(M, 30), { expected_date: "2026-11-03" }), today: "2026-11-04" },
  { parcel: parcel(pid(M, 31), { expected_date: "2026-11-04" }), today: "2026-11-04" },
  { parcel: parcel(pid(M, 32), { expected_date: "2026-11-01", expected_date_end: "2026-11-04" }), today: "2026-11-04" },
  { parcel: parcel(pid(M, 33), { expected_date: "2026-11-01", expected_date_end: "2026-11-03" }), today: "2026-11-04" },
  { parcel: parcel(pid(M, 34), {}), today: "2026-11-04" },
  { parcel: parcel(pid(M, 35), { expected_date: "2026-11-01", status: "delivered" }), today: "2026-11-04" },
  { parcel: parcel(pid(M, 36), { expected_date: "2026-11-01", status: "cancelled" }), today: "2026-11-04" },
  { parcel: parcel(pid(M, 37), { expected_date: "2026-12-31" }), today: "2027-01-01" },
];
const isLateCases = isLateInputs.map((c) => ({ ...c, out: isLate(c.parcel, c.today) }));

const faceToFaceCases = [
  parcel(pid(M, 40), { requires_presence: true }),
  parcel(pid(M, 41), { requires_presence: false }),
  parcel(pid(M, 42), { requires_presence: null, shop_key: "amazon" }),
  parcel(pid(M, 43), { requires_presence: true, shop_key: "amazon" }),
  parcel(pid(M, 44), { requires_presence: null, shop_key: "example-shop" }),
  parcel(pid(M, 45), { requires_presence: null, shop_key: null }),
].map((p) => ({ parcel: p, out: faceToFace(p) }));

// ---------------------------------------------------------------------------------------------
// match: faceToFaceAssumed (iOS batch 2, task 27)

const faceToFaceAssumedCases = [
  parcel(pid(M, 50), { requires_presence: true }),
  parcel(pid(M, 51), { requires_presence: false }),
  parcel(pid(M, 52), { requires_presence: null }),
  parcel(pid(M, 53), { requires_presence: null, shop_key: "amazon" }),
  parcel(pid(M, 54), { requires_presence: true, shop_key: "amazon" }),
  parcel(pid(M, 55), { requires_presence: false, shop_key: "amazon" }),
  parcel(pid(M, 56), { requires_presence: null, shop_key: "example-shop" }),
  parcel(pid(M, 57), { requires_presence: null, source: "manual" }),
].map((p) => ({ parcel: p, out: faceToFaceAssumed(p) }));

// ---------------------------------------------------------------------------------------------
// calendar (rows in the order the calendar page asks for: expected_date ↑, expected_window_start ↑ nulls last)

const C = 4; // id group for the calendar cases
const calendarNovember = [
  parcel(pid(C, 1), { title: "先月からの期間", expected_date: "2026-10-28", expected_date_end: "2026-11-06" }),
  parcel(pid(C, 2), { title: "先月で終わった期間", expected_date: "2026-10-20", expected_date_end: "2026-10-31" }),
  parcel(pid(C, 3), { title: "過ぎた日", expected_date: "2026-11-02" }),
  parcel(pid(C, 4), { title: "届いた", status: "delivered", expected_date: "2026-11-05" }),
  parcel(pid(C, 5), { title: "今日", status: "out_for_delivery", expected_date: "2026-11-04", expected_window_start: "14:00:00", expected_window_end: "16:00:00" }),
  parcel(pid(C, 6), { title: "今日（時間なし）", expected_date: "2026-11-04" }),
  parcel(pid(C, 8), { title: "11/10 の 1 つ目", expected_date: "2026-11-10", expected_window_start: "08:00:00", expected_window_end: "12:00:00" }),
  parcel(pid(C, 7), { title: "キャンセル", status: "cancelled", expected_date: "2026-11-10" }),
  parcel(pid(C, 9), { title: "11/10 の 2 つ目", status: "ordered", expected_date: "2026-11-10" }),
  parcel(pid(C, 10), { title: "11/10 の 3 つ目", status: "unknown", expected_date: "2026-11-10" }),
  parcel(pid(C, 11), { title: "月末", expected_date: "2026-11-30" }),
  parcel(pid(C, 12), { title: "月末から来月へ", expected_date: "2026-11-29", expected_date_end: "2026-12-03" }),
  parcel(pid(C, 13), { title: "来月", expected_date: "2026-12-02" }),
  parcel(pid(C, 14), { title: "日付なし" }),
].sort((a, b) => ((a.expected_date ?? "9") < (b.expected_date ?? "9") ? -1 : (a.expected_date ?? "9") > (b.expected_date ?? "9") ? 1 : 0));

const calendarDecember = [
  parcel(pid(C, 20), { title: "12/20 の荷物", expected_date: "2026-12-20" }),
  parcel(pid(C, 21), { title: "大晦日", expected_date: "2026-12-31" }),
  parcel(pid(C, 22), { title: "年をまたぐ期間", expected_date: "2026-12-30", expected_date_end: "2027-01-03" }),
  parcel(pid(C, 23), { title: "元日", expected_date: "2027-01-01" }),
].sort((a, b) => ((a.expected_date as string) < (b.expected_date as string) ? -1 : 1));

const calendarJanuary = [
  parcel(pid(C, 30), { title: "年をまたぐ期間", expected_date: "2026-12-30", expected_date_end: "2027-01-03" }),
  parcel(pid(C, 31), { title: "元日", expected_date: "2027-01-01" }),
  parcel(pid(C, 32), { title: "1/15", expected_date: "2027-01-15", status: "ordered" }),
  parcel(pid(C, 33), { title: "1/31", expected_date: "2027-01-31" }),
];

const upcomingInputs: Array<{ today: string; first: string; last: string; parcels: ParcelRow[] }> = [
  { today: "2026-11-04", first: "2026-11-01", last: "2026-11-30", parcels: calendarNovember },
  // A month ahead: the window from last month is listed on the month's first day.
  { today: "2026-11-04", first: "2026-12-01", last: "2026-12-31", parcels: calendarNovember },
  // A month already past: nothing before today is listed.
  { today: "2026-11-04", first: "2026-10-01", last: "2026-10-31", parcels: calendarNovember },
  { today: "2026-12-31", first: "2026-12-01", last: "2026-12-31", parcels: calendarDecember },
  { today: "2026-12-31", first: "2027-01-01", last: "2027-01-31", parcels: calendarJanuary },
  { today: "2027-01-02", first: "2027-01-01", last: "2027-01-31", parcels: calendarJanuary },
  { today: "2026-11-04", first: "2026-11-01", last: "2026-11-30", parcels: [] },
];
const upcomingByDayCases = upcomingInputs.map((c) => ({
  ...c,
  out: Object.fromEntries([...upcomingByDay(c.parcels, c.today, c.first, c.last)].map(([day, ps]) => [day, ps.map((p) => p.id)])),
}));

// ---------------------------------------------------------------------------------------------
// spend

const spendMonthParamCases = [
  { m: "2026-05", today: "2026-11-06" },
  { m: "2026-12", today: "2026-11-06" },
  { m: "2026-13", today: "2026-11-06" },
  { m: "2026-00", today: "2026-11-06" },
  { m: "2026-1", today: "2026-11-06" },
  { m: "2026-05-01", today: "2026-11-06" },
  { m: "", today: "2026-11-06" },
  { m: null, today: "2027-01-01" },
].map((c) => ({ ...c, out: spendMonthParam(c.m ?? undefined, c.today) }));

const P = 5; // id group for the spend cases
const spendRows = [
  parcel(pid(P, 1), { shop: "テスト食品店", category: "food", total_amount: 3000, ordered_at: "2026-10-03" }),
  parcel(pid(P, 2), { shop: "テスト食品店", category: "food", total_amount: 1200, ordered_at: "2026-11-01" }),
  parcel(pid(P, 3), { shop: "Amazon.co.jp", shop_key: "amazon", category: "electronics", total_amount: 4200, ordered_at: "2026-11-02" }),
  parcel(pid(P, 4), { shop: "Amazon", shop_key: "amazon", category: "daily", total_amount: 4200, ordered_at: "2026-11-03" }),
  parcel(pid(P, 5), { shop: "Amazonマーケットプレイス", shop_key: "amazon", category: null, total_amount: 980, ordered_at: "2026-11-04" }),
  parcel(pid(P, 6), { shop: "テスト雑貨店", category: "Food", total_amount: 500, ordered_at: "2026-11-05" }), // outside the seven: 未分類
  parcel(pid(P, 7), { shop: "テスト雑貨店", category: "hobby", total_amount: null, ordered_at: "2026-11-05" }), // no amount
  parcel(pid(P, 8), { shop: "テスト雑貨店", category: "beauty", total_amount: 2500, ordered_at: null }), // no order date
  parcel(pid(P, 9), { shop: "テスト食品店", category: "food", total_amount: 0, ordered_at: "2026-12-24" }),
  parcel(pid(P, 10), { shop: "テスト服店", category: "fashion", total_amount: 8800, ordered_at: "2025-12-31" }),
  parcel(pid(P, 11), { shop: "テスト服店", category: null, total_amount: null, ordered_at: null }),
];
const spendNovember = spendRows.filter((p) => p.ordered_at?.startsWith("2026-11"));
// Two categories with the same amount, listed in the fixed order (then kept by the stable sort).
const spendTies = [
  parcel(pid(P, 20), { category: "other", total_amount: 1000 }),
  parcel(pid(P, 21), { category: "food", total_amount: 1000 }),
  parcel(pid(P, 22), { category: null, total_amount: 1000 }),
  parcel(pid(P, 23), { category: "beauty", total_amount: 1000 }),
  parcel(pid(P, 24), { category: "daily", total_amount: 3000 }),
];
const spendParcelSets: ParcelRow[][] = [spendRows, spendNovember, spendTies, [parcel(pid(P, 30), { total_amount: null })], []];

const spendTotalCases = spendParcelSets.map((parcels) => ({ parcels, out: spendTotal(parcels) }));
const categoryOfCases = ["food", "daily", "hobby", "fashion", "electronics", "beauty", "other", "Food", "uncategorized", "未分類", "none", "", null].map(
  (input) => ({ in: input, out: categoryOf({ category: input }) }),
);
const spendByCategoryCases = spendParcelSets.map((parcels) => ({ parcels, out: spendByCategory(parcels) }));
const sharePercentCases = [0, -0.1, 0.001, 0.004, 0.00499, 0.005, 0.125, 0.285, 0.335, 0.5, 0.994, 0.995, 0.999, 1, 1 / 3, 2 / 3].map((input) => ({
  in: input,
  out: sharePercent(input),
}));
const spendByMonthCases = [
  ...spendParcelSets,
  [
    parcel(pid(P, 40), { category: "food", total_amount: 100, ordered_at: "2026-02-01" }),
    parcel(pid(P, 41), { category: "food", total_amount: 200, ordered_at: "2025-02-28" }),
    parcel(pid(P, 42), { category: "other", total_amount: 300, ordered_at: "2026-02-15" }),
    parcel(pid(P, 43), { category: null, total_amount: 400, ordered_at: "2026-02-20" }),
    parcel(pid(P, 44), { category: "daily", total_amount: 0, ordered_at: "2026-03-01" }), // 0 yen: a bar with no segment
    parcel(pid(P, 45), { category: "food", total_amount: 500, ordered_at: "不明" }), // not a date: not on the bars
  ],
].map((parcels) => ({ parcels, out: spendByMonth(parcels) }));

type Bar = ReturnType<typeof spendByMonth>[number];
const bar = (month: string, total = 1000): Bar => ({ month, total, segments: total > 0 ? [{ category: "food", amount: total }] : [] });
const withEmptyMonthsCases = (
  [
    [],
    [bar("2026-05")],
    [bar("2026-10"), bar("2026-11")],
    [bar("2025-11"), bar("2026-01", 2500), bar("2026-03")], // across the year
    [bar("2026-12"), bar("2027-02")],
    [bar("2006-01"), bar("2025-12")], // exactly 240 months: still filled
    [bar("2006-01"), bar("2026-01")], // 241 months: given back as it is
    [bar("2000-01"), bar("2010-06"), bar("2025-01")], // far over 240
  ] as Bar[][]
).map((input) => ({ in: input, out: withEmptyMonths(input) }));

const axisTicksCases = [0, -5, 1, 3, 4, 5, 7.5, 10, 99, 1000, 1234.5, 4000, 4001, 9999, 12_345, 50_000, 99_999, 100_000, 987_654, 12_345_678, 100_000_000].map(
  (input) => ({ in: input, out: axisTicks(input) }),
);

const tickLabelCases = [
  0, 1, 500, 1000, 1234, 8000, 9999, 10_000, 12_345, 15_000, 15_500, 20_000, 25_000, 50_000, 99_999, 125_000, 999_999, 1_000_000, 12_345_678,
  100_000_000, 1_234_560_000,
  // toLocaleString rounds the shortest decimal form, half away from zero: 1.15 is 1.2, though the double is below it.
  10_050, 10_500, 11_500, 12_500, 99_999.95, 1234.5678, 0.0005,
].map((input) => ({ in: input, out: tickLabel(input) }));

// The category filter as the page gets it: cSet false is no filter (undefined), c null is 未分類.
const sliceFilters: Array<{ c: string | null; cSet: boolean; s: string | null }> = [
  { c: null, cSet: false, s: null },
  { c: null, cSet: true, s: null },
  { c: "food", cSet: true, s: null },
  { c: null, cSet: false, s: "Amazon" },
  { c: "electronics", cSet: true, s: "Amazon" },
  { c: null, cSet: true, s: "Amazon" },
  { c: "beauty", cSet: true, s: "テスト雑貨店" },
  { c: null, cSet: false, s: "Amazon.co.jp" }, // the name as written never matches: compared after normalizeShop
];
const spendSlicesCases = [
  ...sliceFilters.map((f) => ({ parcels: spendRows, all: true, ...f })),
  ...sliceFilters.map((f) => ({ parcels: spendNovember, all: false, ...f })),
  { parcels: [] as ParcelRow[], all: true, c: null, cSet: false, s: null },
].map((c) => {
  const s = spendSlices(c.parcels, { all: c.all, c: c.cSet ? (c.c as Parameters<typeof spendSlices>[1]["c"]) : undefined, s: c.s ?? undefined });
  const ids = (xs: ParcelRow[]) => xs.map((p) => p.id);
  return { ...c, out: { picked: ids(s.picked), orders: ids(s.orders), byCategory: ids(s.byCategory), byShop: ids(s.byShop), undated: s.undated } };
});

// ---------------------------------------------------------------------------------------------
// shop

const normalizeShopCases = (
  [
    ["Amazon.co.jp", "amazon"],
    ["Amazon", "amazon"],
    ["アマゾン", "amazon"],
    ["テスト店", null],
    ["テスト店", "test-shop"],
    ["Amazon", null],
    ["", null],
  ] as Array<[string, string | null]>
).map(([shop, shop_key]) => ({ shop, shop_key, out: normalizeShop({ shop, shop_key }) }));

const shopLabelCases = [
  "テスト店",
  "",
  "あ".repeat(40),
  "あ".repeat(41),
  "a".repeat(39) + "𠮷", // 40 code points, 41 UTF-16 units: not cut
  "𠮷".repeat(40), // 80 UTF-16 units: not cut
  "𠮷".repeat(41),
  "a".repeat(39) + "𠮷𠮷", // cut after the first 𠮷, never inside it
  "が".repeat(20), // 40 code points in 20 characters (a combining mark)
  "が".repeat(20) + "x", // 41 code points: cut by code points, between か and its mark
  "店名です。".repeat(10),
].map((input) => ({ in: input, out: shopLabel(input) }));

const firstParamCases = ["Amazon", "", ["テスト店", "別の店"], ["x"], [], null].map((input) => ({
  in: input,
  out: firstParam(input ?? undefined) ?? null,
}));

const categoryParamCases = ["food", "none", "Food", "NONE", "uncategorized", "", ["beauty", "food"], ["none", "food"], ["x", "food"], [], null].map((input) => {
  const v = categoryParam(input ?? undefined);
  return { in: input, out: v ?? null, outSet: v !== undefined };
});

// ---------------------------------------------------------------------------------------------
// month (src/lib/month-url.ts and the month parts of src/lib/format.ts)

const monthMaxCases = ["2026-11-06", "2026-12-31", "2027-01-01", "2020-01-01"].map((today) => ({ today, out: monthMax(today) }));
const monthOfCases = ["2026-11-05", "2026-11-05T10:00:00Z", "2026-1", "2026", ""].map((input) => ({ in: input, out: monthOf(input) }));
const monthLabelCases = [
  { ym: "2026-11", today: "2026-11-06" },
  { ym: "2026-01", today: "2026-11-06" },
  { ym: "2025-12", today: "2026-11-06" },
  { ym: "2027-01", today: "2026-12-31" },
  { ym: "2027-01", today: "2027-01-01" },
  { ym: "2020-01", today: "2026-11-06" },
].map((c) => ({ ...c, out: atNoonJst(c.today, () => monthLabel(c.ym)) }));
const monthParamCases = [
  { m: "2026-11", today: "2026-11-06" },
  { m: "2020-01", today: "2026-11-06" },
  { m: "2026-13", today: "2026-11-06" },
  { m: "2026-1", today: "2026-11-06" },
  { m: "2026-00", today: "2026-11-06" },
  { m: "", today: "2026-11-06" },
  { m: null, today: "2026-11-06" },
  { m: " 2026-05", today: "2026-11-06" },
  { m: "2026-05\n", today: "2026-11-06" },
  { m: "２０２６-０５", today: "2026-11-06" },
  { m: null, today: "2027-01-01" },
].map((c) => ({ ...c, out: monthParam(c.m ?? undefined, c.today) }));
const shiftMonthCases = (
  [
    ["2026-11", 1],
    ["2026-12", 1],
    ["2026-01", -1],
    ["2026-11", 0],
    ["2026-11", 24],
    ["2026-11", -25],
    ["2020-01", -1],
    ["2027-12", 13],
  ] as Array<[string, number]>
).map(([ym, delta]) => ({ ym, delta, out: shiftMonth(ym, delta) }));
const splitDateCases = ["2026-11-05", "2026-11-05T10:00:00Z", "2026-02-30", "2026-1-5", "未定", ""].map((input) => ({ in: input, out: splitDate(input) }));
const weekdayOfCases = ["2026-11-06", "2026-11-08", "2027-01-01", "2028-02-29", "2026-02-30", "未定", ""].map((input) => ({ in: input, out: weekdayOf(input) }));
const addDaysCases = (
  [
    ["2026-12-31", 1],
    ["2027-01-01", -1],
    ["2026-03-01", -1],
    ["2028-02-28", 1],
    ["2026-11-05", 0],
    ["2026-11-05", 400],
    ["2026-11-05", -40],
    ["2026-02-30", 0],
    ["未定", 3],
  ] as Array<[string, number]>
).map(([ymd, days]) => ({ ymd, days, out: addDays(ymd, days) }));
const daysInMonthCases = (
  [
    [2026, 1],
    [2026, 2],
    [2028, 2],
    [2100, 2],
    [2000, 2],
    [2026, 4],
    [2026, 12],
    [2026, 13],
    [2026, 0],
  ] as Array<[number, number]>
).map(([y, m]) => ({ y, m, out: daysInMonth(y, m) }));

// ---------------------------------------------------------------------------------------------
// forwarding (src/lib/forwarding.ts and the settings page's choice, CX4)

const isForwardingConfirmationCases = [
  "forwarding-noreply@google.com",
  "  Forwarding-NoReply@Google.COM ",
  "Gmail Team <forwarding-noreply@google.com>",
  "noreply@shop.example.com",
  "",
].map((input) => ({ in: input, out: isForwardingConfirmation(input) }));

const forwardingConfirmUrlCases = [
  "確認するには次のリンクを開いてください: https://mail-settings.google.com/mail/vf-%5BABC123%5D-xyz",
  "https://mail-settings.google.com/mail/vf-abc。ご確認ください",
  "<a href=\"https://mail-settings.google.com/mail/vf-abc\">確認</a>",
  "(https://mail-settings.google.com/mail/vf-abc)",
  "https://MAIL-SETTINGS.Google.com/mail/vf-upper",
  "https://mail-settings.google.com:443/mail/vf-port",
  "https://example.com/x と https://mail-settings.google.com/mail/vf-first と https://mail-settings.google.com/mail/vf-second",
  "https://evil.example/mail/vf-abc",
  "https://mail-settings.google.com.evil.example/mail/vf-abc",
  "https://mail-settings.google.com/settings/vf-abc",
  "https://mail-settings.google.com/mailx/vf-abc",
  "https://mail-settings.google.com/mail",
  "http://mail-settings.google.com/mail/vf-abc",
  "https://mail-settings.google.com@evil.example.com/mail/vf-abc",
  "https://mail-settings.google.com:99999/mail/vf-abc",
  "https://",
  "",
  // What the WHATWG parser does to the host and the path (the Web compares its hostname and pathname).
  "https://ｍａｉｌ-settings.google.com/mail/vf-full-width",
  "https://mail-settings%2Egoogle.com/mail/vf-percent",
  "https://mail-settings。google。com/mail/vf-ideographic-stop",
  "https://mail-settings.goo\u200bgle.com/mail/vf-zero-width",
  "https://mail-settings.google.com./mail/vf-trailing-dot",
  "https://mail-settings.google.com\\mail\\vf-backslash",
  "https:///mail-settings.google.com/mail/vf-three-slashes",
  "https://mail-settings.google.com/x/../mail/vf-dot-dot",
  "https://mail-settings.google.com/%2e/mail/vf-dot",
  "https://mail-settings.google.com:/mail/vf-empty-port",
  "https://mail-settings.google.com?/mail/vf-query",
  "https://mail-settings.google.com#/mail/vf-hash",
].map((input) => ({ in: input, out: forwardingConfirmUrl(input) }));

const GOOD = "https://mail-settings.google.com/mail/vf-%5BABC%5D-good";
const confirmUrlCases = [
  { forwarding_confirm_url: GOOD, text_body: null, html_body: null },
  { forwarding_confirm_url: "https://evil.example/mail/vf-stored", text_body: `本文 ${GOOD}`, html_body: null },
  { forwarding_confirm_url: "", text_body: `本文 ${GOOD}`, html_body: null },
  { forwarding_confirm_url: null, text_body: "", html_body: `<a href="${GOOD}">確認</a>` },
  { forwarding_confirm_url: null, text_body: null, html_body: `<a href="${GOOD}">確認</a>` },
  { forwarding_confirm_url: null, text_body: "リンクのない本文", html_body: `<a href="${GOOD}">確認</a>` },
  { forwarding_confirm_url: "https://mail-settings.google.com.evil.example/mail/vf", text_body: "https://evil.example/mail/vf", html_body: null },
  { forwarding_confirm_url: null, text_body: null, html_body: null },
].map((c) => ({ ...c, out: forwardingConfirmUrl(c.forwarding_confirm_url ?? "") ?? forwardingConfirmUrl(c.text_body ?? c.html_body ?? "") }));

// ---------------------------------------------------------------------------------------------
// sections (rows in the database's order)

const S = 2; // id group for the first section case
const sectionsA = inDbOrder([
  parcel(pid(S, 1), { title: "9月の荷物", expected_date: "2026-09-01", last_email_at: "2026-09-01T01:00:00Z" }), // 要確認
  parcel(pid(S, 2), { title: "期間の荷物（遅れ）", expected_date: "2026-10-01", expected_date_end: "2026-10-25" }), // late, not asked yet
  parcel(pid(S, 3), { title: "注文だけの荷物", status: "ordered", expected_date: "2026-10-20" }), // 要確認
  parcel(pid(S, 4), { title: "期間の荷物", expected_date: "2026-11-01", expected_date_end: "2026-11-05" }), // still ahead
  parcel(pid(S, 5), { title: "配達中（遅れ）", status: "out_for_delivery", expected_date: "2026-11-03" }),
  parcel(pid(S, 6), { title: "配達中", status: "out_for_delivery", expected_date: "2026-11-04", expected_window_start: "14:00:00", expected_window_end: "16:00:00" }),
  // Three on 11/5: the later mail first (compared as time, not as text), then no mail.
  parcel(pid(S, 9), { title: "11/5 の荷物 A", expected_date: "2026-11-05", last_email_at: "2026-11-03T10:00:00Z" }),
  parcel(pid(S, 7), { title: "11/5 の荷物 B", expected_date: "2026-11-05", last_email_at: "2026-11-03T18:00:00+09:00" }),
  parcel(pid(S, 8), { title: "11/5 の不在", status: "attempted", expected_date: "2026-11-05" }),
  parcel(pid(S, 10), { title: "11/5 に届いた", status: "delivered", expected_date: "2026-11-05" }),
  parcel(pid(S, 11), { title: "キャンセル", status: "cancelled", expected_date: "2026-11-06" }),
  parcel(pid(S, 12), { title: "注文中", status: "ordered", expected_date: "2026-11-10" }),
  parcel(pid(S, 13), { title: "不明", status: "unknown", expected_date: "2026-11-12" }),
  // No date.
  parcel(pid(S, 14), { title: "日付なし（最近のメール）", last_email_at: "2026-11-02T00:00:00Z" }),
  parcel(pid(S, 15), { title: "日付なし注文（翌日のメール）", status: "ordered", last_email_at: "2026-10-21T15:00:00Z" }),
  parcel(pid(S, 16), { title: "日付なし（2 週間前のメール）", status: "unknown", last_email_at: "2026-10-21T14:59:59Z" }), // 要確認
  parcel(pid(S, 17), { title: "日付なし配達中", status: "out_for_delivery" }),
  parcel(pid(S, 18), { title: "日付なし", shop_key: "amazon" }),
]);

const Y = 3; // id group for the year-boundary case
const sectionsB = inDbOrder([
  parcel(pid(Y, 1), { title: "12/17 の荷物", expected_date: "2026-12-17" }), // 14 days: 要確認
  parcel(pid(Y, 2), { title: "12/18 の荷物", expected_date: "2026-12-18" }), // late
  parcel(pid(Y, 3), { title: "12/30 キャンセル", status: "cancelled", expected_date: "2026-12-30" }),
  parcel(pid(Y, 4), { title: "大晦日の配達中", status: "out_for_delivery", expected_date: "2026-12-31" }),
  parcel(pid(Y, 5), { title: "元日の荷物", expected_date: "2027-01-01", last_email_at: "2026-12-30T12:00:00Z" }),
  parcel(pid(Y, 6), { title: "元日の荷物 2", expected_date: "2027-01-01" }),
  parcel(pid(Y, 7), { title: "年明けの注文", status: "ordered", expected_date: "2027-01-05" }),
]);

const sectionsCases = [
  { today: "2026-11-04", parcels: sectionsA },
  { today: "2026-12-31", parcels: sectionsB },
  { today: "2027-01-01", parcels: sectionsB },
  { today: "2026-11-04", parcels: [] as ParcelRow[] },
].map(({ today, parcels }) => {
  const s = parcelSections(parcels, today);
  const ids = (xs: ParcelRow[]) => xs.map((p) => p.id);
  return { today, parcels, out: { toCheck: ids(s.toCheck), delivering: ids(s.delivering), soon: ids(s.soon), ordered: ids(s.ordered) } };
});

// ---------------------------------------------------------------------------------------------
// undelivered and unread

const undeliveredCases = (
  [
    ["123456789012", null],
    [null, "ヤマト運輸"],
    [" 1 ", null],
    [null, null],
    ["", ""],
    ["   ", null],
    [null, "\t"],
    ["　", null], // a full-width space only: trim() counts it as space
  ] as Array<[string | null, string | null]>
).map(([tracking_number, carrier]) => ({ row: { tracking_number, carrier }, out: undeliveredStatus({ tracking_number, carrier }) }));

const unreadCases = ["2026-11-04T03:00:00Z", "2026-11-04T00:01:30.250Z", "2027-01-01T00:02:00Z"].map((now) => ({
  now,
  out: UNREAD_FILTER(new RealDate(now)),
}));

// ---------------------------------------------------------------------------------------------
// carriers (made-up numbers in the right shape)

const normalizeTrackingCases = [
  "1234-5678-9012",
  "1234 5678 9012",
  "tba123456789012",
  "ej 123 456 789 jp",
  "１２３４－５６７８－９０１２", // full-width forms (U+FF01-U+FF5E) count as their ASCII forms
  "ＴＢＡ１２３",
  "",
  "№1234-5678-9012", // a sign, not folded: dropped like other marks (NFKC would make it "No")
  "①1234-5678-9012",
  "Ｎｏ．１２３４－５６７８－９０１２", // a "No." or "No:" label first is dropped
  "伝票No.1234-5678-9012",
  "No:EJ123456789JP",
  "No . 123",
  "No.",
  "No123456789012", // no "." or ":": NO stays
  "NO123456789JP",
  "Nov.123",
].map((input) => ({ in: input, out: normalizeTracking(input) }));

const carrierInputs: Array<[string | null, string | null]> = [
  ["1234-5678-9012", "ヤマト運輸"],
  ["123456789012", "クロネコヤマト"],
  [null, "Kuroneko"],
  ["123456789012", "佐川急便"],
  ["123456789012", null],
  ["123456789012", "西濃運輸"],
  ["123456789012", "Amazon"],
  ["12345678901", null],
  ["1234567890123", "ゆうパック"],
  ["1234567890123", "福山通運"],
  ["EJ123456789JP", null],
  ["ej123456789jp", "ヤマト"],
  ["TBA123456789012", null],
  ["tba123456789", "佐川"],
  ["1234567890", "福山通運"],
  ["1234567890", null],
  ["ABC", "japan post"],
  ["ABC", "JapanPost"],
  ["12345", null],
  [null, null],
  ["№1234-5678-9012", "ヤマト運輸"],
  ["Ｎｏ．１２３４５６７８９０１", null],
];
const identifyCarrierCases = carrierInputs.map(([tracking, hint]) => {
  const info = identifyCarrier(tracking, hint);
  return { tracking, hint, out: { key: info.key, name: info.name } };
});

const linkInputs: Array<[string | null, string | null]> = [
  ["1234-5678-9012", "ヤマト運輸"],
  ["123456789012", "佐川急便"],
  ["12345678901", null],
  ["EJ123456789JP", null],
  ["1234567890", "福山通運"],
  ["123456789012", "西濃運輸"],
  ["TBA123456789012", null],
  ["123456789012", null],
  [null, "ヤマト運輸"],
  ["---", "ヤマト運輸"],
  ["", "佐川急便"],
  ["№1234-5678-9012", "ヤマト運輸"],
  ["No.12345678901", null],
];
const trackingLinkForCases = linkInputs.map(([tracking, hint]) => ({ tracking, hint, out: trackingLinkFor(tracking, hint) }));

const amazonOrderTrackingUrlCases = [
  "250-1234567-1234567",
  " 250-1234567-1234567 ",
  "D01-1234567-1234567",
  "2501234567123456",
  "250-1234567-123456",
  "",
  null,
].map((input) => ({ in: input, out: amazonOrderTrackingUrl(input) }));

// ---------------------------------------------------------------------------------------------
// safeUrl and category

const safeUrlCases = [
  "https://example.com/track?id=1",
  "HTTPS://EXAMPLE.COM/track",
  "https://example.com:8443/a/b",
  "http://example.com/track",
  "HTTP://example.com/track",
  "javascript:alert(1)",
  "JavaScript:alert(1)",
  "data:text/html,<b>x</b>",
  "ftp://example.com/x",
  "https://",
  "//example.com/track",
  "/track",
  "",
  null,
  123,
].map((input) => ({ in: input, out: isHttpsUrl(input as string | null) }));

const isCategoryCases = ["food", "other", "beauty", "Food", "uncategorized", "未分類", "", null, 1].map((input) => ({
  in: input,
  out: isCategory(input),
}));

// ---------------------------------------------------------------------------------------------
// text

/** The KEPT cases of src/lib/__tests__/html-to-text-hostile.test.ts (2541793): quirks the rewrite keeps. */
function keptHtml(): string[] {
  return [
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
    `<a href="https://e.example/${"long/".repeat(70)}">long url</a>`,
  ];
}

/** The HOSTILE shapes of html-to-text-hostile.test.ts, 2,000 characters each instead of 512K. */
function hostileHtml(): string[] {
  const fill = (unit: string) => unit.repeat(Math.ceil(2000 / unit.length)).slice(0, 2000);
  return [
    fill("<"),
    fill("<a "),
    fill("<img "),
    fill("<script"),
    fill('<a href="x">'),
    fill("<br "),
    fill("<style>"),
    fill('<img alt="x"'),
    `<a${fill(' href="x"')}>`,
    `<a href="x">${fill("<")}</a>`,
  ];
}

const longUrl = `https://example.com/😀/${"a".repeat(400)}`; // the emoji is two UTF-16 units before the cut

const htmlToTextCases = [
  "<p>ご注文ありがとうございます。</p><p>お届け予定: 11/5</p>",
  '<a href="https://example.com/track?id=1&amp;x=2">配送状況を確認</a>',
  "<A HREF='https://example.com/o/1'><b>注文</b>を見る</A>",
  '<a href="https://example.com/unsubscribe">配信停止</a> と <a href="#top">上へ</a> と <a href="https://example.com/x"><img src="a.png"></a>',
  '<a href="https://example.com/banner.png?v=1">画像</a>',
  `<a href="${longUrl}">長いリンク</a>`,
  "&lt;b&gt;太字&lt;/b&gt; &yen;1,234 &#x1F4E6; &#128666; A&nbsp;&amp;&nbsp;B &unknown; &AMP;",
  "<head><title>件名</title></head><style>p { color: red }</style><!-- 隠す --><div>本文</div><script>alert(1)</script>",
  "<table><tr><th>品名</th><th>数量</th></tr><tr><td>テスト商品</td><td>1</td></tr></table>",
  '<img src="logo.png" alt="テスト店のロゴ">ようこそ',
  "注文番号​: 123‎-456<br>次の行<br/>その次<hr>区切り",
  "<p>a</p><p></p><p></p><p></p><p>b</p>",
  "前の文<!-- 閉じないコメント",
  "<p>𠮷野家のお弁当 🍱</p>",
  "  空白　と\t\tタブ  <br>  次の行  ",
  "",
  ...keptHtml(),
  ...hostileHtml(),
].map((input) => ({ in: input, out: htmlToText(input) }));

const decodeEntitiesCases = [
  "&amp;&lt;&gt;&quot;&apos;",
  "&#x1F4E6; と &#128230;",
  "&#65;&#x41;&#X41;",
  "&#x110000; は範囲外",
  "&AMP; &Yen; &foo; & amp;",
  "𠮷&yen;100",
  "&nbsp;&hellip;&copy;&reg;&trade;&mdash;&ndash;",
].map((input) => ({ in: input, out: decodeEntities(input) }));

const stripInvisibleCases = [
  "123​456",
  "﻿件名",
  "‪abc‬",
  "⁠x⁤",
  "𠮷‍z",
  "‎250-1234567-1234567‏",
  "普通の文",
].map((input) => ({ in: input, out: stripInvisible(input) }));

// ---------------------------------------------------------------------------------------------
// delivered (batch 2, task 13): the delivered page's grouping, search and filters

const D = 7; // id group for the delivered cases

const delivered = (n: number, over: Partial<ParcelRow>) => parcel(pid(D, n), { status: "delivered", ...over });

// Several months across a year boundary, two parcels on the same day (kept in input order: the higher id
// first, so a sort by id would change it), a timestamp, and undated parcels (null and malformed) last.
const deliveredByMonthRows: ParcelRow[] = [
  delivered(1, { title: "冬のコート", shop: "テスト服店", ordered_at: "2025-12-20", category: "fashion" }),
  delivered(3, { title: "加湿器", shop: "テスト家電店", ordered_at: "2026-01-05", category: "electronics" }),
  delivered(2, { title: "マグカップ", shop: "テスト雑貨店", ordered_at: "2026-01-05", category: "daily" }),
  delivered(4, { title: "日付なし", ordered_at: null }),
  delivered(5, { title: "お茶", shop: "テスト食品店", ordered_at: "2026-11-02T10:15:00+09:00", category: "food" }),
  delivered(6, { title: "崩れた日付", ordered_at: "2026/11/03" }),
  delivered(7, { title: "年末の本", shop: "テスト書店", ordered_at: "2025-12-31", category: "hobby" }),
  delivered(8, { title: "秋の靴", shop: "テスト服店", ordered_at: "2026-10-30", category: "fashion" }),
];
const groupByOrderMonthCases = [
  deliveredByMonthRows,
  [delivered(10, { ordered_at: null }), delivered(11, { ordered_at: "" })],
  [delivered(12, { ordered_at: "2026-11-01" })],
  [],
].map((parcels) => ({ parcels, out: groupByOrderMonth(parcels).map((g) => ({ label: g.label, ids: g.parcels.map((p) => p.id) })) }));

type ItemName = { parcel_id: string; name: string };
const itemNamesByParcelInputs: ItemName[][] = [
  [],
  [{ parcel_id: pid(D, 1), name: "ウールのコート" }],
  [
    { parcel_id: pid(D, 2), name: "マグ（白）" },
    { parcel_id: pid(D, 1), name: "コート" },
    { parcel_id: pid(D, 2), name: "マグ（黒）" },
    { parcel_id: pid(D, 2), name: "マグ（白）" },
  ],
];
const itemNamesByParcelCases = itemNamesByParcelInputs.map((items) => ({ items, out: Object.fromEntries(itemNamesByParcel(items)) }));

const searchWordInputs: Array<string | null> = [
  null,
  "",
  "   ",
  "　コート　",
  " Amazon ",
  "あ".repeat(SEARCH_MAX),
  `  ${"い".repeat(SEARCH_MAX)}  `,
  "う".repeat(SEARCH_MAX + 20),
  `${"え".repeat(SEARCH_MAX - 1)} おか`,
];
const searchWordCases = searchWordInputs.map((q) => ({ q, out: searchWord(q ?? undefined) }));

// Rows for the search: full-width / half-width / compatibility characters, Greek and Turkish capitals,
// Amazon under several names, item names that are the only match.
const searchRows: ParcelRow[] = [
  delivered(20, { title: "ABCノート", shop: "テスト文具店", ordered_at: "2026-11-01", category: "hobby" }),
  delivered(21, { title: "テストの本", shop: "テスト書店", ordered_at: "2026-10-12", category: "hobby" }),
  delivered(22, { title: "１番の箱", shop: "テスト雑貨店", ordered_at: "2026-10-01", category: "daily" }),
  delivered(23, { title: "ΣΟΦΙΑ のマグ", shop: "テスト雑貨店", ordered_at: "2026-09-30", category: "daily" }),
  delivered(24, { title: "İstanbul の地図", shop: "テスト書店", ordered_at: "2026-09-02", category: null }),
  delivered(25, { title: "電池", shop: "Amazonマーケットプレイス", shop_key: "amazon", ordered_at: "2026-11-03", category: "electronics" }),
  delivered(26, { title: null, shop: "Amazon.co.jp", shop_key: "amazon", ordered_at: "2026-08-15", category: "Food" }),
  delivered(27, { title: "ⅲ巻セット", shop: "テスト書店", ordered_at: null, category: "hobby" }),
];
const searchItems: ItemName[] = [
  { parcel_id: pid(D, 20), name: "方眼ノート" },
  { parcel_id: pid(D, 26), name: "緑茶ティーバッグ" },
  { parcel_id: pid(D, 21), name: "文庫本" },
  { parcel_id: pid(D, 26), name: "ほうじ茶" },
];
const filterDeliveredInputs: Array<DeliveredFilterValues & { parcels?: ParcelRow[]; items?: ItemName[] }> = [
  {},
  { q: "ａｂｃ" },
  { q: "ＡＢＣ" },
  { q: "ﾃｽﾄ" },
  { q: "1番" },
  { q: "①番" },
  { q: "Ⅲ巻" },
  { q: "σοφια" },
  { q: "ΣΟΦΙΑ" },
  { q: "İstanbul" },
  { q: "istanbul" },
  { q: "緑茶" },
  { q: "amazon" },
  { q: "Amazon" },
  { q: "  文庫  " },
  { q: "見つからない言葉" },
  { q: "   " },
  { q: `${"ノ".repeat(SEARCH_MAX)}ート` },
  { q: `ABC${"x".repeat(SEARCH_MAX)}` },
  { s: "Amazon" },
  { s: "Amazonマーケットプレイス" },
  { s: "テスト書店" },
  { s: "知らない店" },
  { c: "hobby" },
  { c: "none" },
  { c: "food" },
  { c: "toys" },
  { c: "" },
  { m: "2026-11" },
  { m: "2026-10" },
  { m: "2026-13" },
  { m: "2026-9" },
  { m: "" },
  { q: "ノート", s: "テスト文具店", c: "hobby", m: "2026-11" },
  { q: "本", s: "テスト書店", c: "hobby" },
  { q: "茶", s: "Amazon", m: "2026-08", c: "none" },
  { q: "テスト", s: "知らない店", c: "toys", m: "2026-99" },
  { q: "テスト", parcels: [], items: [] },
  { q: "緑茶", items: [] },
];
const filterDeliveredCases = filterDeliveredInputs.map((c) => {
  const parcels = c.parcels ?? searchRows;
  const items = c.items ?? searchItems;
  const values: DeliveredFilterValues = { q: c.q, s: c.s, c: c.c, m: c.m };
  return {
    parcels,
    items,
    q: c.q ?? null,
    s: c.s ?? null,
    c: c.c ?? null,
    m: c.m ?? null,
    out: filterDelivered(parcels, itemNamesByParcel(items), values).map((p) => p.id),
  };
});

// Shop counts tied (listed in code-unit order), Amazon by shop_key, malformed and missing months.
const optionsRows: ParcelRow[] = [
  delivered(40, { shop: "テスト書店", ordered_at: "2026-11-01" }),
  delivered(41, { shop: "Amazon.co.jp", shop_key: "amazon", ordered_at: "2026-10-03" }),
  delivered(42, { shop: "Amazonマーケットプレイス", shop_key: "amazon", ordered_at: "2026-11-20" }),
  delivered(43, { shop: "テスト服店", ordered_at: "2025-12-31" }),
  delivered(44, { shop: "テスト書店", ordered_at: "2026/10/05" }),
  delivered(45, { shop: "Bテスト店", ordered_at: null }),
  delivered(46, { shop: "Aテスト店", ordered_at: "2026-13-01" }),
  delivered(47, { shop: "テスト服店", ordered_at: "2026-10-30T23:59:00+09:00" }),
];
const deliveredFilterOptionsCases = [optionsRows, [delivered(50, { shop: "テスト店", ordered_at: null })], []].map((parcels) => ({ parcels, out: deliveredFilterOptions(parcels) }));

const monthChoicesInputs: Array<{ months: string[]; m: string | null }> = [
  { months: ["2026-11", "2026-10", "2025-12"], m: "2026-10" },
  { months: ["2026-11", "2026-10", "2025-12"], m: "2026-01" },
  { months: ["2026-11", "2026-10", "2025-12"], m: "2027-02" },
  { months: ["2026-11", "2026-10", "2025-12"], m: "2026-13" },
  { months: ["2026-11", "2026-10", "2025-12"], m: "" },
  { months: ["2026-11", "2026-10", "2025-12"], m: null },
  { months: [], m: "2026-05" },
  { months: [], m: null },
];
const monthChoicesCases = monthChoicesInputs.map((c) => ({ months: c.months, m: c.m, out: monthChoices(c.months, c.m ?? undefined) }));

// ---------------------------------------------------------------------------------------------

const expected = {
  generatedBy: "scripts/ios-fixtures.ts",
  format: {
    todayJst: todayJstCases,
    formatDateJa: formatDateJaCases,
    relativeDateJa: relativeDateJaCases,
    formatWindow: formatWindowCases,
    yen: yenCases,
    formatDateTimeJa: formatDateTimeJaCases,
    statusLabel: STATUS_LABEL,
    relevanceLabel: RELEVANCE_LABEL,
  },
  match: {
    lastExpectedDay: lastExpectedDayCases,
    needsCheck: needsCheckCases,
    isLate: isLateCases,
    faceToFace: faceToFaceCases,
    faceToFaceAssumed: faceToFaceAssumedCases,
  },
  sections: sectionsCases,
  undelivered: undeliveredCases,
  unread: unreadCases,
  carriers: {
    normalizeTracking: normalizeTrackingCases,
    identifyCarrier: identifyCarrierCases,
    trackingLinkFor: trackingLinkForCases,
    amazonOrderTrackingUrl: amazonOrderTrackingUrlCases,
  },
  safeUrl: safeUrlCases,
  category: {
    keys: [...CATEGORIES],
    labels: Object.fromEntries(CATEGORIES.map((k) => [k, categoryLabel(k)])),
    colors: Object.fromEntries(CATEGORIES.map((k) => [k, categoryColor(k)])),
    uncategorizedLabel: UNCATEGORIZED_LABEL,
    uncategorizedColor: categoryColor(null),
    isCategory: isCategoryCases,
  },
  text: {
    htmlToText: htmlToTextCases,
    decodeEntities: decodeEntitiesCases,
    stripInvisible: stripInvisibleCases,
  },
  calendar: {
    upcomingByDay: upcomingByDayCases,
  },
  spend: {
    spendMonthParam: spendMonthParamCases,
    spendTotal: spendTotalCases,
    categoryOf: categoryOfCases,
    spendByCategory: spendByCategoryCases,
    sharePercent: sharePercentCases,
    spendByMonth: spendByMonthCases,
    withEmptyMonths: withEmptyMonthsCases,
    axisTicks: axisTicksCases,
    tickLabel: tickLabelCases,
    spendSlices: spendSlicesCases,
  },
  shop: {
    none: NONE,
    labelMax: SHOP_LABEL_MAX,
    normalizeShop: normalizeShopCases,
    shopLabel: shopLabelCases,
    firstParam: firstParamCases,
    categoryParam: categoryParamCases,
  },
  month: {
    min: MONTH_MIN,
    monthMax: monthMaxCases,
    monthOf: monthOfCases,
    monthLabel: monthLabelCases,
    monthParam: monthParamCases,
    shiftMonth: shiftMonthCases,
    splitDate: splitDateCases,
    weekdayOf: weekdayOfCases,
    addDays: addDaysCases,
    daysInMonth: daysInMonthCases,
  },
  forwarding: {
    isForwardingConfirmation: isForwardingConfirmationCases,
    forwardingConfirmUrl: forwardingConfirmUrlCases,
    confirmUrl: confirmUrlCases,
  },
  delivered: {
    noOrderDateLabel: NO_ORDER_DATE_LABEL,
    searchMax: SEARCH_MAX,
    groupByOrderMonth: groupByOrderMonthCases,
    itemNamesByParcel: itemNamesByParcelCases,
    searchWord: searchWordCases,
    filterDelivered: filterDeliveredCases,
    deliveredFilterOptions: deliveredFilterOptionsCases,
    monthChoices: monthChoicesCases,
  },
};

// received_at and check_dismissed_at are the Web's: the app (build 13) does not have the column, so the rows it reads here
// leave it out. The answers above were worked out with it (see parcel()), which is why they are the old ones.
const text = `${JSON.stringify(expected, (key, value) => (key === "received_at" || key === "check_dismissed_at" ? undefined : value), 2)}\n`;

// ---------------------------------------------------------------------------------------------
// The crypto vectors for iOS (batch 2, task 13). Written outside git; never into web-expected.json.

/** Base64 of the vector file's field, as bytes. */
const b64 = (value: unknown): Uint8Array<ArrayBuffer> => fromBase64(value as string);

/**
 * Envelopes sealed by the Web's own sealBytes to the vector's recipient, with the vector's ids and AAD, whose
 * plaintext is wrong: a key missing, v = 2, bytes that are not UTF-8. The crypto is sound (openBytes opens
 * them); openMail must refuse them. Each has its own fixed IV (never the positive vector's).
 */
async function negativeVectors(source: string): Promise<string> {
  const v = JSON.parse(source);
  const e = v.envelope;
  const recipient = { keyId: e.recipient.key_id as string, publicKey: b64(e.recipient.public_key) };
  const aad = mailAad(e.user_id, e.email_id);
  if (aad !== e.aad) throw new Error("the vector's AAD is not mailAad of its ids");
  const fields = e.plaintext_object;
  const plaintexts: Array<{ name: string; bytes: Uint8Array<ArrayBuffer> }> = [
    { name: "missing_key", bytes: utf8(JSON.stringify({ v: 1, subject: fields.subject, from_name: fields.from_name, from_address: fields.from_address, text: fields.text })) },
    { name: "version_2", bytes: utf8(JSON.stringify({ v: 2, ...fields })) },
    // {"v":1,"subject":"<0xFF 0xFE>",…}: valid JSON around two bytes that are never UTF-8.
    { name: "bad_utf8", bytes: new Uint8Array([...utf8('{"v":1,"subject":"'), 0xff, 0xfe, ...utf8('","from_name":null,"from_address":null,"text":null,"html":null}')]) },
  ];
  const baseIv = b64(e.iv);
  const mail = [];
  for (const [i, p] of plaintexts.entries()) {
    const iv = new Uint8Array(baseIv);
    iv[11] ^= 0x10 + i;
    const envelope = await sealBytes(recipient, aad, p.bytes, {
      ephemeralPrivateKeyPkcs8: b64(e.ephemeral.private_key_pkcs8),
      ephemeralPublicKey: b64(e.ephemeral.public_key),
      iv,
    });
    mail.push({ name: p.name, user_id: e.user_id, email_id: e.email_id, aad, envelope });
  }
  return `${JSON.stringify({ generatedBy: "scripts/ios-fixtures.ts", format: "negative mail envelopes for the iOS app (made-up keys; they protect nothing)", mail }, null, 2)}\n`;
}

async function writeCryptoVectors(dir: string): Promise<void> {
  const source = readFileSync(CRYPTO_SOURCE);
  const negatives = await negativeVectors(source.toString("utf8"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "envelope-v1.json"), source);
  writeFileSync(path.join(dir, "negative-v1.json"), negatives);
  console.error(`wrote the crypto vectors into ${path.relative(ROOT, dir) || dir}`);
}

function writePasswordVectors(dir: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "password-v1.json"), readFileSync(PASSWORD_SOURCE));
  console.error(`wrote the password-v1 vectors into ${path.relative(ROOT, dir) || dir}`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("--stdout")) {
    process.stdout.write(text);
    return;
  }
  const at = argv.indexOf("--crypto-out");
  if (at >= 0) {
    const dir = argv[at + 1];
    if (!dir || dir.startsWith("--")) throw new Error("--crypto-out needs a directory");
    await writeCryptoVectors(path.resolve(dir));
    return;
  }
  const pw = argv.indexOf("--password-out");
  if (pw >= 0) {
    const dir = argv[pw + 1];
    if (!dir || dir.startsWith("--")) throw new Error("--password-out needs a directory");
    writePasswordVectors(path.resolve(dir));
    return;
  }
  mkdirSync(path.dirname(OUT), { recursive: true });
  writeFileSync(OUT, text);
  console.error(`wrote ${path.relative(ROOT, OUT)}`);
  await writeCryptoVectors(CRYPTO_OUT);
  writePasswordVectors(CRYPTO_OUT);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
