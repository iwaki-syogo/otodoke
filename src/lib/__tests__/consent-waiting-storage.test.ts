import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AiReadingNotAllowedError } from "@/lib/ai-consent";
import { processInboundEmail } from "@/lib/pipeline";
import { runReadWaitingMail } from "@/lib/mail-run";
import { FakeDb } from "./fake-db";
import { USER, OTHER, asAdmin, mailOf, precomputed, reading } from "./pipeline-fixtures";

const mocks = vi.hoisted(() => ({ extract: vi.fn(), triage: vi.fn() }));
vi.mock("@/lib/extract/extract", () => ({ extractEmail: mocks.extract }));
vi.mock("@/lib/extract/triage", () => ({ isPurchaseMail: mocks.triage }));

const NOW = Date.parse("2026-11-12T00:00:00Z");
const consent = (userId: string, decision = "granted") => ({ user_id: userId, decision, decided_at: new Date().toISOString(), text_version: "v1" });
const mail = (n: number, userId = USER) => ({ ...mailOf(new Date().toISOString(), userId), providerEmailId: `consent-wait-${n}`, messageId: `<consent-wait-${n}@example.test>`, subject: "ご注文ありがとうございます", text: "ご注文番号 TEST-1" });
const wait = (db: FakeDb, n: number) => expect(processInboundEmail(asAdmin(db), mail(n))).rejects.toBeInstanceOf(AiReadingNotAllowedError);
const noPaidRead = (db: FakeDb) => {
  expect(mocks.extract).not.toHaveBeenCalled();
  expect(mocks.triage).not.toHaveBeenCalled();
  expect(db.rpcCalls.filter((c) => /claude_call/.test(c.name) || c.name === "mail_run_write" && (c.args as { p_operation?: string }).p_operation === "claim")).toEqual([]);
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon");
  vi.stubEnv("OTODOKE_UNREAD_USER_MAIL_LIMIT", "2");
  vi.stubEnv("OTODOKE_UNREAD_GLOBAL_MAIL_LIMIT", "1");
  vi.stubEnv("OTODOKE_UNREAD_USER_BYTE_LIMIT", "100000");
  vi.stubEnv("OTODOKE_UNREAD_GLOBAL_BYTE_LIMIT", "1000000");
  mocks.extract.mockReset().mockResolvedValue(precomputed(reading({ relevance: "other_purchase", relevance_evidence: "ご注文番号" })));
  mocks.triage.mockReset().mockResolvedValue(true);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

describe("consent-waiting intake stays within its person's bounded storage", () => {
  it("a failed permission lookup marks waiting mail from its original arrival even if the database decision is granted", async () => {
    const db = new FakeDb({ ai_reading_consents: [consent(USER)] });
    db.hooks.push((q) => q.table === "ai_reading_consents" && q.op === "select" ? { data: null, error: { message: "lookup unavailable" } } : undefined);
    await expect(processInboundEmail(asAdmin(db), mail(1))).rejects.toMatchObject({ code: "ai_consent_unknown" });
    const row = db.rows("emails")[0];
    const arrival = row.received_at;
    const expiry = row.consent_waiting_until;
    expect(typeof expiry).toBe("string");
    vi.setSystemTime(NOW + 24 * 3600_000);
    await expect(processInboundEmail(asAdmin(db), mail(1))).rejects.toMatchObject({ code: "ai_consent_unknown" });
    expect(row.received_at).toBe(arrival);
    expect(row.consent_waiting_until).toBe(expiry);
    expect(row.created_at).toBe(new Date().toISOString());
    noPaidRead(db);
  });

  it.each(["undecided", "declined"])("%s mail stops at the personal count without filling the global count", async (state) => {
    const db = new FakeDb({ ai_reading_consents: state === "declined" ? [consent(USER, "declined")] : [] });
    await wait(db, 1);
    await wait(db, 2);
    expect(await processInboundEmail(asAdmin(db), mail(3))).toEqual({ kind: "storage_limit", limit: "user_storage_limit" });
    expect(db.rows("emails")).toHaveLength(2);
    expect(db.rows("emails").every((r) => typeof r.consent_waiting_until === "string")).toBe(true);
    noPaidRead(db);
    db.rows("ai_reading_consents").push(consent(OTHER));
    db.rows("claude_usage_daily").push({ user_id: OTHER, day: "2026-11-12", calls: 1_000_000 });
    expect((await processInboundEmail(asAdmin(db), mail(4, OTHER))).kind).toBe("over_limit");
    expect(await processInboundEmail(asAdmin(db), mail(5, OTHER))).toEqual({ kind: "storage_limit", limit: "global_storage_limit" });
    expect(db.rows("emails")).toHaveLength(3);
    expect(db.rows("mail_intake_notices").map((r) => [r.user_id, r.reason])).toEqual([[USER, "user_storage_limit"], [OTHER, "global_storage_limit"]]);
  });

  it.each(["undecided", "declined"])("%s mail uses UTF-8 bytes for the personal limit and saves no excess body", async (state) => {
    const input = mail(1);
    const bytes = [input.subject, input.from, input.fromName, input.text, input.html].reduce<number>((sum, value) => sum + Buffer.byteLength(value ?? "", "utf8"), 0);
    const db = new FakeDb({ ai_reading_consents: state === "declined" ? [consent(USER, "declined")] : [] });
    vi.stubEnv("OTODOKE_UNREAD_USER_BYTE_LIMIT", String(bytes - 1));
    expect(await processInboundEmail(asAdmin(db), input)).toEqual({ kind: "storage_limit", limit: "user_storage_limit" });
    expect(db.rows("emails")).toEqual([]);
    vi.stubEnv("OTODOKE_UNREAD_USER_BYTE_LIMIT", String(bytes));
    await wait(db, 1);
    expect(db.rows("emails")).toHaveLength(1);
    expect(await processInboundEmail(asAdmin(db), mail(2))).toEqual({ kind: "storage_limit", limit: "user_storage_limit" });
    noPaidRead(db);
  });

  it("retrying and granting preserve the original arrival and deadline even when allowance is exhausted", async () => {
    const db = new FakeDb();
    await wait(db, 1);
    const row = db.rows("emails")[0];
    const arrival = row.received_at;
    const expiry = row.consent_waiting_until;
    expect(arrival).toBe(new Date(NOW).toISOString());
    expect(typeof expiry).toBe("string");
    vi.setSystemTime(NOW + 24 * 3600_000);
    await wait(db, 1);
    expect(row.created_at).toBe(new Date().toISOString());
    expect(row.received_at).toBe(arrival);
    expect(row.consent_waiting_until).toBe(expiry);
    db.rows("ai_reading_consents").push(consent(USER));
    db.rows("claude_usage_daily").push({ user_id: USER, day: "2026-11-13", calls: 1_000_000 });
    expect((await processInboundEmail(asAdmin(db), mail(1))).kind).toBe("over_limit");
    expect(row.received_at).toBe(arrival);
    expect(row.consent_waiting_until).toBe(expiry);
    expect(db.rows("emails")).toHaveLength(1);
  });

  it("an expired takeover removes the waiting body before Claude and reading continues with other mail", async () => {
    const db = new FakeDb();
    await wait(db, 1);
    const row = db.rows("emails")[0];
    // The deadline is assigned by the database; the runtime never repeats its retention constant.
    expect(typeof row.consent_waiting_until).toBe("string");
    vi.setSystemTime(Date.parse(String(row.consent_waiting_until)));
    db.rows("ai_reading_consents").push(consent(USER));
    expect(await processInboundEmail(asAdmin(db), mail(1))).toEqual({ kind: "discarded", reason: "ai_consent_wait_expired" });
    expect(db.rows("emails")).toEqual([]);
    noPaidRead(db);
    expect((await processInboundEmail(asAdmin(db), mail(2))).kind).toBe("noted");
    expect(mocks.extract).toHaveBeenCalledTimes(1);
  });

  it("a manual backlog run passes an expired mail without reporting a read failure", async () => {
    const db = new FakeDb();
    await wait(db, 1);
    const row = db.rows("emails")[0];
    expect(typeof row.consent_waiting_until).toBe("string");
    vi.setSystemTime(Date.parse(String(row.consent_waiting_until)));
    db.rows("ai_reading_consents").push(consent(USER));
    expect(await runReadWaitingMail(asAdmin(db), USER)).toEqual({ ok: true, read: 1, overLimit: false, unavailable: false });
    expect(db.rows("emails")).toEqual([]);
    noPaidRead(db);
  });

  it("expiry clears plaintext while keeping an already saved reading and its parcel", async () => {
    const db = new FakeDb();
    await wait(db, 1);
    const row = db.rows("emails")[0];
    expect(typeof row.consent_waiting_until).toBe("string");
    db.rows("parcels").push({ id: "partial-parcel", user_id: USER, title: "保存済みの荷物" });
    db.rows("extractions").push({ id: "partial-reading", user_id: USER, email_id: row.id, parcel_id: "partial-parcel", result: { relevance: "order" } });
    const savedReading = structuredClone(db.rows("extractions"));
    const savedParcel = structuredClone(db.rows("parcels"));
    vi.setSystemTime(Date.parse(String(row.consent_waiting_until)));
    db.rows("ai_reading_consents").push(consent(USER));
    expect(await processInboundEmail(asAdmin(db), mail(1))).toEqual({ kind: "discarded", reason: "ai_consent_wait_expired" });
    expect(db.rows("emails")).toHaveLength(1);
    expect(db.rows("emails")[0]).toMatchObject({ subject: null, from_address: null, from_name: null, text_body: null, html_body: null, body_state: "dropped", processing_status: "discarded" });
    expect(db.rows("extractions")).toEqual(savedReading);
    expect(db.rows("parcels")).toEqual(savedParcel);
    // A provider retry finds this retained FK row; it must not restore its expired content.
    const saved = structuredClone(db.tables);
    expect(await processInboundEmail(asAdmin(db), mail(1))).toEqual({ kind: "discarded", reason: "ai_consent_wait_expired" });
    expect(db.tables).toEqual(saved);
    noPaidRead(db);
  });

  it.each([true, false])("a snapshot whose expired row was swept before takeover cannot become a new delivery (Message-ID %s)", async (hasMessageId) => {
    const db = new FakeDb();
    const input = { ...mail(1), messageId: hasMessageId ? mail(1).messageId : null };
    await expect(processInboundEmail(asAdmin(db), input)).rejects.toBeInstanceOf(AiReadingNotAllowedError);
    const row = db.rows("emails")[0];
    vi.setSystemTime(Date.parse(String(row.consent_waiting_until)));
    db.rows("ai_reading_consents").push(consent(USER));
    let swept = false;
    db.hooks.push((q) => {
      if (!swept && q.table === "emails" && q.op === "select" && q.single === "maybeSingle" && q.columns?.includes("processing_run_id")) {
        // The backlog SELECT already returned its plaintext snapshot. The daily sweep now
        // removes the expired database row before pipeline's own stored-row lookup.
        db.tables.emails = db.rows("emails").filter((r) => r.id !== row.id);
        swept = true;
      }
    });
    expect(await runReadWaitingMail(asAdmin(db), USER)).toMatchObject({ ok: false, stage: "read", read: 0, onlyBusy: true });
    expect(swept).toBe(true);
    expect(db.rows("emails")).toEqual([]);
    noPaidRead(db);
    expect(await runReadWaitingMail(asAdmin(db), USER)).toEqual({ ok: true, read: 0, overLimit: false, unavailable: false });
  });

  it("an expired snapshot cannot overwrite a different newly arrived row with the same Message-ID", async () => {
    const db = new FakeDb();
    await wait(db, 1);
    const old = db.rows("emails")[0];
    vi.setSystemTime(Date.parse(String(old.consent_waiting_until)));
    db.rows("ai_reading_consents").push(consent(USER));
    const replacement = { ...old, id: "new-received-row", provider_email_id: "new-provider-delivery", subject: "新しく届いたメール", text_body: "新しい本文", received_at: new Date().toISOString(), created_at: new Date().toISOString(), consent_waiting_until: null };
    let swept = false;
    db.hooks.push((q) => {
      if (!swept && q.table === "emails" && q.op === "select" && q.single === "maybeSingle" && q.columns?.includes("processing_run_id")) {
        db.tables.emails = [structuredClone(replacement)];
        swept = true;
      }
    });
    expect(await runReadWaitingMail(asAdmin(db), USER)).toMatchObject({ ok: false, stage: "read", read: 0, onlyBusy: true });
    expect(swept).toBe(true);
    expect(db.rows("emails")).toEqual([replacement]);
    noPaidRead(db);
  });
});
