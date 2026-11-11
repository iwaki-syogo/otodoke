import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ANCHOR, CATALOG, MONTHS, historyFiles } from "../../../scripts/make-demo-history";
import { demoInput, loadDemoEntries, readDemoMails } from "@/lib/demo";
import { CATEGORIES } from "@/lib/category";
import type { Extraction } from "@/lib/extract/schema";
import { addDays, shiftMonth, todayJst } from "@/lib/format";
import { buildParcelInsert } from "@/lib/match";
import { processInboundEmail } from "@/lib/pipeline";
import { beginSampleLoad } from "@/lib/sample-generation-db";
import { screenMail } from "@/lib/screen";
import { normalizeShop } from "@/lib/shop";
import { spendByMonth, spendSlices, withEmptyMonths } from "@/lib/spend";
import { FakeDb } from "./fake-db";
import { USER, asAdmin } from "./pipeline-fixtures";

/**
 * fixtures/demo-history: the made-up year of orders the sample loads next to the anonymized real
 * mails. Written by scripts/make-demo-history.ts; these tests hold it to the plan (80 orders over
 * twelve months, all seven categories, the amounts of a household's mail order) and to its own
 * mails (every reading is a line of its mail).
 */
const DIR = path.join(process.cwd(), "fixtures", "demo-history");

type Mail = { file: string; stage: string; date: string; from: string; from_name: string; subject: string; text: string; html: null };
const mails: Mail[] = readdirSync(path.join(DIR, "mails")).map((f) => JSON.parse(readFileSync(path.join(DIR, "mails", f), "utf8")));
const extractions = JSON.parse(readFileSync(path.join(DIR, "extractions.json"), "utf8")) as Record<string, Extraction>;
const readings = Object.values(extractions);
const amounts = readings.map((x) => x.total_amount.value as number).sort((a, b) => a - b);

/** Every evidence a reading carries: each must be text of the mail. */
function evidenceOf(x: Extraction): string[] {
  const fields = [x.order_number, x.total_amount, x.ordered_at, x.carrier, x.tracking_number, x.expected_date, x.expected_date_end, x.expected_window_start, x.expected_window_end, x.requires_presence, x.package_description];
  return [x.relevance_evidence, x.expected_text, ...fields.map((f) => f.evidence), ...x.items.map((i) => i.evidence)].filter((e): e is string => e !== null);
}

describe("the history files", () => {
  it("are exactly what the script writes (seeded: the same every run), and nothing else", () => {
    const files = historyFiles();
    expect(historyFiles()).toEqual(files);
    const committed = ["set.json", "extractions.json", ...readdirSync(path.join(DIR, "mails")).map((f) => `mails/${f}`)].sort();
    expect(committed).toEqual([...files.keys()].sort());
    for (const [p, body] of files) expect(readFileSync(path.join(DIR, p), "utf8"), p).toBe(body);
  });

  it("are 80 delivered mails, one reading each", () => {
    expect(mails).toHaveLength(80);
    expect(Object.keys(extractions).sort()).toEqual(mails.map((m) => m.file).sort());
    for (const m of mails) {
      expect(m.stage, m.file).toBe("delivered");
      expect(m.file, m.file).toMatch(/^history\/\d{4}-\d{2}-\d{2}_delivered_[0-9a-f]{8}\.eml$/);
      expect(m.date, m.file).toMatch(/T\d{2}:\d{2}:00\+00:00$/);
    }
  });

  it("are not in the accuracy set: readDemoMails (scripts/eval.ts) is the 17 real mails only", async () => {
    const files = (await readDemoMails()).map((m) => m.file);
    expect(files).toHaveLength(17);
    expect(files.some((f) => f.startsWith("history/"))).toBe(false);
  });
});

describe("every reading comes from its own mail", () => {
  it.each(mails.map((m) => [m.file, m] as const))("%s: each evidence is a line of the mail, verbatim", (_, m) => {
    const x = extractions[m.file];
    const evidence = evidenceOf(x);
    // relevance, order number, amount, order date, delivery date and its text, how it was left, each item
    expect(evidence.length).toBeGreaterThanOrEqual(7 + x.items.length - 1);
    for (const e of evidence) expect(m.text.includes(e), `${m.file}: ${e}`).toBe(true);
  });

  it("still after the dates are moved to another load day", async () => {
    const now = new Date("2027-02-14T01:00:00Z");
    const entries = (await loadDemoEntries(todayJst(now), now)).filter((e) => e.mail.file.startsWith("history/"));
    expect(entries).toHaveLength(80);
    for (const { mail, extraction } of entries) {
      for (const e of evidenceOf(extraction)) expect(mail.text?.includes(e), `${mail.file}: ${e}`).toBe(true);
      // The date the reading names is the one the mail now says.
      expect(mail.text).toContain(extraction.ordered_at.evidence!);
      expect(extraction.ordered_at.value! < todayJst(now)).toBe(true);
    }
  });

  it("negative control: a reading whose line is not in the mail is caught", () => {
    const m = mails[0];
    const x = { ...extractions[m.file], total_amount: { value: 1, evidence: "ご請求額：￥1", confidence: 0.95 } };
    expect(evidenceOf(x).every((e) => m.text.includes(e))).toBe(false);
  });

  it("states what the plan asks of each: delivered, an order date, an amount, a category, left at the door, no tracking number", () => {
    for (const [file, x] of Object.entries(extractions)) {
      expect(x.relevance, file).toBe("delivered");
      expect(x.ordered_at.value, file).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(x.total_amount.value, file).toBeGreaterThan(0);
      expect(x.total_amount.value, file).toBe(x.items.reduce((s, i) => s + (i.unit_price ?? 0) * (i.quantity ?? 1), 0));
      expect(CATEGORIES, file).toContain(x.category);
      expect(x.requires_presence.value, file).toBe(false);
      expect(x.tracking_number.value, file).toBeNull();
      expect(x.items.length, file).toBeGreaterThan(0);
      expect(x.expected_date.value! >= x.ordered_at.value!, file).toBe(true);
    }
  });

  it("passes the free pre-check like a real forwarded mail", () => {
    for (const m of mails) expect(screenMail(m).pass, m.file).toBe(true);
  });
});

describe("the year it draws", () => {
  const byMonth = new Map<string, Extraction[]>();
  for (const x of readings) byMonth.set(x.ordered_at.value!.slice(0, 7), [...(byMonth.get(x.ordered_at.value!.slice(0, 7)) ?? []), x]);

  it("has the planned orders per month: 5 to 9, the anchor's month 3 or 4, 80 in all", () => {
    expect([...byMonth.keys()].sort()).toEqual(MONTHS.map(([m]) => m));
    for (const [month, n] of MONTHS) expect(byMonth.get(month)?.length, month).toBe(n);
    const counts = MONTHS.map(([, n]) => n);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(80);
    for (const n of counts.slice(0, -1)) expect(n >= 5 && n <= 9).toBe(true);
    expect([3, 4]).toContain(counts.at(-1));
    expect(byMonth.get("2025-12")!.length).toBeGreaterThan(byMonth.get("2026-02")!.length);
    expect(byMonth.get("2026-04")!.length).toBeGreaterThan(byMonth.get("2026-03")!.length);
  });

  it("has the planned categories (80): 食費 14, 日用品 18, 趣味 11, ファッション 11, 家電 11, 美容 10, その他 5", () => {
    const count = (c: string) => readings.filter((x) => x.category === c).length;
    expect(Object.fromEntries(CATEGORIES.map((c) => [c, count(c)]))).toEqual({ food: 14, daily: 18, hobby: 11, fashion: 11, electronics: 11, beauty: 10, other: 5 });
  });

  it("has food in every month, each box 1,500 to 4,000 yen", () => {
    for (const [month] of MONTHS) expect(byMonth.get(month)!.some((x) => x.category === "food"), month).toBe(true);
    for (const x of readings.filter((r) => r.category === "food")) expect(x.total_amount.value! >= 1500 && x.total_amount.value! <= 4000, x.items[0].name).toBe(true);
  });

  it("has a household's amounts: about 300,000 yen a year, median about 2,000, about 1 in 10 at 8,000 or more, one or two of 20,000 to 30,000 (家電)", () => {
    const total = amounts.reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThanOrEqual(280_000);
    expect(total).toBeLessThanOrEqual(320_000);
    const median = (amounts[39] + amounts[40]) / 2;
    expect(median).toBeGreaterThanOrEqual(1_800);
    expect(median).toBeLessThanOrEqual(2_200);
    expect(amounts.filter((a) => a >= 1_000 && a <= 4_000).length).toBeGreaterThanOrEqual(48);
    const high = amounts.filter((a) => a >= 8_000).length;
    expect(high).toBeGreaterThanOrEqual(6);
    expect(high).toBeLessThanOrEqual(10);
    const big = readings.filter((x) => x.total_amount.value! >= 20_000);
    expect(big.length === 1 || big.length === 2).toBe(true);
    for (const x of big) {
      expect(x.total_amount.value!).toBeLessThanOrEqual(30_000);
      expect(x.category).toBe("electronics");
    }
  });

  it("has the planned shops: Amazon 45%, 楽天市場 20% in several shops, Yahoo!ショッピング 8%, ユニクロ, 家電の量販店, アイリスプラザ, 日用品の通販 and others about 5% each", () => {
    const byKey = (k: string) => readings.filter((x) => x.shop_key === k).length;
    expect(byKey("amazon")).toBe(36);
    expect(byKey("rakuten")).toBe(16);
    expect(new Set(readings.filter((x) => x.shop_key === "rakuten").map((x) => x.shop_name)).size).toBeGreaterThanOrEqual(5);
    expect(byKey("yahoo")).toBe(6);
    expect(byKey("uniqlo")).toBe(5);
    expect(byKey("yodobashi")).toBe(5);
    expect(byKey("irisplaza")).toBe(4);
    expect(readings.filter((x) => x.shop_name === "日用品の通販 くらしモール").length).toBe(4);
    expect(byKey("other")).toBe(8);
  });

  it("covers one year that ends the day before the anchor: nothing later, nothing more than 365 days back", () => {
    const last = addDays(ANCHOR, -1);
    const first = addDays(ANCHOR, -365);
    for (const x of readings) {
      expect(x.expected_date.value! <= last, x.order_number.value!).toBe(true);
      expect(x.ordered_at.value! > first, x.order_number.value!).toBe(true);
    }
    for (const m of mails) expect(todayJst(new Date(m.date)) <= last, m.file).toBe(true);
    expect(CATALOG).toHaveLength(80);
  });
});

describe("what the judges see after loading", () => {
  const now = new Date("2026-11-08T00:30:00Z");
  const today = todayJst(now);

  it("12 months of bars on the whole-period spend page, all 7 colours, and no history mail from the future", async () => {
    const entries = await loadDemoEntries(today, now);
    for (const { mail } of entries) expect(new Date(mail.date!).getTime(), mail.file).toBeLessThanOrEqual(now.getTime());
    const history = entries.filter((e) => e.mail.file.startsWith("history/"));
    for (const { mail } of history) expect(todayJst(new Date(mail.date!)) < today, mail.file).toBe(true);
    const parcels = history.map(({ mail, extraction }) => buildParcelInsert(USER, extraction, mail.date));
    const bars = withEmptyMonths(spendByMonth(parcels.map((p) => ({ ordered_at: p.ordered_at ?? null, total_amount: p.total_amount ?? null, category: p.category ?? null }))));
    expect(bars).toHaveLength(12);
    expect(bars.every((b) => b.total > 0)).toBe(true);
    expect(bars.at(-1)!.month).toBe(today.slice(0, 7));
    expect(new Set(bars.flatMap((b) => b.segments.map((s) => s.category)))).toEqual(new Set(CATEGORIES));
  });

  it("counts each shop under its own name, though every sender is on sample.otodoke.app", async () => {
    const entries = (await loadDemoEntries(today, now)).filter((e) => e.mail.file.startsWith("history/"));
    expect(new Set(entries.map((e) => e.mail.from.split("@")[1]))).toEqual(new Set(["sample.otodoke.app"]));
    const parcels = entries.map(({ mail, extraction }) => ({ ...buildParcelInsert(USER, extraction, mail.date), shop_key: extraction.shop_key }) as { shop: string; shop_key: string | null; ordered_at: string | null; total_amount: number | null; category: string | null });
    const shops = new Map<string, number>();
    for (const p of parcels) shops.set(normalizeShop(p), (shops.get(normalizeShop(p)) ?? 0) + 1);
    expect(shops.get("Amazon")).toBe(36);
    expect(shops.get("ユニクロ オンラインストア")).toBe(5);
    expect(shops.size).toBeGreaterThanOrEqual(20);
    expect(spendSlices(parcels, { all: true, c: undefined, s: "アイリスプラザ" }).picked).toHaveLength(4);
  });

  it("goes through the real pipeline as 80 delivered parcels of their own, in 13 database round trips a mail", async () => {
    // The load-time estimate made when the history was added: 13 round trips per history mail, 1,247 for
    // all 97 sample mails. A change that makes a mail cost more should look at that again.
    const db = new FakeDb(undefined, Date.now());
    const sampleDb = await beginSampleLoad(asAdmin(db), USER);
    const entries = await loadDemoEntries(today, now);
    let trips = 0;
    for (const e of entries) {
      const before = db.calls.filter((q) => !q.viaRpc).length + db.rpcCalls.filter((q) => !q.internal).length;
      const input = demoInput(e, USER);
      const out = await processInboundEmail(sampleDb, input.mail, input.options);
      expect(out.kind, e.mail.file).toBe("processed");
      const cost = db.calls.filter((q) => !q.viaRpc).length + db.rpcCalls.filter((q) => !q.internal).length - before;
      if (e.mail.file.startsWith("history/")) expect(cost, e.mail.file).toBeLessThanOrEqual(13);
      trips += cost;
    }
    expect(trips).toBeLessThanOrEqual(1_300);
    expect(db.rows("parcels")).toHaveLength(86);
    const delivered = db.rows("parcels").filter((p) => p.status === "delivered");
    // 80 history parcels and the web camera of the real mails.
    expect(delivered).toHaveLength(81);
    expect(db.rows("emails").every((r) => r.user_id === USER)).toBe(true);
    // The whole-period page over every stored parcel, the real mails' ones included: still 12 bars, 7 colours.
    const stored = db.rows("parcels").filter((p) => p.status !== "cancelled") as Array<{ ordered_at: string | null; total_amount: number | null; category: string | null }>;
    const bars = withEmptyMonths(spendByMonth(stored));
    expect(bars.map((b) => b.month)).toEqual(Array.from({ length: 12 }, (_, i) => shiftMonth(today.slice(0, 7), i - 11)));
    expect(new Set(bars.flatMap((b) => b.segments.map((x) => x.category)))).toEqual(new Set(CATEGORIES));
  });
});
