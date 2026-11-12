import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AiReadingNotAllowedError } from "@/lib/ai-consent";
import { claimClaudeCall } from "@/lib/claude-usage";
import { processInboundEmail } from "@/lib/pipeline";
import { runReadWaitingMail } from "@/lib/mail-run";
import { FakeDb, type Result } from "./fake-db";
import { USER, asAdmin, mailOf, precomputed, reading } from "./pipeline-fixtures";

const mocks = vi.hoisted(() => ({ extract: vi.fn(), triage: vi.fn() }));
vi.mock("@/lib/extract/extract", () => ({ extractEmail: mocks.extract }));
vi.mock("@/lib/extract/triage", () => ({ isPurchaseMail: mocks.triage }));

const consent = (decision = "granted") => ({ user_id: USER, decision, decided_at: "2026-11-12T00:00:00Z", text_version: "v1" });
const granted = () => new FakeDb({ ai_reading_consents: [consent()] });
const used = (db: FakeDb) => db.rows("claude_usage_daily").reduce((sum, row) => sum + Number(row.calls), 0);
const mail = () => ({ ...mailOf("2026-11-12T00:00:00Z"), providerEmailId: "claim-consent", messageId: "<claim-consent@example.test>", subject: "ご注文ありがとうございます", text: "ご注文番号 TEST-1\n共通の行" });
const ad = () => ({ ...mail(), from: "news@mall.example.test", subject: "今週のおすすめ", text: "新着アイテムのご案内。配信停止はこちら\n共通の行" });
const noPaidRead = () => { expect(mocks.triage).not.toHaveBeenCalled(); expect(mocks.extract).not.toHaveBeenCalled(); };
const markSender = (db: FakeDb) => db.rows("screen_events").push({ id: "remembered", user_id: USER, from_domain: "mall.example.test", decision: "dropped", flagged_at: "2026-11-12T00:00:00Z", created_at: "2026-11-12T00:00:00Z" });

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon");
  mocks.extract.mockReset().mockResolvedValue(precomputed(reading({ relevance: "other_purchase", relevance_evidence: "共通の行" })));
  mocks.triage.mockReset().mockResolvedValue(true);
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe.each([false, true])("each paid claim checks the permission (legacy fallback %s)", (legacy) => {
  it.each(["undecided", "declined"])("the direct helper refuses %s without a counter or paid client", async (state) => {
    const db = new FakeDb({ ai_reading_consents: state === "declined" ? [consent("declined")] : [] });
    db.claudeReleaseMissing = legacy;
    await expect(claimClaudeCall(asAdmin(db), USER)).rejects.toBeInstanceOf(AiReadingNotAllowedError);
    expect(db.rows("claude_usage_daily")).toEqual([]);
    expect(db.rows("claude_call_claims")).toEqual([]);
    noPaidRead();
    expect(db.rpcCalls.map((r) => r.name)).toEqual(legacy ? ["claim_claude_call_v2", "claim_claude_call"] : ["claim_claude_call_v2"]);
  });

  it.each([
    { code: "42501", message: "mail run no longer owns the lease" },
    { code: "42501", message: "permission denied for table ai_reading_consents" },
    { code: "XX000", message: "ai_consent_required" },
    { code: "57014", message: "canceling statement due to statement timeout" },
    { code: "XX000", message: "database unavailable" },
  ])("a database failure remains a failure, not a permission decision: $code $message", async (error) => {
    const db = granted();
    db.claudeReleaseMissing = legacy;
    const rpc = db.rpc.bind(db);
    db.rpc = (name, args) => name === (legacy ? "claim_claude_call" : "claim_claude_call_v2") ? Promise.resolve({ data: null, error }) : rpc(name, args);
    const failure = await claimClaudeCall(asAdmin(db), USER).catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(AiReadingNotAllowedError);
    expect((failure as Error).message).toBe(`claim_claude_call failed: ${error.message}`);
    expect(used(db)).toBe(0);
    noPaidRead();
  });

  it("revoking after the early guard and before triage sends neither paid request", async () => {
    const db = granted();
    db.claudeReleaseMissing = legacy;
    markSender(db);
    let senderReads = 0;
    db.hooks.push((q) => {
      if (q.table === "screen_events" && q.op === "select" && q.head && ++senderReads === 2) {
        expect(db.callsOn("ai_reading_consents", "select")).toHaveLength(1);
        db.rows("ai_reading_consents")[0].decision = "declined";
      }
    });
    await expect(processInboundEmail(asAdmin(db), ad())).rejects.toBeInstanceOf(AiReadingNotAllowedError);
    expect(senderReads).toBe(2);
    noPaidRead();
    expect(used(db)).toBe(0);
    expect(db.rows("claude_call_claims")).toEqual([]);
    expect(db.rows("emails")[0]).toMatchObject({ processing_status: "failed", error: "ai_consent_required", text_body: ad().text });
    expect(typeof db.rows("emails")[0].consent_waiting_until).toBe("string");
  });

  it("revoking after triage stops extraction without a second charge; regrant permits the saved mail to resume", async () => {
    const db = granted();
    db.claudeReleaseMissing = legacy;
    markSender(db);
    mocks.triage.mockImplementationOnce(async () => {
      db.rows("ai_reading_consents")[0].decision = "declined";
      return true;
    });
    await expect(processInboundEmail(asAdmin(db), ad())).rejects.toBeInstanceOf(AiReadingNotAllowedError);
    expect(mocks.triage).toHaveBeenCalledTimes(1);
    expect(mocks.extract).not.toHaveBeenCalled();
    expect(used(db)).toBe(1);
    expect(db.rows("claude_call_claims")).toHaveLength(legacy ? 0 : 1);
    const row = db.rows("emails")[0];
    expect(row).toMatchObject({ processing_status: "failed", error: "ai_consent_required", text_body: ad().text });
    const expiry = row.consent_waiting_until;
    db.rows("ai_reading_consents")[0].decision = "granted";
    expect(await runReadWaitingMail(asAdmin(db), USER)).toMatchObject({ ok: true, read: 1 });
    expect(mocks.extract).toHaveBeenCalledTimes(1);
    expect(used(db)).toBe(3);
    expect(row.consent_waiting_until).toBe(expiry);
  });
});

describe("paid-claim failure recovery stays distinct from permission withdrawal", () => {
  it.each([
    ["triage", "error"], ["triage", "throw"], ["extraction", "error"], ["extraction", "throw"],
  ] as const)("%s: a %s while retaining the denied mail stays a database failure", async (stage, fault) => {
    const db = granted();
    if (stage === "triage") markSender(db);
    const rpc = db.rpc.bind(db);
    db.rpc = (name, args) => {
      if (name === "claim_claude_call_v2") db.rows("ai_reading_consents")[0].decision = "declined";
      return rpc(name, args);
    };
    db.hooks.push((q) => {
      if (q.table === "emails" && q.op === "update" && (q.values as { error?: string }).error === "ai_consent_required") {
        if (fault === "throw") throw new Error("retention transport failed");
        return { data: null, error: { message: "retention update failed" } };
      }
    });
    const failure = await processInboundEmail(asAdmin(db), stage === "triage" ? ad() : mail()).catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(AiReadingNotAllowedError);
    expect((failure as Error).message).toBe(fault === "throw" ? "retention transport failed" : "could not retain mail awaiting reading permission");
    expect(db.rows("emails")[0]).toMatchObject({ processing_status: "pending", error: null });
    noPaidRead();
    expect(used(db)).toBe(0);
  });

  it("a permission refusal from the triage claim stops there even if the following claim would succeed", async () => {
    const db = granted();
    markSender(db);
    const rpc = db.rpc.bind(db);
    let claims = 0;
    db.rpc = (name, args) => name === "claim_claude_call_v2" && ++claims === 1
      ? Promise.resolve({ data: null, error: { code: "42501", message: "ai_consent_required" } }) : rpc(name, args);
    await expect(processInboundEmail(asAdmin(db), ad())).rejects.toBeInstanceOf(AiReadingNotAllowedError);
    expect(claims).toBe(1);
    noPaidRead();
    expect(used(db)).toBe(0);
    expect(db.rows("emails")[0]).toMatchObject({ processing_status: "failed", error: "ai_consent_required" });
  });

  it("a transient failure in the triage claim keeps the mail and still permits the separately claimed extraction", async () => {
    const db = granted();
    markSender(db);
    const rpc = db.rpc.bind(db);
    let claims = 0;
    db.rpc = (name, args) => name === "claim_claude_call_v2" && ++claims === 1
      ? Promise.resolve({ data: null, error: { code: "XX000", message: "temporarily unavailable" } }) : rpc(name, args);
    expect((await processInboundEmail(asAdmin(db), ad())).kind).toBe("noted");
    expect(mocks.triage).not.toHaveBeenCalled();
    expect(mocks.extract).toHaveBeenCalledTimes(1);
    expect(used(db)).toBe(1);
  });

  it("a normal extraction-claim failure is saved as a database failure and does not become an undecided choice", async () => {
    const db = granted();
    const rpc = db.rpc.bind(db);
    db.rpc = (name, args): Promise<Result> => name === "claim_claude_call_v2" ? Promise.resolve({ data: null, error: { code: "XX000", message: "temporarily unavailable" } }) : rpc(name, args);
    await expect(processInboundEmail(asAdmin(db), mail())).rejects.toThrow("claim_claude_call failed: temporarily unavailable");
    expect(db.rows("emails")[0]).toMatchObject({ processing_status: "failed", error: "claim_claude_call failed: temporarily unavailable" });
    noPaidRead();
    expect(used(db)).toBe(0);
  });

  it("releasing an already claimed call remains valid after withdrawal", async () => {
    const db = granted();
    const claim = await claimClaudeCall(asAdmin(db), USER);
    db.rows("ai_reading_consents")[0].decision = "declined";
    await claim.release();
    expect(used(db)).toBe(0);
    expect(db.rows("claude_call_claims")[0].released_at).not.toBeNull();
  });

  it("public precomputed sample and Gmail confirmation still need no paid claim or permission", async () => {
    const db = new FakeDb();
    expect((await processInboundEmail(asAdmin(db), mail(), { publicSample: true, precomputed: precomputed(reading({ relevance: "other_purchase", relevance_evidence: "共通の行" })) })).kind).toBe("noted");
    expect((await processInboundEmail(asAdmin(db), { ...mail(), messageId: "<confirm@example.test>", providerEmailId: "confirm", from: "forwarding-noreply@google.com", text: "https://mail-settings.google.com/mail/vf-example" })).kind).toBe("forwarding_confirmation");
    noPaidRead();
    expect(used(db)).toBe(0);
    expect(db.rpcCalls.filter((r) => /claim_claude_call/.test(r.name))).toEqual([]);
  });
});
