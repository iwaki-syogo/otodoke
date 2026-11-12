import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeDb, consentWaitingRetentionMs, type Row } from "./fake-db";
import { USER, asAdmin, mailOf, precomputed, reading } from "./pipeline-fixtures";

const mocks = vi.hoisted(() => ({ extract: vi.fn(), triage: vi.fn(), fetch: vi.fn(), demo: vi.fn() }));
vi.mock("@/lib/extract/extract", () => ({ extractEmail: mocks.extract }));
vi.mock("@/lib/extract/triage", () => ({ isPurchaseMail: mocks.triage }));
vi.mock("@/lib/demo", () => ({ loadDemoEntries: mocks.demo, demoInput: () => { throw new Error("sample input is forbidden"); } }));
const { processInboundEmail, MailBeingReadError } = await import("@/lib/pipeline");
const { runReadAfterConsent } = await import("@/lib/ai-consent-run");
const { runReadWaitingMail } = await import("@/lib/mail-run");

const NOW = Date.parse("2026-11-12T00:00:01Z");
const DECIDED = "2026-11-12T00:00:00.123456Z";
const RECEIVED = "2026-11-01T00:00:00Z";
const ID = "00000000-0000-4000-8000-000000000001";
const mail = () => ({ ...mailOf(RECEIVED), messageId: "<synthetic-delete@example.test>", providerEmailId: "synthetic-delete",
  subject: "ご注文ありがとうございます", text: "ご注文番号 SYNTHETIC-DELETE を承りました。" });
const promo = () => ({ ...mail(), from: "news@mall.example.test", subject: "今週のおすすめ", text: "新着アイテムのご案内。配信停止はこちら" });
const grounded = () => precomputed(reading({ relevance: "unrelated", relevance_evidence: mail().text }));

function seeded(input = mail()) {
  return new FakeDb({ ai_reading_consents: [{ user_id: USER, decision: "granted", decided_at: DECIDED, text_version: "v1" }], emails: [{
    id: ID, user_id: USER, message_id: input.messageId, provider_email_id: input.providerEmailId,
    from_address: input.from, from_name: input.fromName, subject: input.subject, text_body: input.text, html_body: null, sent_at: input.sentAt,
    processing_status: "failed", error: "ai_consent_required", body_state: "plain", created_at: RECEIVED, received_at: RECEIVED,
    consent_waiting_until: new Date(Date.parse(RECEIVED) + consentWaitingRetentionMs()).toISOString(),
  }] });
}

type Refusal = "error" | "zero" | "null" | "wrong_id" | "multiple";
function refuseDelete(db: FakeDb, kind: Refusal) {
  let enabled = true;
  db.hooks.push((query) => {
    if (!enabled || query.table !== "emails" || query.op !== "delete") return;
    if (kind === "error") return { data: null, error: { message: "synthetic delete refusal" } };
    return { data: kind === "null" ? null : kind === "zero" ? [] : kind === "wrong_id" ? [{ id: "another-id" }] : [{ id: ID }, { id: ID }], error: null };
  });
  return () => { enabled = false; };
}
const charged = (db: FakeDb) => db.rows("claude_usage_daily").reduce((sum, row) => sum + Number(row.calls), 0);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "dummy-public-key");
  vi.stubEnv("OTODOKE_USER_DAILY_LIMIT", "3");
  vi.stubEnv("OTODOKE_GLOBAL_DAILY_LIMIT", "10");
  mocks.extract.mockReset().mockResolvedValue(grounded());
  mocks.triage.mockReset().mockResolvedValue(false);
  mocks.fetch.mockReset().mockImplementation(() => { throw new Error("external fetch is forbidden"); });
  mocks.demo.mockReset().mockImplementation(() => { throw new Error("demo loading is forbidden"); });
  vi.stubGlobal("fetch", mocks.fetch);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("grounded unrelated mail requires a confirmed owned deletion", () => {
  it.each(["error", "zero", "null", "wrong_id", "multiple"] as const)("does not report discarded for DELETE %s while the target remains", async (kind) => {
    const db = seeded();
    refuseDelete(db, kind);
    const result = await processInboundEmail(asAdmin(db), mail()).catch((error: unknown) => error);
    expect(result, JSON.stringify({ result, rows: db.rows("emails").length })).toBeInstanceOf(Error);
    expect(result).toHaveProperty("message", expect.stringMatching(/^emails cleanup /));
    expect(db.rows("emails")).toHaveLength(1);
    expect(db.rows("emails")[0]).toMatchObject({ id: ID, processing_status: "failed", text_body: mail().text });
    expect(mocks.extract).toHaveBeenCalledTimes(1);
    expect(charged(db)).toBe(1);
    expect(db.rows("extractions")).toEqual([]);
    expect(db.rows("parcels")).toEqual([]);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("discards after the one matching row is actually removed", async () => {
    const db = seeded();
    expect(await processInboundEmail(asAdmin(db), mail())).toMatchObject({ kind: "discarded" });
    expect(db.rows("emails")).toEqual([]);
    expect(charged(db)).toBe(1);
    expect(mocks.extract).toHaveBeenCalledTimes(1);
    expect(mocks.demo).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("propagates an owned lease refusal without changing the replacement run", async () => {
    const db = seeded();
    let replacement: Row | undefined;
    mocks.extract.mockImplementationOnce(async () => {
      Object.assign(db.rows("emails")[0], { processing_run_id: "replacement-run", processing_lease_until: new Date(NOW + 360_000).toISOString() });
      replacement = structuredClone(db.rows("emails")[0]);
      return grounded();
    });
    const result = await processInboundEmail(asAdmin(db), mail()).catch((error: unknown) => error);
    expect(result).toBeInstanceOf(Error);
    expect(result).toHaveProperty("message", expect.stringContaining("lease"));
    expect(db.rows("emails")).toEqual([replacement]);
    expect(mocks.extract).toHaveBeenCalledTimes(1);
    expect(charged(db)).toBe(1);
  });

  it("does not recreate an already absent row, and the next explicit request needs no paid retry", async () => {
    const db = seeded();
    mocks.extract.mockImplementationOnce(async () => { db.tables.emails = []; return grounded(); });
    const result = await processInboundEmail(asAdmin(db), mail()).catch((error: unknown) => error);
    expect(result).toBeInstanceOf(Error);
    expect(db.rows("emails")).toEqual([]);
    expect(await runReadWaitingMail(asAdmin(db), USER)).toMatchObject({ ok: true, read: 0 });
    await expect(processInboundEmail(asAdmin(db), mail(), { replacesEmailId: ID, replacesCreatedAt: RECEIVED })).rejects.toBeInstanceOf(MailBeingReadError);
    expect(mocks.extract).toHaveBeenCalledTimes(1);
  });
});

describe("stored mail rejected by the screen uses the same deletion contract", () => {
  function marked() {
    const db = seeded(promo());
    db.rows("screen_events").push({ id: "marked", user_id: USER, decision: "dropped", from_domain: "mall.example.test", subject: "Old synthetic event", flagged_at: RECEIVED, created_at: RECEIVED });
    return db;
  }
  it.each(["error", "zero"] as const)("DELETE %s retains the pending lease and can be cleaned by a later manual request", async (kind) => {
    const db = marked();
    const allowDelete = refuseDelete(db, kind);
    const result = await processInboundEmail(asAdmin(db), promo()).catch((error: unknown) => error);
    expect(result).toBeInstanceOf(Error);
    expect(db.rows("emails")[0]).toMatchObject({ id: ID, processing_status: "pending", text_body: promo().text });
    expect(db.rows("screen_events").filter((row) => row.subject === promo().subject)).toEqual([]);
    expect(mocks.triage).toHaveBeenCalledTimes(1);
    expect(mocks.extract).not.toHaveBeenCalled();
    const until = db.rows("emails")[0].processing_lease_until;
    if (typeof until !== "string") throw new Error("fixture requires a pending lease");
    vi.setSystemTime(Date.parse(until) + 1);
    allowDelete();
    expect(await runReadWaitingMail(asAdmin(db), USER)).toMatchObject({ ok: true, read: 1 });
    expect(db.rows("emails")).toEqual([]);
    expect(db.rows("screen_events").filter((row) => row.subject === promo().subject)).toHaveLength(1);
    expect(mocks.extract).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("logs screened_out only after removing the matching stored row", async () => {
    const db = marked();
    expect(await processInboundEmail(asAdmin(db), promo())).toMatchObject({ kind: "screened_out" });
    expect(db.rows("emails")).toEqual([]);
    expect(db.rows("screen_events").filter((row) => row.subject === promo().subject)).toHaveLength(1);
    expect(mocks.triage).toHaveBeenCalledTimes(1);
    expect(mocks.extract).not.toHaveBeenCalled();
  });
});

it("stops the automatic run on failed deletion without charging twice, then an explicit manual request removes the mail", async () => {
  const db = seeded();
  const allowDelete = refuseDelete(db, "zero");
  let calls = 0;
  mocks.extract.mockImplementation(async () => {
    if (++calls > 3) throw new Error("finite extraction guard exceeded");
    return grounded();
  });
  expect(await runReadAfterConsent(asAdmin(db), USER, DECIDED, NOW)).toMatchObject({ ok: false, read: 0, onlyBusy: false });
  expect(db.rows("emails")[0]).toMatchObject({ id: ID, processing_status: "failed", text_body: mail().text });
  expect(mocks.extract).toHaveBeenCalledTimes(1);
  expect(charged(db)).toBe(1);
  expect(await runReadAfterConsent(asAdmin(db), USER, DECIDED, NOW)).toMatchObject({ ok: true, read: 0 });
  expect(mocks.extract).toHaveBeenCalledTimes(1);
  allowDelete();
  expect(await runReadWaitingMail(asAdmin(db), USER)).toMatchObject({ ok: true, read: 1 });
  expect(mocks.extract).toHaveBeenCalledTimes(2);
  expect(db.rows("emails")).toEqual([]);
  expect(charged(db)).toBe(2);
  expect(mocks.demo).not.toHaveBeenCalled();
  expect(mocks.fetch).not.toHaveBeenCalled();
});
