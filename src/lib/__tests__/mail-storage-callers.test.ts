import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runLoadDemo } from "@/lib/demo-run";
import { runReadWaitingMail } from "@/lib/mail-run";
import { processInboundEmail } from "@/lib/pipeline";
import { demoInput, type DemoEntry } from "@/lib/demo";
import { READ_STORAGE_LIMIT_REASON } from "@/lib/read-notices";
import { FakeDb, type Row } from "./fake-db";
import { USER, asConsentingAdmin, precomputed, reading } from "./pipeline-fixtures";

const mocks = vi.hoisted(() => ({ entries: [] as DemoEntry[], extract: vi.fn(), triage: vi.fn() }));
vi.mock("@/lib/demo", async (actual) => ({
  ...(await actual<typeof import("@/lib/demo")>()),
  loadDemoEntries: async () => mocks.entries,
}));
vi.mock("@/lib/extract/extract", () => ({ extractEmail: mocks.extract }));
vi.mock("@/lib/extract/triage", () => ({ isPurchaseMail: mocks.triage }));

const sample = (text = "Synthetic order body"): DemoEntry => ({
  mail: { file: "synthetic/order", source: "synthetic", stage: "order", message_id: null,
    date: "2026-11-12T00:00:00Z", from: "orders@example.test", from_name: null,
    subject: "Synthetic order", text, html: null },
  extraction: reading({ relevance: "other_purchase" }),
});
const waiting = (id: string): Row => ({
  id, user_id: USER, provider_email_id: `provider-${id}`, message_id: `<${id}@example.test>`,
  from_address: "orders@example.test", from_name: null, subject: "Synthetic order", text_body: "Synthetic body", html_body: null,
  body_state: "plain", processing_status: "over_limit", created_at: "2026-11-11T00:00:00Z", sent_at: "2026-11-11T00:00:00Z",
});

beforeEach(() => {
  vi.stubEnv("OTODOKE_UNREAD_USER_MAIL_LIMIT", "2");
  vi.stubEnv("OTODOKE_UNREAD_GLOBAL_MAIL_LIMIT", "20");
  vi.stubEnv("OTODOKE_UNREAD_USER_BYTE_LIMIT", "100000");
  vi.stubEnv("OTODOKE_UNREAD_GLOBAL_BYTE_LIMIT", "1000000");
  mocks.entries = [sample()];
  mocks.extract.mockReset(); mocks.triage.mockReset();
});
afterEach(() => { vi.unstubAllEnvs(); });

describe("storage limits keep caller success counts honest", () => {
  it("fails a sample load at the ceiling, keeps its notice, and succeeds after unread mail is read", async () => {
    const db = new FakeDb({ emails: [waiting("waiting-1"), waiting("waiting-2")] });
    const result = await runLoadDemo(() => asConsentingAdmin(db), USER);
    expect(result).toMatchObject({ ok: false, processed: 0, message: "mail storage limit: user_storage_limit" });
    expect(db.rows("emails")).toHaveLength(2);
    expect(db.rows("mail_intake_notices")).toMatchObject([{ user_id: USER, reason: "user_storage_limit" }]);
    expect(READ_STORAGE_LIMIT_REASON).toContain("未読を読み取ったあと");

    const old = waiting("waiting-1");
    await processInboundEmail(asConsentingAdmin(db), {
      userId: USER, providerEmailId: String(old.provider_email_id), messageId: String(old.message_id),
      from: String(old.from_address), fromName: null, subject: String(old.subject), sentAt: String(old.sent_at),
      text: String(old.text_body), html: null,
    }, { precomputed: precomputed(reading({ relevance: "other_purchase" })) });
    expect(await runLoadDemo(() => asConsentingAdmin(db), USER)).toMatchObject({ ok: true, processed: 1 });
    expect(mocks.extract).not.toHaveBeenCalled();
    expect(mocks.triage).not.toHaveBeenCalled();
  });

  it("does not count a rejected sample re-read when its precomputed body grew beyond the ceiling", async () => {
    const original = sample();
    const input = demoInput(original, USER).mail;
    const stored = { ...waiting("waiting-sample"), provider_email_id: input.providerEmailId, message_id: input.messageId,
      from_address: input.from, subject: input.subject, text_body: input.text };
    const db = new FakeDb({ emails: [stored] });
    const before = structuredClone(db.rows("emails"));
    mocks.entries = [sample("x".repeat(100_001))];
    const result = await runReadWaitingMail(asConsentingAdmin(db), USER);
    expect(result).toMatchObject({ ok: false, stage: "read", read: 0, onlyBusy: false, overLimit: false, unavailable: false });
    expect(db.rows("emails")).toEqual(before);
    expect(db.rows("mail_intake_notices")).toHaveLength(1);
    expect(mocks.extract).not.toHaveBeenCalled();

    mocks.entries = [original];
    expect(await runReadWaitingMail(asConsentingAdmin(db), USER)).toMatchObject({ ok: true, read: 1 });
    expect(db.rows("emails")[0].processing_status).toBe("processed");
  });
});
