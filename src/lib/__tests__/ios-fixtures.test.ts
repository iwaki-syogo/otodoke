import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { amazonOrderTrackingUrl, identifyCarrier, normalizeTracking, trackingLinkFor } from "@/lib/carriers";
import { CATEGORIES, UNCATEGORIZED_LABEL, categoryColor, categoryLabel, isCategory } from "@/lib/category";
import { RELEVANCE_LABEL, STATUS_LABEL, formatDateJa, formatDateTimeJa, formatWindow, relativeDateJa, todayJst, yen } from "@/lib/format";
import { faceToFace, isLate, lastExpectedDay, needsCheck, type ParcelRow } from "@/lib/match";
import { parcelSections } from "@/lib/parcel-sections";
import { isHttpsUrl } from "@/lib/safe-url";
import { decodeEntities, htmlToText, stripInvisible } from "@/lib/text/html-to-text";
import { undeliveredStatus } from "@/lib/undelivered";
import { UNREAD_FILTER } from "@/lib/unread";

/**
 * [iOS batch 1, task 2] scripts/ios-fixtures.ts runs hand-written, made-up inputs through the Web's
 * own TypeScript functions and writes ios/OtodokeTests/Fixtures/web-expected.json, which the Swift
 * differential tests (WebParity1Tests / WebParity2Tests) read. This file pins:
 *   - the CLI: `tsx scripts/ios-fixtures.ts` writes the file, `--stdout` prints the same text instead;
 *   - the output does not depend on the machine's time zone (TZ=UTC, Asia/Tokyo, Pacific/Honolulu);
 *   - the file in the repository is the script's current output (no stale fixture);
 *   - the JSON shape (key names) the Swift side decodes;
 *   - every "out" really is what the TS function answers (not typed by hand);
 *   - the cases the plan asks for are there (year boundary, JST midnight, UTF-16, order, ...);
 *   - no real person's data.
 */

const ROOT = path.resolve(__dirname, "../../..");
const SCRIPT = path.join(ROOT, "scripts/ios-fixtures.ts");
const FILE = path.join(ROOT, "ios/OtodokeTests/Fixtures/web-expected.json");
const TSX = path.join(ROOT, "node_modules/.bin/tsx");

function run(tz: string): string {
  return execFileSync(TSX, [SCRIPT, "--stdout"], { cwd: ROOT, env: { ...process.env, TZ: tz }, encoding: "utf8", timeout: 60_000 });
}

/** Every column of public.parcels. Rows in the fixture are whole rows, so Swift decodes them as ParcelRow. */
const PARCEL_COLUMNS = [
  "carrier", "category", "category_source", "created_at", "expected_date", "expected_date_end", "expected_text",
  "expected_window_end", "expected_window_start", "id", "last_email_at", "needs_review", "order_number", "ordered_at",
  "presence_evidence", "requires_presence", "shop", "shop_key", "source", "status", "title", "total_amount",
  "tracking_number", "tracking_url", "updated_at", "user_id",
];

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

let outUtc = "";
let outTokyo = "";
let outHonolulu = "";
let fx: Any = null;

beforeAll(() => {
  outUtc = run("UTC");
  outTokyo = run("Asia/Tokyo");
  outHonolulu = run("Pacific/Honolulu");
  fx = JSON.parse(outUtc);
}, 180_000);

afterEach(() => {
  vi.useRealTimers();
});

/** Freezes the clock at noon JST of `today`, for the TS functions that read today's year themselves. */
function freezeAt(today: string) {
  vi.useFakeTimers({ now: new Date(`${today}T03:00:00Z`), toFake: ["Date"] });
}

describe("scripts/ios-fixtures.ts output", () => {
  it("is the same text whatever the machine's time zone", () => {
    expect(outUtc.length).toBeGreaterThan(0);
    expect(outTokyo).toBe(outUtc);
    expect(outHonolulu).toBe(outUtc);
  });

  it("is what the repository holds in ios/OtodokeTests/Fixtures/web-expected.json", () => {
    expect(existsSync(FILE)).toBe(true);
    expect(readFileSync(FILE, "utf8")).toBe(outUtc);
  });

  it("has exactly the agreed top-level keys", () => {
    expect(Object.keys(fx).sort()).toEqual(
      ["generatedBy", "format", "match", "sections", "undelivered", "unread", "carriers", "safeUrl", "category", "text"].sort(),
    );
    expect(fx.generatedBy).toBe("scripts/ios-fixtures.ts");
    expect(Object.keys(fx.format).sort()).toEqual(
      ["todayJst", "formatDateJa", "relativeDateJa", "formatWindow", "yen", "formatDateTimeJa", "statusLabel", "relevanceLabel"].sort(),
    );
    expect(Object.keys(fx.match).sort()).toEqual(["lastExpectedDay", "needsCheck", "isLate", "faceToFace"].sort());
    expect(Object.keys(fx.carriers).sort()).toEqual(["normalizeTracking", "identifyCarrier", "trackingLinkFor", "amazonOrderTrackingUrl"].sort());
    expect(Object.keys(fx.category).sort()).toEqual(["keys", "labels", "colors", "uncategorizedLabel", "uncategorizedColor", "isCategory"].sort());
    expect(Object.keys(fx.text).sort()).toEqual(["htmlToText", "decodeEntities", "stripInvisible"].sort());
  });

  it("has entries with the agreed field names", () => {
    const fields = (xs: Any[], keys: string[], optional: string[] = []) => {
      expect(xs.length).toBeGreaterThan(0);
      for (const x of xs) {
        for (const k of keys) expect(Object.prototype.hasOwnProperty.call(x, k), `${k} in ${JSON.stringify(x).slice(0, 120)}`).toBe(true);
        for (const k of Object.keys(x)) expect([...keys, ...optional]).toContain(k);
      }
    };
    fields(fx.format.todayJst, ["now", "out"]);
    fields(fx.format.formatDateJa, ["ymd", "today", "out"], ["withYear"]);
    fields(fx.format.relativeDateJa, ["ymd", "today", "out"]);
    fields(fx.format.formatWindow, ["start", "end", "out"]);
    fields(fx.format.yen, ["n", "out"]);
    fields(fx.format.formatDateTimeJa, ["iso", "today", "out"]);
    for (const k of ["lastExpectedDay", "needsCheck", "isLate", "faceToFace"]) fields(fx.match[k], ["parcel", "out"], ["today"]);
    for (const k of ["needsCheck", "isLate"]) for (const c of fx.match[k]) expect(typeof c.today).toBe("string");
    fields(fx.sections, ["today", "parcels", "out"]);
    for (const c of fx.sections) expect(Object.keys(c.out).sort()).toEqual(["delivering", "ordered", "soon", "toCheck"]);
    fields(fx.undelivered, ["row", "out"]);
    fields(fx.unread, ["now", "out"]);
    fields(fx.carriers.normalizeTracking, ["in", "out"]);
    fields(fx.carriers.identifyCarrier, ["tracking", "hint", "out"]);
    for (const c of fx.carriers.identifyCarrier) expect(Object.keys(c.out).sort()).toEqual(["key", "name"]);
    fields(fx.carriers.trackingLinkFor, ["tracking", "hint", "out"]);
    fields(fx.carriers.amazonOrderTrackingUrl, ["in", "out"]);
    fields(fx.safeUrl, ["in", "out"]);
    fields(fx.category.isCategory, ["in", "out"]);
    fields(fx.text.htmlToText, ["in", "out"]);
    fields(fx.text.decodeEntities, ["in", "out"]);
    fields(fx.text.stripInvisible, ["in", "out"]);
  });

  it("writes whole parcel rows (every column), so Swift decodes them as ParcelRow", () => {
    const rows: Any[] = [
      ...fx.sections.flatMap((c: Any) => c.parcels),
      ...["lastExpectedDay", "needsCheck", "isLate", "faceToFace"].flatMap((k) => fx.match[k].map((c: Any) => c.parcel)),
    ];
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(Object.keys(r).sort()).toEqual([...PARCEL_COLUMNS].sort());
  });
});

describe("every out is what the Web's own function answers", () => {
  it("format", () => {
    for (const c of fx.format.todayJst) expect(c.out).toBe(todayJst(new Date(c.now)));
    for (const c of fx.format.formatDateJa) {
      freezeAt(c.today);
      expect(c.out, JSON.stringify(c)).toBe(formatDateJa(c.ymd, c.withYear ? { withYear: true } : {}));
    }
    for (const c of fx.format.relativeDateJa) {
      freezeAt(c.today);
      expect(c.out, JSON.stringify(c)).toBe(relativeDateJa(c.ymd, c.today));
    }
    for (const c of fx.format.formatDateTimeJa) {
      freezeAt(c.today);
      expect(c.out, JSON.stringify(c)).toBe(formatDateTimeJa(c.iso));
    }
    vi.useRealTimers();
    for (const c of fx.format.formatWindow) expect(c.out).toBe(formatWindow(c.start, c.end));
    for (const c of fx.format.yen) expect(c.out).toBe(yen(c.n));
    expect(fx.format.statusLabel).toEqual(STATUS_LABEL);
    expect(fx.format.relevanceLabel).toEqual(RELEVANCE_LABEL);
  });

  it("match", () => {
    for (const c of fx.match.lastExpectedDay) expect(c.out).toBe(lastExpectedDay(c.parcel));
    for (const c of fx.match.needsCheck) expect(c.out).toBe(needsCheck(c.parcel, c.today));
    for (const c of fx.match.isLate) expect(c.out).toBe(isLate(c.parcel, c.today));
    for (const c of fx.match.faceToFace) expect(c.out).toBe(faceToFace(c.parcel));
  });

  it("sections", () => {
    for (const c of fx.sections) {
      const s = parcelSections(c.parcels as ParcelRow[], c.today);
      const ids = (xs: ParcelRow[]) => xs.map((p) => p.id);
      expect(c.out).toEqual({ toCheck: ids(s.toCheck), delivering: ids(s.delivering), soon: ids(s.soon), ordered: ids(s.ordered) });
    }
  });

  it("undelivered and unread", () => {
    for (const c of fx.undelivered) expect(c.out).toBe(undeliveredStatus(c.row));
    for (const c of fx.unread) expect(c.out).toBe(UNREAD_FILTER(new Date(c.now)));
  });

  it("carriers and safeUrl", () => {
    for (const c of fx.carriers.normalizeTracking) expect(c.out).toBe(normalizeTracking(c.in));
    for (const c of fx.carriers.identifyCarrier) {
      const info = identifyCarrier(c.tracking, c.hint);
      expect(c.out).toEqual({ key: info.key, name: info.name });
    }
    for (const c of fx.carriers.trackingLinkFor) expect(c.out).toEqual(trackingLinkFor(c.tracking, c.hint));
    for (const c of fx.carriers.amazonOrderTrackingUrl) expect(c.out).toBe(amazonOrderTrackingUrl(c.in));
    for (const c of fx.safeUrl) expect(c.out).toBe(isHttpsUrl(c.in));
  });

  it("category", () => {
    expect(fx.category.keys).toEqual([...CATEGORIES]);
    expect(fx.category.labels).toEqual(Object.fromEntries(CATEGORIES.map((k) => [k, categoryLabel(k)])));
    expect(fx.category.colors).toEqual(Object.fromEntries(CATEGORIES.map((k) => [k, categoryColor(k)])));
    expect(fx.category.uncategorizedLabel).toBe(UNCATEGORIZED_LABEL);
    expect(fx.category.uncategorizedColor).toBe(categoryColor(null));
    for (const c of fx.category.isCategory) expect(c.out).toBe(isCategory(c.in));
  });

  it("text", () => {
    for (const c of fx.text.htmlToText) expect(c.out).toBe(htmlToText(c.in));
    for (const c of fx.text.decodeEntities) expect(c.out).toBe(decodeEntities(c.in));
    for (const c of fx.text.stripInvisible) expect(c.out).toBe(stripInvisible(c.in));
  });
});

describe("the cases the plan asks for are there", () => {
  it("JST midnight: some now falls on a different calendar day in UTC and in JST", () => {
    expect(fx.format.todayJst.some((c: Any) => c.now.slice(0, 10) !== c.out)).toBe(true);
    expect(fx.format.todayJst.some((c: Any) => c.now.slice(0, 10) === c.out)).toBe(true);
  });

  it("year boundary: 12/31 → 1/1, and the year shown only when it differs", () => {
    expect(fx.format.relativeDateJa.some((c: Any) => c.today.endsWith("-12-31") && c.out === "明日")).toBe(true);
    expect(fx.format.formatDateJa.some((c: Any) => c.ymd && c.ymd.slice(0, 4) !== c.today.slice(0, 4) && !c.withYear)).toBe(true);
    expect(fx.format.formatDateJa.some((c: Any) => c.ymd && c.ymd.slice(0, 4) === c.today.slice(0, 4) && !c.withYear)).toBe(true);
    expect(fx.format.formatDateJa.some((c: Any) => c.withYear === true)).toBe(true);
    const rel = fx.format.relativeDateJa.map((c: Any) => c.out);
    for (const word of ["今日", "明日", "昨日"]) expect(rel).toContain(word);
  });

  it("formatDateTimeJa: JST next day, microseconds, and text that is not a time", () => {
    const xs = fx.format.formatDateTimeJa;
    expect(xs.some((c: Any) => typeof c.iso === "string" && /T(1[5-9]|2[0-3]):/.test(c.iso))).toBe(true);
    expect(xs.some((c: Any) => typeof c.iso === "string" && /\.\d{6}/.test(c.iso))).toBe(true);
    expect(xs.some((c: Any) => typeof c.iso === "string" && c.out === c.iso)).toBe(true);
  });

  it("formatWindow and yen edges", () => {
    expect(fx.format.formatWindow.map((c: Any) => c.out)).toContain("午前中");
    expect(fx.format.yen.some((c: Any) => c.n === null && c.out === "—")).toBe(true);
    expect(fx.format.yen.some((c: Any) => typeof c.n === "number" && c.n >= 1000)).toBe(true);
  });

  it("match: both answers of each rule, and a dateless parcel judged by its last mail", () => {
    const outs = (k: string) => fx.match[k].map((c: Any) => c.out);
    expect(outs("needsCheck")).toEqual(expect.arrayContaining([true, false]));
    expect(outs("isLate")).toEqual(expect.arrayContaining([true, false]));
    expect(outs("faceToFace")).toEqual(expect.arrayContaining([true, false, null]));
    expect(outs("lastExpectedDay")).toContain(null);
    expect(outs("lastExpectedDay").some((x: Json) => typeof x === "string")).toBe(true);
    expect(fx.match.needsCheck.some((c: Any) => c.parcel.expected_date === null && c.parcel.last_email_at !== null)).toBe(true);
  });

  it("sections: every section filled somewhere, ties, windows, dateless and closed parcels", () => {
    expect(fx.sections.length).toBeGreaterThanOrEqual(2);
    for (const k of ["toCheck", "delivering", "soon", "ordered"]) {
      expect(fx.sections.some((c: Any) => c.out[k].length > 0), k).toBe(true);
    }
    const all: Any[] = fx.sections.flatMap((c: Any) => c.parcels);
    expect(all.some((p) => p.expected_date_end !== null)).toBe(true);
    expect(all.some((p) => p.expected_date === null && p.status !== "delivered" && p.status !== "cancelled")).toBe(true);
    expect(all.some((p) => p.status === "delivered" || p.status === "cancelled")).toBe(true);
    // Two parcels in 「もうすぐ届く」 with the same date: the sort must keep their order.
    const tie = fx.sections.some((c: Any) => {
      const byId = new Map(c.parcels.map((p: Any) => [p.id, p]));
      const dates = c.out.soon.map((id: string) => (byId.get(id) as Any).expected_date).filter((d: string | null) => d !== null);
      return new Set(dates).size < dates.length;
    });
    expect(tie).toBe(true);
  });

  it("sections: parcels are written in the database's order (expected_date ↑ nulls last, last_email_at ↓ nulls last as time, id ↑)", () => {
    const cmp = (a: Any, b: Any): number => {
      if (a.expected_date !== b.expected_date) {
        if (a.expected_date === null) return 1;
        if (b.expected_date === null) return -1;
        return a.expected_date < b.expected_date ? -1 : 1;
      }
      const ta = a.last_email_at === null ? null : Date.parse(a.last_email_at);
      const tb = b.last_email_at === null ? null : Date.parse(b.last_email_at);
      if (ta !== tb) {
        if (ta === null) return 1;
        if (tb === null) return -1;
        return ta > tb ? -1 : 1;
      }
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    };
    for (const c of fx.sections) {
      for (let i = 1; i < c.parcels.length; i++) {
        expect(cmp(c.parcels[i - 1], c.parcels[i]), `${c.parcels[i - 1].id} before ${c.parcels[i].id}`).toBeLessThan(0);
      }
    }
    // Several rows share an expected_date somewhere, so last_email_at and id actually decide.
    expect(fx.sections.some((c: Any) => new Set(c.parcels.map((p: Any) => p.expected_date)).size < c.parcels.length)).toBe(true);
  });

  it("undelivered and unread", () => {
    expect(fx.undelivered.map((c: Any) => c.out)).toEqual(expect.arrayContaining(["shipped", "ordered"]));
    const blank = (v: unknown) => typeof v === "string" && v.length > 0 && v.trim() === "";
    expect(fx.undelivered.some((c: Any) => blank(c.row.tracking_number) || blank(c.row.carrier))).toBe(true);
    expect(fx.unread.length).toBeGreaterThan(0);
  });

  it("carriers: every carrier, every link kind, full-width input", () => {
    const keys = new Set(fx.carriers.identifyCarrier.map((c: Any) => c.out.key));
    for (const k of ["yamato", "sagawa", "japanpost", "amazon", "seino", "fukutsu", "unknown"]) expect(keys.has(k), k).toBe(true);
    const kinds = new Set(fx.carriers.trackingLinkFor.map((c: Any) => (c.out === null ? null : c.out.kind)));
    for (const k of ["open", "post", "copy", null]) expect(kinds.has(k), String(k)).toBe(true);
    expect(fx.carriers.normalizeTracking.some((c: Any) => /[^\x00-\x7f]/.test(c.in))).toBe(true);
    const amazon = fx.carriers.amazonOrderTrackingUrl.map((c: Any) => c.out);
    expect(amazon).toContain(null);
    expect(amazon.some((x: Json) => typeof x === "string")).toBe(true);
  });

  it("safeUrl: http:, javascript: and data: are refused; some https: URL is accepted", () => {
    const of = (prefix: string) => fx.safeUrl.filter((c: Any) => typeof c.in === "string" && c.in.toLowerCase().startsWith(prefix));
    for (const p of ["http:", "javascript:", "data:"]) {
      expect(of(p).length, p).toBeGreaterThan(0);
      for (const c of of(p)) expect(c.out).toBe(false);
    }
    expect(fx.safeUrl.some((c: Any) => c.out === true)).toBe(true);
  });

  it("text: links, entities, invisible marks and a character outside the BMP (UTF-16)", () => {
    expect(fx.text.htmlToText.some((c: Any) => /<a\s/i.test(c.in))).toBe(true);
    expect(fx.text.htmlToText.some((c: Any) => /&(#\d+|#x[0-9a-f]+|[a-z]+);/i.test(c.in))).toBe(true);
    expect(fx.text.stripInvisible.some((c: Any) => /[​-‏‪-‮⁠-⁤﻿]/.test(c.in))).toBe(true);
    const nonBmp = (s: string) => [...s].some((ch) => (ch.codePointAt(0) ?? 0) > 0xffff);
    expect([...fx.text.htmlToText, ...fx.text.decodeEntities, ...fx.text.stripInvisible].some((c: Any) => nonBmp(c.in))).toBe(true);
  });
});

describe("no real person's data", () => {
  const strings = (v: Json, out: string[] = []): string[] => {
    if (typeof v === "string") out.push(v);
    else if (Array.isArray(v)) v.forEach((x) => strings(x, out));
    else if (v && typeof v === "object") Object.entries(v).forEach(([k, x]) => (out.push(k), strings(x, out)));
    return out;
  };

  it("mail addresses are made-up ones on example domains only", () => {
    const all = strings(fx);
    const mails = all.flatMap((s) => s.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) ?? []);
    for (const m of mails) expect(m, m).toMatch(/@([a-z0-9-]+\.)*example\.(com|jp|org|net|test)$/i);
  });

  it("holds no project ref or key", () => {
    expect(outUtc).not.toContain("zvqaqdmlxghekasjqneq");
    expect(outUtc).not.toMatch(/eyJhbGciOi/);
  });
});
