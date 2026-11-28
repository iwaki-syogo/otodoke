import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InboundEmail } from "@/lib/pipeline";
import { senderFailedDmarc } from "@/lib/forwarding";
import { FakeDb } from "./fake-db";
import { USER, asConsentingAdmin, item, mailOf, precomputed, reading, sure } from "./pipeline-fixtures";

/**
 * F01 (item 66): Gmail's forwarding confirmation also uses the sender authentication the receiving
 * server computed (Resend's `authentication`). Only a DMARC "fail" changes anything; every value that
 * is missing or unknown leaves the mail judged as before, so a real confirmation is never lost to a
 * value this code could not read. Made-up mails only.
 */
const order = reading({ relevance: "order", order_number: sure("ORD-77770000"), items: [item("テスト商品", 1200)], total_amount: sure(1200) });
const mocks = vi.hoisted(() => ({ extractEmail: vi.fn(), isPurchaseMail: vi.fn() }));
vi.mock("@/lib/extract/extract", () => ({ extractEmail: mocks.extractEmail }));
vi.mock("@/lib/extract/triage", () => ({ isPurchaseMail: mocks.isPurchaseMail }));

const { processInboundEmail } = await import("@/lib/pipeline");

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon");
  mocks.extractEmail.mockReset().mockImplementation(async () => precomputed(order));
  mocks.isPurchaseMail.mockReset().mockResolvedValue(false);
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const LINK = "https://mail-settings.google.com/mail/vf-test-link";
const confirmation = (over: Partial<InboundEmail> = {}): InboundEmail => ({
  ...mailOf("2026-11-03T02:00:00Z"), messageId: "<confirm-1@example.test>", providerEmailId: "PID-1",
  subject: "Gmail Forwarding Confirmation", text: `Please confirm: ${LINK}`, from: "forwarding-noreply@google.com", ...over,
});
const withLink = (db: FakeDb) => db.rows("emails").filter((r) => r.forwarding_confirm_url);
const intakeClaims = (db: FakeDb) => db.rpcCalls.filter((c) => c.name === "claim_mail_intake").length;

describe("senderFailedDmarc reads only a DMARC fail", () => {
  it.each<[string, unknown]>([
    ["no field", undefined],
    ["null (older mail)", null],
    ["not an object", "fail"],
    ["an empty object", {}],
    ["dmarc null", { dmarc: null }],
    ["dmarc pass", { spf: "pass", dkim: "pass", dmarc: "pass" }],
    ["dmarc gray", { dmarc: "gray" }],
    ["dmarc processing_failed", { dmarc: "processing_failed" }],
    ["dmarc unknown", { dmarc: "unknown" }],
    ["a value this code does not know", { dmarc: "temperror" }],
    ["not a string", { dmarc: 0 }],
    // DMARC passes on DKIM alone when mail is forwarded; SPF or DKIM failing by itself is not DMARC failing.
    ["spf and dkim fail, dmarc not given", { spf: "fail", dkim: "fail" }],
    ["spf fail, dmarc pass", { spf: "fail", dkim: "pass", dmarc: "pass" }],
  ])("%s: not a failure", (_name, value) => {
    expect(senderFailedDmarc(value)).toBe(false);
  });
  it.each<[string, unknown]>([
    ["fail", { spf: "fail", dkim: "fail", dmarc: "fail" }],
    ["upper case with space", { dmarc: " FAIL " }],
  ])("%s: a failure", (_name, value) => {
    expect(senderFailedDmarc(value)).toBe(true);
  });
});

describe("a Gmail confirmation whose sender failed DMARC never becomes the approval card", () => {
  it("is read as an ordinary mail: no link kept, no confirmation intake taken", async () => {
    const db = new FakeDb({});
    const out = await processInboundEmail(asConsentingAdmin(db), confirmation({ senderFailedDmarc: true }));
    expect(out.kind).not.toBe("forwarding_confirmation");
    expect(withLink(db)).toEqual([]);
    expect(intakeClaims(db)).toBe(0);
    // Logged without an address or the link.
    expect(JSON.stringify(warn.mock.calls)).toContain("failed dmarc");
    expect(JSON.stringify(warn.mock.calls)).not.toContain(LINK);
  });

  it.each<[string, boolean | undefined]>([
    ["not failed", false],
    ["nothing known", undefined],
  ])("control, %s: the link is kept as before", async (_name, failed) => {
    const db = new FakeDb({});
    const out = await processInboundEmail(asConsentingAdmin(db), confirmation({ senderFailedDmarc: failed }));
    expect(out.kind).toBe("forwarding_confirmation");
    expect(withLink(db)).toHaveLength(1);
    expect(intakeClaims(db)).toBe(1);
  });

  it("an ordinary sender is unaffected by the flag", async () => {
    const db = new FakeDb({});
    const out = await processInboundEmail(asConsentingAdmin(db), confirmation({ from: "shop@example.test", senderFailedDmarc: true }));
    expect(out.kind).not.toBe("forwarding_confirmation");
    expect(JSON.stringify(warn.mock.calls)).not.toContain("failed dmarc");
  });
});

describe("a stored mail read again carries no authentication, so only a row kept as a confirmation can be one", () => {
  const seeded = (classification: string | null) => new FakeDb({
    emails: [{
      id: "e-a", user_id: USER, message_id: "<confirm-1@example.test>", provider_email_id: "PID-1",
      subject: "Gmail Forwarding Confirmation", text_body: `Please confirm: ${LINK}`, html_body: null,
      from_address: "forwarding-noreply@google.com", from_name: null, processing_status: "failed",
      created_at: "2026-11-01T00:00:00Z", body_state: "plain", classification, forwarding_confirm_url: null,
    }],
  });

  it("a forged one stored as an ordinary mail (waiting to be read) stays an ordinary mail on the re-read", async () => {
    const db = seeded(null);
    const out = await processInboundEmail(asConsentingAdmin(db), confirmation(), { replacesEmailId: "e-a", replacesCreatedAt: "2026-11-01T00:00:00Z" }).catch((e: unknown) => e);
    expect((out as { kind?: string }).kind).not.toBe("forwarding_confirmation");
    expect(withLink(db)).toEqual([]);
  });

  // What is stored decides here: the columns sent to store_mail_run. (The fake store then reproduces
  // the lease error of a confirmation row taken over, as in confirmation-collision.test.ts.)
  const storedColumns = (db: FakeDb) => db.rpcCalls.filter((c) => c.name === "store_mail_run").map((c) => (c.args as { p_columns: Record<string, unknown> }).p_columns);

  it("the forged one's re-read sends no link to the store", async () => {
    const db = seeded(null);
    await processInboundEmail(asConsentingAdmin(db), confirmation(), { replacesEmailId: "e-a", replacesCreatedAt: "2026-11-01T00:00:00Z" }).catch(() => undefined);
    for (const columns of storedColumns(db)) expect(columns).toMatchObject({ classification: null, forwarding_confirm_url: null });
  });

  it("control: a row kept as a confirmation is still one on the re-read", async () => {
    const db = seeded("forwarding_confirmation");
    await processInboundEmail(asConsentingAdmin(db), confirmation(), { replacesEmailId: "e-a", replacesCreatedAt: "2026-11-01T00:00:00Z" }).catch(() => undefined);
    expect(storedColumns(db)).toEqual([expect.objectContaining({ classification: "forwarding_confirmation", forwarding_confirm_url: LINK })]);
  });
});
