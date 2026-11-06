/**
 * Writes ios/OtodokeTests/Fixtures/web-expected.json: hand-written, made-up inputs run through the
 * Web's own TypeScript functions. The iOS differential tests (WebParity1Tests / WebParity2Tests)
 * check the Swift ports against it. No real mail, order number, tracking number or person here.
 *
 *   npm run ios:fixtures             write the file
 *   npx tsx scripts/ios-fixtures.ts --stdout   print the same text instead
 *
 * The output does not depend on the machine's time zone or clock: every "today" is given, and the
 * functions that read today's year themselves run with the clock frozen at noon JST of that day.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { amazonOrderTrackingUrl, identifyCarrier, normalizeTracking, trackingLinkFor } from "../src/lib/carriers";
import { CATEGORIES, UNCATEGORIZED_LABEL, categoryColor, categoryLabel, isCategory } from "../src/lib/category";
import { RELEVANCE_LABEL, STATUS_LABEL, formatDateJa, formatDateTimeJa, formatWindow, relativeDateJa, todayJst, yen } from "../src/lib/format";
import { faceToFace, isLate, lastExpectedDay, needsCheck, type ParcelRow } from "../src/lib/match";
import { parcelSections } from "../src/lib/parcel-sections";
import { isHttpsUrl } from "../src/lib/safe-url";
import { decodeEntities, htmlToText, stripInvisible } from "../src/lib/text/html-to-text";
import { undeliveredStatus } from "../src/lib/undelivered";
import { UNREAD_FILTER } from "../src/lib/unread";

const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(ROOT, "ios/OtodokeTests/Fixtures/web-expected.json");

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
};

const text = `${JSON.stringify(expected, null, 2)}\n`;

if (process.argv.includes("--stdout")) {
  process.stdout.write(text);
} else {
  mkdirSync(path.dirname(OUT), { recursive: true });
  writeFileSync(OUT, text);
  console.error(`wrote ${path.relative(ROOT, OUT)}`);
}
