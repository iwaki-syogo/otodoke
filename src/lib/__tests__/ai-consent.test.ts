import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AiReadingNotAllowedError, readAiReadingConsent, readingAllowed } from "@/lib/ai-consent";
import { FakeDb } from "./fake-db";
import { OTHER, USER, asAdmin, item, mailOf, precomputed, reading, sure } from "./pipeline-fixtures";

const mocks = vi.hoisted(() => ({ extract: vi.fn(), triage: vi.fn() }));
vi.mock("@/lib/extract/extract", () => ({ extractEmail: mocks.extract }));
vi.mock("@/lib/extract/triage", () => ({ isPurchaseMail: mocks.triage }));
const { processInboundEmail } = await import("@/lib/pipeline");
const { runReadWaitingMail } = await import("@/lib/mail-run");

const order = reading({ relevance: "order", order_number: sure("TEST-1"), items: [item("テスト商品", 900)], total_amount: sure(900) });
const consent = (decision = "granted", userId = USER) => ({ user_id: userId, decision, decided_at: "2026-11-12T00:00:00Z", text_version: "v1" });
const normalMail = () => ({ ...mailOf("2026-11-03T01:00:00Z"), messageId: "<consent@example.test>", subject: "ご注文ありがとうございます", text: "ご注文番号 TEST-1 を承りました" });
const screenedMail = () => ({ ...normalMail(), from: "news@mall.example.test", subject: "今週のおすすめ", text: "新着アイテムのご案内。配信停止はこちら" });
const markSender = (db: FakeDb) => db.rows("screen_events").push({ id: "flag", user_id: USER, decision: "dropped", from_domain: "mall.example.test", flagged_at: "2026-11-12T00:00:00Z", created_at: "2026-11-12T00:00:00Z" });

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon");
  mocks.extract.mockReset().mockResolvedValue(precomputed(order));
  mocks.triage.mockReset().mockResolvedValue(true);
});
afterEach(() => vi.unstubAllEnvs());

describe("reading permission is a server decision", () => {
  it("tells an unanswered choice, declined, granted and a failed lookup apart", async () => {
    const db = new FakeDb();
    expect(await readAiReadingConsent(asAdmin(db), USER)).toBe("undecided");
    expect(await readingAllowed(asAdmin(db), USER)).toBe("not_granted");
    db.rows("ai_reading_consents").push(consent("declined"));
    expect(await readAiReadingConsent(asAdmin(db), USER)).toBe("declined");
    db.rows("ai_reading_consents")[0].decision = "granted";
    expect(await readingAllowed(asAdmin(db), USER)).toBe("granted");
    db.hooks.push((q) => q.table === "ai_reading_consents" ? { data: null, error: { message: "offline" } } : undefined);
    expect(await readAiReadingConsent(asAdmin(db), USER)).toBe("unknown");
    expect(await readingAllowed(asAdmin(db), USER)).toBe("unknown");
  });

  it("a rejected lookup is unknown too, and another person's grant never grants this person", async () => {
    const db = new FakeDb({ ai_reading_consents: [consent("granted", OTHER)] });
    expect(await readingAllowed(asAdmin(db), USER)).toBe("not_granted");
    db.hooks.push((q) => { if (q.table === "ai_reading_consents") throw new TypeError("offline"); });
    expect(await readingAllowed(asAdmin(db), USER)).toBe("unknown");
  });

  it.each(["undecided", "declined", "lookup_failed"])("%s: neither extraction nor the paid second look is called, and mail waits without taking allowance", async (state) => {
    const db = new FakeDb({ ai_reading_consents: state === "declined" ? [consent("declined")] : [] });
    markSender(db);
    if (state === "lookup_failed") db.hooks.push((q) => q.table === "ai_reading_consents" ? { data: null, error: { message: "offline" } } : undefined);
    const mail = screenedMail();
    const expected = state === "lookup_failed" ? "ai_consent_unknown" : "ai_consent_required";
    await expect(processInboundEmail(asAdmin(db), mail)).rejects.toMatchObject({ name: "AiReadingNotAllowedError", code: expected });
    expect(mocks.extract).not.toHaveBeenCalled();
    expect(mocks.triage).not.toHaveBeenCalled();
    expect(db.rpcCalls.filter((c) => /claude_call/.test(c.name))).toEqual([]);
    expect(db.rows("emails")).toHaveLength(1);
    expect(db.rows("emails")[0]).toMatchObject({ user_id: USER, processing_status: "failed", error: expected, text_body: mail.text });
  });

  it("granted: the paid second look and extraction both run, after storing the mail and checking consent", async () => {
    const db = new FakeDb({ ai_reading_consents: [consent()] });
    markSender(db);
    mocks.triage.mockImplementation(async () => {
      expect(db.rows("emails")).toHaveLength(1);
      expect(db.callsOn("ai_reading_consents", "select")).toHaveLength(1);
      return true;
    });
    expect((await processInboundEmail(asAdmin(db), screenedMail())).kind).toBe("processed");
    expect(mocks.triage).toHaveBeenCalledTimes(1);
    expect(mocks.extract).toHaveBeenCalledTimes(1);
    expect(db.rpcCalls.filter((q) => q.name === "claim_claude_call_v2")).toHaveLength(2);
  });

  it("a key lookup failure on an ad leaves the stored mail untouched and never logs its subject as dropped", async () => {
    const mail = screenedMail();
    const row = { id: "waiting-ad", user_id: USER, message_id: mail.messageId, processing_status: "over_limit", created_at: "2026-11-01T00:00:00Z", text_body: mail.text };
    const db = new FakeDb({ ai_reading_consents: [consent()], emails: [row] });
    const before = { ...db.rows("emails")[0] };
    db.hooks.push((q) => q.table === "user_keys" ? { data: null, error: { message: "offline" } } : undefined);
    await expect(processInboundEmail(asAdmin(db), mail)).rejects.toThrow("user_keys lookup failed");
    expect(db.rows("emails")).toEqual([before]);
    expect(db.rows("screen_events")).toEqual([]);
    expect(db.callsOn("emails", "update")).toHaveLength(0);
    expect(db.callsOn("emails", "delete")).toHaveLength(0);
    expect(mocks.extract).not.toHaveBeenCalled();
    expect(mocks.triage).not.toHaveBeenCalled();
  });

  it("waiting mail is read in place after granting, and withdrawing stops later mail without removing the result", async () => {
    const db = new FakeDb();
    await expect(processInboundEmail(asAdmin(db), normalMail())).rejects.toBeInstanceOf(AiReadingNotAllowedError);
    const waitingId = db.rows("emails")[0].id;
    expect(await runReadWaitingMail(asAdmin(db), USER)).toMatchObject({ ok: false, read: 0, onlyBusy: false });
    expect(mocks.extract).not.toHaveBeenCalled();
    db.rows("ai_reading_consents").push(consent());
    expect(await runReadWaitingMail(asAdmin(db), USER)).toMatchObject({ ok: true, read: 1, overLimit: false });
    expect(db.rows("emails")).toHaveLength(1);
    expect(db.rows("emails")[0]).toMatchObject({ id: waitingId, processing_status: "processed" });
    expect(db.rows("parcels")).toHaveLength(1);
    db.rows("ai_reading_consents")[0].decision = "declined";
    await expect(processInboundEmail(asAdmin(db), { ...normalMail(), messageId: "<after-withdrawal@example.test>" })).rejects.toMatchObject({ code: "ai_consent_required" });
    expect(mocks.extract).toHaveBeenCalledTimes(1);
    expect(mocks.triage).not.toHaveBeenCalled();
    expect(db.rows("parcels")).toHaveLength(1);
  });

  it("a repository sample uses its saved extraction without consent or either Claude client", async () => {
    const db = new FakeDb();
    expect((await processInboundEmail(asAdmin(db), normalMail(), { publicSample: true, precomputed: precomputed(order) })).kind).toBe("processed");
    expect(db.callsOn("ai_reading_consents", "select")).toHaveLength(0);
    expect(mocks.extract).not.toHaveBeenCalled();
    expect(mocks.triage).not.toHaveBeenCalled();
    expect(db.rpcCalls.filter((c) => /claude_call/.test(c.name))).toEqual([]);
  });

  it("a sample flag alone cannot send a real mail to Claude without permission", async () => {
    const db = new FakeDb();
    await expect(processInboundEmail(asAdmin(db), normalMail(), { publicSample: true })).rejects.toMatchObject({ code: "ai_consent_required" });
    expect(mocks.extract).not.toHaveBeenCalled();
    expect(mocks.triage).not.toHaveBeenCalled();
  });
});
