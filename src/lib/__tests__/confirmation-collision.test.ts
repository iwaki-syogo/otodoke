import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InboundEmail } from "@/lib/pipeline";
import { FakeDb } from "./fake-db";
import { USER, asConsentingAdmin, item, mailOf, precomputed, reading, sure } from "./pipeline-fixtures";

/**
 * A-58: a Gmail forwarding confirmation whose Message-ID hits a stored row that is not itself a
 * confirmation row must not take that row over (it would overwrite the original and then fail on
 * the extraction delete). It is discarded with nothing written. Made-up mails only.
 */
const order = reading({ relevance: "order", order_number: sure("ORD-77770000"), items: [item("テスト商品", 1200)], total_amount: sure(1200) });
const mocks = vi.hoisted(() => ({ extractEmail: vi.fn(), isPurchaseMail: vi.fn() }));
vi.mock("@/lib/extract/extract", () => ({ extractEmail: mocks.extractEmail }));
vi.mock("@/lib/extract/triage", () => ({ isPurchaseMail: mocks.isPurchaseMail }));

const { processInboundEmail } = await import("@/lib/pipeline");

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon");
  mocks.extractEmail.mockReset().mockImplementation(async () => precomputed(order));
  mocks.isPurchaseMail.mockReset().mockResolvedValue(true);
});
afterEach(() => { vi.unstubAllEnvs(); });

const MID = "<same-message@example.test>";
const STORED_AT = "2026-11-01T00:00:00Z";
const PAST = "2026-11-01T00:10:00Z";
const LINK = "https://mail-settings.google.com/mail/vf-test-link";
const ORIGINAL = { subject: "ご注文ありがとうございます", text: "ご注文番号 ORD-77770000 を承りました", from: "shop@example.test" };

const confirmation = (over: Partial<InboundEmail> = {}): InboundEmail => ({
  ...mailOf("2026-11-03T02:00:00Z"), messageId: MID, providerEmailId: "PID-B",
  subject: "Gmail Forwarding Confirmation", text: `Please confirm: ${LINK}`, from: "forwarding-noreply@google.com", ...over,
});

type Seed = { status: string; pid?: string | null; lease?: string | null; body_state?: string; classification?: string | null; confirmation?: boolean };
function seeded(seed: Seed) {
  const isConf = !!seed.confirmation;
  const db = new FakeDb({
    emails: [{
      id: "e-a", user_id: USER, message_id: MID, provider_email_id: seed.pid === undefined ? "PID-A" : seed.pid,
      subject: isConf ? "Gmail Forwarding Confirmation" : ORIGINAL.subject, text_body: isConf ? `Please confirm: ${LINK}` : ORIGINAL.text, html_body: null,
      from_address: isConf ? "forwarding-noreply@google.com" : ORIGINAL.from, from_name: null,
      processing_status: seed.status, created_at: STORED_AT, body_state: seed.body_state ?? "plain",
      classification: seed.classification === undefined ? (isConf ? "forwarding_confirmation" : "order") : seed.classification,
      forwarding_confirm_url: isConf ? LINK : null,
      ...(seed.lease !== undefined ? { processing_lease_until: seed.lease, processing_run_id: "run-old" } : {}),
    }],
    extractions: [{ id: "x-a", email_id: "e-a", user_id: USER, model: "old" }],
  });
  return { db, admin: asConsentingAdmin(db) };
}
const stores = (db: FakeDb) => db.rpcCalls.filter((c) => c.name === "store_mail_run").length;
const claims = (db: FakeDb) => db.rpcCalls.filter((c) => /claim_claude_call/.test(c.name)).length;
const state = (db: FakeDb) => ({ emails: structuredClone(db.rows("emails")), extractions: structuredClone(db.rows("extractions")) });
const COLLISION = { kind: "discarded", reason: "forwarding_confirmation_collision" };

describe("a confirmation that hits a stored row which is not a confirmation row is discarded untouched", () => {
  it.each<[string, Seed]>([
    ["failed", { status: "failed" }],
    ["over_limit", { status: "over_limit" }],
    ["pending with an expired lease", { status: "pending", lease: PAST }],
    ["failed with a null classification", { status: "failed", classification: null }],
    ["failed and sealed", { status: "failed", body_state: "sealed" }],
  ])("%s", async (_name, seed) => {
    const { db, admin } = seeded(seed);
    const before = state(db);
    const out = await processInboundEmail(admin, confirmation());
    expect(out).toEqual(COLLISION);
    expect(db.rows("emails")[0]).toMatchObject({ id: "e-a", provider_email_id: "PID-A", subject: ORIGINAL.subject, text_body: ORIGINAL.text, from_address: ORIGINAL.from, forwarding_confirm_url: null });
    expect(state(db)).toEqual(before);
    expect(stores(db)).toBe(0);
    expect(claims(db)).toBe(0);
    expect(mocks.isPurchaseMail).not.toHaveBeenCalled();
    expect(mocks.extractEmail).not.toHaveBeenCalled();
    expect(db.rows("screen_events") ?? []).toEqual([]);
  });
});

describe("classification is readable on a sealed or dropped row, so a confirmation row is not mistaken", () => {
  it("a sealed confirmation row is not a collision", async () => {
    const { admin } = seeded({ status: "failed", confirmation: true, body_state: "sealed" });
    const out = await processInboundEmail(admin, confirmation()).catch((e: unknown) => e);
    expect(out).not.toEqual(COLLISION);
  });
  it("a dropped non-confirmation row is a collision", async () => {
    const { admin } = seeded({ status: "failed", body_state: "dropped" });
    expect(await processInboundEmail(admin, confirmation())).toEqual(COLLISION);
  });
});

describe("controls that still go the way they did", () => {
  it("a new Message-ID confirmation is stored and gets its link", async () => {
    const db = new FakeDb({});
    const out = await processInboundEmail(asConsentingAdmin(db), confirmation());
    expect(out.kind).toBe("forwarding_confirmation");
    expect(db.rows("emails")[0]).toMatchObject({ classification: "forwarding_confirmation", forwarding_confirm_url: LINK });
  });
  it("a confirmation without a Message-ID succeeds", async () => {
    const db = new FakeDb({});
    const out = await processInboundEmail(asConsentingAdmin(db), confirmation({ messageId: null }));
    expect(out.kind).toBe("forwarding_confirmation");
  });
  it("the same confirmation again (same PID, processed) is a duplicate", async () => {
    const { db, admin } = seeded({ status: "processed", confirmation: true, pid: "PID-B" });
    expect(await processInboundEmail(admin, confirmation())).toMatchObject({ kind: "duplicate", emailId: "e-a" });
    expect(db.rows("emails")).toHaveLength(1);
  });
  it("a resend of the confirmation under another PID (processed) is a duplicate", async () => {
    const { admin } = seeded({ status: "processed", confirmation: true });
    expect(await processInboundEmail(admin, confirmation())).toMatchObject({ kind: "duplicate", emailId: "e-a" });
  });
  it("a resend of a not-processed confirmation row is not discarded as a collision", async () => {
    const { admin } = seeded({ status: "failed", confirmation: true });
    // Today this path is left as it was (the fake store reproduces the lease error); only the collision answer is excluded.
    const out = await processInboundEmail(admin, confirmation()).catch((e: unknown) => e);
    expect(out).not.toEqual(COLLISION);
  });
  it("a retry of the same delivery (same PID) onto a failed row with a null classification is not a collision", async () => {
    const { db, admin } = seeded({ status: "failed", classification: null, pid: "PID-B" });
    const out = await processInboundEmail(admin, confirmation()).catch((e: unknown) => e);
    expect(out).not.toEqual(COLLISION);
    expect(stores(db)).toBeGreaterThan(0);
  });
  it("another delivery (other PID) onto a failed row with a null classification is a collision, nothing written", async () => {
    const { db, admin } = seeded({ status: "failed", classification: null, pid: "PID-A" });
    const before = state(db);
    expect(await processInboundEmail(admin, confirmation())).toEqual(COLLISION);
    expect(db.rows("emails")[0]).toMatchObject({ id: "e-a", provider_email_id: "PID-A", subject: ORIGINAL.subject, text_body: ORIGINAL.text, from_address: ORIGINAL.from, processing_status: "failed", classification: null, forwarding_confirm_url: null });
    expect(state(db)).toEqual(before);
    expect(stores(db)).toBe(0);
  });
  it("an ordinary mail that hits a stored row is not discarded as a collision", async () => {
    const { admin } = seeded({ status: "failed" });
    const out = await processInboundEmail(admin, { ...confirmation(), from: "shop@example.test", subject: ORIGINAL.subject, text: ORIGINAL.text, providerEmailId: "PID-A" });
    expect(out).not.toEqual(COLLISION);
  });
});
