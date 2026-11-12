import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InboundEmail } from "@/lib/pipeline";
import { screenMail } from "@/lib/screen";
import { FakeDb } from "./fake-db";
import { OTHER, USER, asAdmin, asConsentingAdmin, item, mailOf, precomputed, reading, sure } from "./pipeline-fixtures";

/**
 * A46-1: a second delivery of a mail (same Message-ID, another provider ID) that the free screen
 * would drop for a new mail must not take over the stored row, overwrite its original, delete its
 * extraction or remove the row. Made-up mails only.
 */
const order = reading({ relevance: "order", order_number: sure("ORD-77770000"), items: [item("テスト商品", 1200)], total_amount: sure(1200) });
const mocks = vi.hoisted(() => ({ extractEmail: vi.fn(), isPurchaseMail: vi.fn() }));
vi.mock("@/lib/extract/extract", () => ({ extractEmail: mocks.extractEmail }));
vi.mock("@/lib/extract/triage", () => ({ isPurchaseMail: mocks.isPurchaseMail }));

const { processInboundEmail, MailBeingReadError } = await import("@/lib/pipeline");

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon");
  mocks.extractEmail.mockReset().mockImplementation(async () => precomputed(order));
  mocks.isPurchaseMail.mockReset().mockResolvedValue(true);
});
afterEach(() => { vi.unstubAllEnvs(); });

const MID = "<same-message@example.test>";
const STORED_AT = "2026-11-01T00:00:00Z";
const ORIGINAL = { subject: "ご注文ありがとうございます", text: "ご注文番号 ORD-77770000 を承りました", from: "shop@example.test" };
const DROPPED = { subject: "週末セールのお知らせ", text: "今週末は全品がお得です。お気に入りの商品をぜひご覧ください。", from: "shop@example.test" };

const original = (over: Partial<InboundEmail> = {}): InboundEmail => ({ ...mailOf("2026-11-03T01:00:00Z"), messageId: MID, providerEmailId: "PID-A", ...ORIGINAL, ...over });
const second = (over: Partial<InboundEmail> = {}): InboundEmail => ({ ...mailOf("2026-11-03T02:00:00Z"), messageId: MID, providerEmailId: "PID-B", ...DROPPED, ...over });

type Seed = { status: string; pid?: string | null; lease?: string | null; body_state?: string; user?: string; mid?: string | null; content?: typeof ORIGINAL };
function seeded(seed: Seed, withConsent = true) {
  const c = seed.content ?? ORIGINAL;
  const db = new FakeDb({
    emails: [{
      id: "e-a", user_id: seed.user ?? USER, message_id: seed.mid === undefined ? MID : seed.mid, provider_email_id: seed.pid === undefined ? "PID-A" : seed.pid,
      subject: c.subject, text_body: c.text, html_body: null, from_address: c.from, from_name: null,
      processing_status: seed.status, created_at: STORED_AT, body_state: seed.body_state ?? "plain",
      ...(seed.lease !== undefined ? { processing_lease_until: seed.lease, processing_run_id: "run-old" } : {}),
    }],
    extractions: [{ id: "x-a", email_id: "e-a", user_id: seed.user ?? USER, model: "old" }],
  });
  return { db, admin: withConsent ? asConsentingAdmin(db) : asAdmin(db) };
}
const PAST = "2026-11-01T00:10:00Z";
const claims = (db: FakeDb) => db.rpcCalls.filter((c) => /claim_claude_call/.test(c.name)).length;
const stores = (db: FakeDb) => db.rpcCalls.filter((c) => c.name === "store_mail_run").length;
const state = (db: FakeDb) => ({ emails: structuredClone(db.rows("emails")), extractions: structuredClone(db.rows("extractions")) });
const noPaidWork = (db: FakeDb) => {
  expect(claims(db)).toBe(0);
  expect(mocks.isPurchaseMail).not.toHaveBeenCalled();
  expect(mocks.extractEmail).not.toHaveBeenCalled();
};

describe("the hard-drop body used here really is dropped by the free screen", () => {
  it("is not passing and not borderline", () => {
    const s = screenMail({ subject: DROPPED.subject, text: DROPPED.text, html: null });
    expect(s.pass).toBe(false);
    expect(s.borderline).toBe(false);
  });
});

describe("a different delivery of a stored mail that a new mail would be dropped for leaves the stored row alone", () => {
  const cases: Array<[string, Seed, boolean]> = [
    ["failed, allowed", { status: "failed" }, true],
    ["over_limit, allowed", { status: "over_limit" }, true],
    ["pending with an expired lease, allowed", { status: "pending", lease: PAST }, true],
    ["failed, not allowed", { status: "failed" }, false],
  ];
  for (const [name, seed, consent] of cases) {
    it(name, async () => {
      const { db, admin } = seeded(seed, consent);
      const before = state(db);
      const out = await processInboundEmail(admin, second());
      expect(out.kind).toBe("screened_out");
      expect(db.rows("emails")[0]).toMatchObject({ id: "e-a", provider_email_id: "PID-A", subject: ORIGINAL.subject, text_body: ORIGINAL.text, from_address: ORIGINAL.from });
      expect(db.rows("extractions")).toHaveLength(1);
      expect(state(db)).toEqual(before);
      expect(stores(db)).toBe(0);
      noPaidWork(db);
    });
  }
});

describe("controls that still go the way they did", () => {
  it("a new mail that is dropped reserves nothing", async () => {
    const db = new FakeDb({});
    const out = await processInboundEmail(asConsentingAdmin(db), second());
    expect(out.kind).toBe("screened_out");
    expect(db.rows("emails")).toEqual([]);
    expect(stores(db)).toBe(0);
    noPaidWork(db);
  });
  it("the same delivery again (same provider ID) takes its row over and reads it", async () => {
    const { db, admin } = seeded({ status: "failed" });
    const out = await processInboundEmail(admin, original());
    expect(out).toMatchObject({ kind: "processed", emailId: "e-a" });
    expect(db.rows("emails")).toHaveLength(1);
  });
  it("another provider ID with the same original is a legitimate alias and is read", async () => {
    const { db, admin } = seeded({ status: "failed" });
    const out = await processInboundEmail(admin, original({ providerEmailId: "PID-B" }));
    expect(out).toMatchObject({ kind: "processed", emailId: "e-a" });
    expect(db.rows("emails")[0]).toMatchObject({ provider_email_id: "PID-B" });
  });
  it("another Message-ID is a different mail: the stored one is not touched", async () => {
    const { db, admin } = seeded({ status: "failed" });
    const before = state(db);
    const out = await processInboundEmail(admin, second({ messageId: "<other-message@example.test>" }));
    expect(out.kind).toBe("screened_out");
    expect(state(db)).toEqual(before);
  });
  it("another person's mail with the same Message-ID is not matched", async () => {
    const { db, admin } = seeded({ status: "failed", user: OTHER });
    const before = state(db);
    const out = await processInboundEmail(admin, second());
    expect(out.kind).toBe("screened_out");
    expect(state(db)).toEqual(before);
  });
  it("a pending row with a live lease is busy", async () => {
    const { db, admin } = seeded({ status: "pending", lease: "2999-01-01T00:00:00Z" });
    await expect(processInboundEmail(admin, second())).rejects.toBeInstanceOf(MailBeingReadError);
    expect(db.rows("emails")[0]).toMatchObject({ provider_email_id: "PID-A", text_body: ORIGINAL.text });
  });
  it("a processed row is a duplicate", async () => {
    const { db, admin } = seeded({ status: "processed" });
    const out = await processInboundEmail(admin, second());
    expect(out).toMatchObject({ kind: "duplicate", emailId: "e-a" });
    expect(db.rows("emails")[0]).toMatchObject({ text_body: ORIGINAL.text });
  });
  it("a processed row whose body was dropped is a duplicate", async () => {
    const { db, admin } = seeded({ status: "processed", body_state: "dropped" });
    const out = await processInboundEmail(admin, second());
    expect(out).toMatchObject({ kind: "duplicate", emailId: "e-a" });
    expect(db.rows("emails")).toHaveLength(1);
  });
  it("an explicit re-read of a stored mail that was always a hard-drop still removes it", async () => {
    const { db, admin } = seeded({ status: "failed", content: DROPPED });
    const out = await processInboundEmail(admin, second({ providerEmailId: "PID-A" }), { replacesEmailId: "e-a", replacesCreatedAt: STORED_AT });
    expect(out.kind).toBe("screened_out");
    expect(db.rows("emails")).toEqual([]);
  });
});

describe("two further cases", () => {
  it("(a) a stored row with no provider ID counts as a different delivery", async () => {
    const { db, admin } = seeded({ status: "failed", pid: null });
    const before = state(db);
    const out = await processInboundEmail(admin, second());
    expect(out.kind).toBe("screened_out");
    expect(state(db)).toEqual(before);
    expect(stores(db)).toBe(0);
  });
  it("(b) an original that today's screen would drop is kept when the same original arrives under another provider ID", async () => {
    const { db, admin } = seeded({ status: "failed", content: DROPPED });
    const before = state(db);
    const out = await processInboundEmail(admin, second());
    expect(out.kind).toBe("screened_out");
    expect(state(db)).toEqual(before);
    expect(stores(db)).toBe(0);
  });
});
