import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InboundEmail } from "@/lib/pipeline";
import { SHARED_MAIL_DOMAINS, isRememberableDomain } from "@/lib/screen-senders";
import { FakeDb } from "./fake-db";
import { USER, asAdmin, item, mailOf, precomputed, reading, sure } from "./pipeline-fixtures";

/**
 * 「これは荷物」 after the review of 2026-11-06 (B-3, F-1). Made-up mails only.
 *
 * A marked sender used to skip the free rules AND the cheap Claude check, forever, by domain: the
 * ads of a marked shop each paid for a full reading, anyone could write that domain in From, and a
 * mark on a manual forward (from the user's own gmail.com) sent every gmail.com mail, a friend's
 * included, to Claude. Now a mark only keeps the free rules from dropping a mail: the cheap check
 * still decides. A shared domain is never taken as marked, not even by a mark made before.
 */

const order = reading({ relevance: "order", order_number: sure("ORD-55550000"), items: [item("テスト商品", 900)], total_amount: sure(900) });
const mocks = vi.hoisted(() => ({ extractEmail: vi.fn(), isPurchaseMail: vi.fn() }));
vi.mock("@/lib/extract/extract", () => ({ extractEmail: mocks.extractEmail }));
vi.mock("@/lib/extract/triage", () => ({ isPurchaseMail: mocks.isPurchaseMail }));

const { processInboundEmail } = await import("@/lib/pipeline");

const claims = (db: FakeDb) => db.rpcCalls.filter((c) => c.name === "claim_claude_call").length;

/** An ad the free rules drop and are sure about (not borderline): no order label, an unsubscribe note. */
function ad(i: number, from = "news@mall.example.test"): InboundEmail {
  return { ...mailOf("2026-11-03T01:00:00Z"), messageId: `<ad-${i}@example.test>`, from, subject: `今週のおすすめ ${i}`, text: "新着アイテムのご案内。配信停止はこちら" };
}

function mark(db: FakeDb, from_domain: string) {
  db.rows("screen_events").push({ id: `flag-${from_domain}`, user_id: USER, decision: "dropped", subject: "前に落としたメール", from_domain, flagged_at: "2026-11-02T00:00:00Z", created_at: "2026-11-02T00:00:00Z" });
}

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon");
  mocks.extractEmail.mockReset();
  mocks.extractEmail.mockImplementation(async () => precomputed(order));
  mocks.isPurchaseMail.mockReset();
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("a sender marked 「これは荷物」", () => {
  it("still goes past the cheap check: five ads from a marked shop cost five cheap checks and no full reading", async () => {
    mocks.isPurchaseMail.mockResolvedValue(false);
    const db = new FakeDb();
    mark(db, "mall.example.test");
    for (let i = 0; i < 5; i++) expect((await processInboundEmail(asAdmin(db), ad(i))).kind).toBe("screened_out");
    expect(mocks.isPurchaseMail).toHaveBeenCalledTimes(5);
    expect(mocks.extractEmail).not.toHaveBeenCalled();
    expect(claims(db)).toBe(5);
    expect(db.rows("emails")).toHaveLength(0);
  });

  it("is read when the cheap check says it is a purchase notice", async () => {
    mocks.isPurchaseMail.mockResolvedValue(true);
    const db = new FakeDb();
    mark(db, "mall.example.test");
    const out = await processInboundEmail(asAdmin(db), ad(1));
    expect(out.kind).toBe("processed");
    expect(mocks.isPurchaseMail).toHaveBeenCalledTimes(1);
    expect(mocks.extractEmail).toHaveBeenCalledTimes(1);
    expect(db.rows("screen_events").filter((e) => e.decision === "rescued")).toHaveLength(1);
  });

  it("control: the same ad from an unmarked sender costs nothing", async () => {
    const db = new FakeDb();
    mark(db, "mall.example.test");
    expect((await processInboundEmail(asAdmin(db), ad(1, "news@other.example.test"))).kind).toBe("screened_out");
    expect(mocks.isPurchaseMail).not.toHaveBeenCalled();
    expect(claims(db)).toBe(0);
  });

  it("a failed mark lookup counts as marked: the cheap check decides, the mail is not dropped by a database error", async () => {
    mocks.isPurchaseMail.mockResolvedValue(true);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const db = new FakeDb();
    db.hooks.push((q) => (q.table === "screen_events" && q.op === "select" ? { data: null, error: { message: "timeout" }, count: null } : undefined));
    expect((await processInboundEmail(asAdmin(db), ad(1))).kind).toBe("processed");
    expect(mocks.isPurchaseMail).toHaveBeenCalledTimes(1);
    log.mockRestore();
  });
});

describe("a shared domain is never taken as marked", () => {
  const friend = (): InboundEmail => ({ ...mailOf("2026-11-06T02:00:00Z"), messageId: "<friend@mail.gmail.com>", from: "friend@gmail.com", subject: "週末どう？", text: "土曜日あいてる？ ごはん行こう" });

  it("a mark on gmail.com made before this rule does not send a friend's mail to Claude", async () => {
    const db = new FakeDb();
    mark(db, "gmail.com");
    expect((await processInboundEmail(asAdmin(db), friend())).kind).toBe("screened_out");
    expect(mocks.isPurchaseMail).not.toHaveBeenCalled();
    expect(mocks.extractEmail).not.toHaveBeenCalled();
    expect(claims(db)).toBe(0);
  });

  it("negative control: the same mark on a shop's own domain is honoured", async () => {
    mocks.isPurchaseMail.mockResolvedValue(false);
    const db = new FakeDb();
    mark(db, "shop.example.test");
    await processInboundEmail(asAdmin(db), { ...friend(), from: "info@shop.example.test" });
    expect(mocks.isPurchaseMail).toHaveBeenCalledTimes(1);
  });
});

describe("SHARED_MAIL_DOMAINS", () => {
  it("has the free-mail and carrier domains named in the review, once each, lower case", () => {
    for (const d of ["gmail.com", "googlemail.com", "yahoo.co.jp", "icloud.com", "me.com", "outlook.com", "hotmail.com", "docomo.ne.jp", "ezweb.ne.jp", "au.com", "softbank.ne.jp", "i.softbank.jp"]) {
      expect(SHARED_MAIL_DOMAINS, d).toContain(d);
    }
    expect(new Set(SHARED_MAIL_DOMAINS).size).toBe(SHARED_MAIL_DOMAINS.length);
    for (const d of SHARED_MAIL_DOMAINS) expect(d).toBe(d.trim().toLowerCase());
  });

  it("isRememberableDomain: a shop's domain yes; shared, empty and missing no; exact match only", () => {
    expect(isRememberableDomain("shop.example.test")).toBe(true);
    expect(isRememberableDomain("amazon.co.jp")).toBe(true);
    // A big provider's own system subdomain is where its shop mail comes from, not people's addresses.
    expect(isRememberableDomain("mail.yahoo.co.jp")).toBe(true);
    expect(isRememberableDomain("gmail.com")).toBe(false);
    expect(isRememberableDomain(" GMail.com. ")).toBe(false);
    expect(isRememberableDomain("docomo.ne.jp")).toBe(false);
    expect(isRememberableDomain("")).toBe(false);
    expect(isRememberableDomain(null)).toBe(false);
    expect(isRememberableDomain(undefined)).toBe(false);
  });

  it("no demo shop is on the list (the sample mails stay markable)", async () => {
    const { readFileSync, readdirSync } = await import("node:fs");
    const path = await import("node:path");
    const dir = path.resolve(__dirname, "../../../fixtures/demo/mails");
    const senders = readdirSync(dir).map((f) => (JSON.parse(readFileSync(path.join(dir, f), "utf8")) as { from: string }).from);
    expect(senders.length).toBeGreaterThan(10);
    for (const from of senders) expect(isRememberableDomain(from.split("@")[1]), from).toBe(true);
  });
});
