import { APIError } from "@anthropic-ai/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeDb, type Row } from "./fake-db";
import { env } from "@/lib/env";
import { OTHER, USER, asAdmin, precomputed, reading } from "./pipeline-fixtures";

const mocks = vi.hoisted(() => ({ extract: vi.fn(), triage: vi.fn() }));
// Only this behavioural suite stands in for the bounded-client version of the shared module.
// The separate source contract reads the actual exports and requires both SDK connections.
const timing = vi.hoisted(() => ({
  TRIAGE_TIMEOUT_MS: 15_000 as unknown,
  EXTRACT_TIMEOUT_MS: 90_000 as unknown,
  MAIL_READ_BUDGET_MS: 120_000 as unknown,
  MAIL_REQUEST_BUDGET_MS: 270_000 as unknown,
}));
vi.mock("@/lib/unread", async (importActual) => ({
  ...await importActual<typeof import("@/lib/unread")>(),
  get TRIAGE_TIMEOUT_MS() { return timing.TRIAGE_TIMEOUT_MS; },
  get EXTRACT_TIMEOUT_MS() { return timing.EXTRACT_TIMEOUT_MS; },
  get MAIL_READ_BUDGET_MS() { return timing.MAIL_READ_BUDGET_MS; },
  get MAIL_REQUEST_BUDGET_MS() { return timing.MAIL_REQUEST_BUDGET_MS; },
}));
vi.mock("@/lib/extract/extract", () => ({ extractEmail: mocks.extract }));
vi.mock("@/lib/extract/triage", () => ({ isPurchaseMail: mocks.triage }));
const { runReadAfterConsent } = await import("@/lib/ai-consent-run");
const { runReadWaitingMail } = await import("@/lib/mail-run");

const DECIDED = "2026-11-12T00:00:00.123456Z";
const choice = (decision = "granted", decidedAt = DECIDED, userId = USER) => ({ user_id: userId, decision, decided_at: decidedAt, text_version: "v1" });
const waiting = (n: number, over: Partial<Row> = {}): Row => ({
  id: `waiting-${n}`, user_id: USER, processing_status: "failed", error: "ai_consent_required", body_state: "plain",
  provider_email_id: `provider-${n}`, message_id: `<waiting-${n}@example.test>`,
  from_address: "shop@example.test", from_name: null, subject: "ご注文ありがとうございます",
  sent_at: new Date(Date.parse("2026-11-01T00:00:00Z") + n * 1000).toISOString(),
  text_body: `ご注文番号 TEST-${n} を承りました`, html_body: null, created_at: "2026-11-01T00:00:00.000000Z", ...over,
});
const seeded = (n = 1) => new FakeDb({ ai_reading_consents: [choice()], emails: Array.from({ length: n }, (_, i) => waiting(i + 1)) });
// The unrelated verdict must quote the mail itself (the evidence check keeps a mail whose quote is not in it).
const notRelevant = () => precomputed(reading({ relevance: "unrelated", relevance_evidence: "ご注文番号" }));

beforeEach(() => {
  Object.assign(timing, { TRIAGE_TIMEOUT_MS: 15_000, EXTRACT_TIMEOUT_MS: 90_000, MAIL_READ_BUDGET_MS: 120_000, MAIL_REQUEST_BUDGET_MS: 270_000 });
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon");
  mocks.extract.mockReset().mockImplementation(async () => notRelevant());
  mocks.triage.mockReset().mockResolvedValue(true);
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("automatic reading after the recorded permission", () => {
  it.each([
    { TRIAGE_TIMEOUT_MS: undefined },
    { EXTRACT_TIMEOUT_MS: undefined },
    { MAIL_READ_BUDGET_MS: undefined },
    { MAIL_REQUEST_BUDGET_MS: undefined },
    { EXTRACT_TIMEOUT_MS: Number.POSITIVE_INFINITY },
    { TRIAGE_TIMEOUT_MS: 0 },
    { MAIL_READ_BUDGET_MS: -1 },
    { MAIL_REQUEST_BUDGET_MS: Number.NaN },
    { MAIL_REQUEST_BUDGET_MS: 300_000 },
    { MAIL_REQUEST_BUDGET_MS: 119_999 },
    { MAIL_READ_BUDGET_MS: 105_000 },
  ])("missing or inconsistent bounded-client timing starts no claim or paid call: %j", async (invalid) => {
    Object.assign(timing, invalid);
    const db = seeded();
    expect(await runReadAfterConsent(asAdmin(db), USER, DECIDED)).toMatchObject({ ok: false, read: 0, message: "ai_consent_backlog_timing_unavailable", overLimit: false });
    expect(db.rpcCalls).toEqual([]);
    expect(mocks.extract).not.toHaveBeenCalled();
    expect(mocks.triage).not.toHaveBeenCalled();
    expect(db.rows("ai_reading_consents")).toEqual([choice()]);
    expect(db.rows("emails")).toHaveLength(1);
  });

  it("reads the waiting real mail immediately after granting and records only one start", async () => {
    const db = new FakeDb({ emails: [waiting(1)] });
    db.rows("ai_reading_consents").push(choice());
    expect(await runReadAfterConsent(asAdmin(db), USER, DECIDED)).toEqual({ ok: true, read: 1, overLimit: false, unavailable: false });
    expect(mocks.extract).toHaveBeenCalledTimes(1);
    expect(db.rows("emails")).toHaveLength(0);
    expect(db.rows("ai_consent_read_runs")).toEqual([{ user_id: USER, consent_decided_at: DECIDED }]);
    expect(db.rows("ai_reading_consents")).toEqual([choice()]);
    expect(db.rpcCalls[0]).toEqual({ name: "claim_ai_reading_backlog", args: { p_user_id: USER, p_decided_at: DECIDED } });
  });

  it.each([149_999, 150_000, 150_001])("includes %d ms of request setup before claiming instead of starting a fresh deadline", async (setupMs) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = Date.parse("2026-11-12T00:00:01Z");
    vi.setSystemTime(start + setupMs);
    const db = seeded();
    const result = await runReadAfterConsent(asAdmin(db), USER, DECIDED, start);
    if (setupMs > 150_000) {
      expect(result).toMatchObject({ ok: false, read: 0, message: "ai_consent_backlog_time_limit", overLimit: false });
      expect(db.rpcCalls).toEqual([]);
      expect(mocks.extract).not.toHaveBeenCalled();
      expect(db.rows("emails")).toHaveLength(1);
    } else {
      expect(result).toMatchObject({ ok: true, read: 1 });
      expect(mocks.extract).toHaveBeenCalledTimes(1);
      expect(db.rpcCalls[0].name).toBe("claim_ai_reading_backlog");
    }
    expect(db.rows("ai_reading_consents")).toEqual([choice()]);
  });

  it("two simultaneous presses share one atomic claim and issue only one paid reading", async () => {
    const db = seeded();
    let started!: () => void;
    let finish!: () => void;
    const entered = new Promise<void>((resolve) => { started = resolve; });
    const held = new Promise<void>((resolve) => { finish = resolve; });
    mocks.extract.mockImplementation(async () => { started(); await held; return notRelevant(); });
    const first = runReadAfterConsent(asAdmin(db), USER, DECIDED);
    const second = runReadAfterConsent(asAdmin(db), USER, DECIDED);
    await entered;
    expect(await second).toEqual({ ok: true, read: 0, overLimit: false, unavailable: false });
    expect(mocks.extract).toHaveBeenCalledTimes(1);
    finish();
    expect(await first).toMatchObject({ ok: true, read: 1 });
    expect(db.rpcCalls.filter((c) => c.name === "claim_claude_call_v2")).toHaveLength(1);
    expect(db.rows("ai_consent_read_runs")).toHaveLength(1);
  });

  it("a failed simultaneous run keeps permission and its claim, then the explicit manual path can retry", async () => {
    const db = seeded();
    mocks.extract.mockRejectedValueOnce(new Error("temporary reading failure"));
    const [first, second] = await Promise.all([runReadAfterConsent(asAdmin(db), USER, DECIDED), runReadAfterConsent(asAdmin(db), USER, DECIDED)]);
    expect(first).toMatchObject({ ok: false, read: 0, overLimit: false });
    expect(second).toMatchObject({ ok: true, read: 0 });
    expect(db.rows("ai_reading_consents")).toEqual([choice()]);
    expect(db.rows("emails")[0]).toMatchObject({ processing_status: "failed", text_body: "ご注文番号 TEST-1 を承りました" });
    expect(await runReadAfterConsent(asAdmin(db), USER, DECIDED)).toMatchObject({ ok: true, read: 0 });
    expect(mocks.extract).toHaveBeenCalledTimes(1);
    expect(await runReadWaitingMail(asAdmin(db), USER)).toMatchObject({ ok: true, read: 1 });
    expect(mocks.extract).toHaveBeenCalledTimes(2);
  });

  it("withdrawal during the first extraction prevents either client from seeing the next mail", async () => {
    const db = seeded(3);
    Object.assign(db.rows("emails")[1], { from_address: "news@mall.example.test", subject: "今週のおすすめ", text_body: "新着アイテムのご案内。配信停止はこちら" });
    db.rows("screen_events").push({ id: "mark", user_id: USER, decision: "dropped", from_domain: "mall.example.test", flagged_at: "2026-11-12T00:00:00Z" });
    mocks.extract.mockImplementationOnce(async () => {
      Object.assign(db.rows("ai_reading_consents")[0], choice("declined", "2026-11-12T00:00:01.123456Z"));
      return notRelevant();
    });
    expect(await runReadAfterConsent(asAdmin(db), USER, DECIDED)).toMatchObject({ ok: false, read: 1, onlyBusy: false });
    expect(mocks.extract).toHaveBeenCalledTimes(1);
    expect(mocks.triage).not.toHaveBeenCalled();
    expect(db.rows("emails").map((r) => r.id)).toEqual(["waiting-2", "waiting-3"]);
    expect(db.rows("emails").every((r) => r.processing_status === "failed" && r.error === "ai_consent_required")).toBe(true);
    expect(db.rpcCalls.filter((c) => c.name === "claim_claude_call_v2")).toHaveLength(1);
  });

  it.each(["user", "global"] as const)("preserves the %s daily allowance and leaves the rest unread", async (kind) => {
    const db = seeded(5);
    const configured = env();
    const day = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
    db.rows("claude_usage_daily").push({ user_id: kind === "user" ? USER : OTHER, day, calls: (kind === "user" ? configured.OTODOKE_USER_DAILY_LIMIT : configured.OTODOKE_GLOBAL_DAILY_LIMIT) - 2 });
    expect(await runReadAfterConsent(asAdmin(db), USER, DECIDED)).toEqual({ ok: true, read: 2, overLimit: true, unavailable: false });
    expect(mocks.extract).toHaveBeenCalledTimes(2);
    expect(db.rows("emails")).toHaveLength(3);
    expect(db.rows("emails")[0]).toMatchObject({ processing_status: "over_limit", error: `${kind}_limit` });
    expect(db.rows("ai_reading_consents")).toEqual([choice()]);
  });

  it("drains more than twenty waiting mails across batches without introducing a mail-count cap", async () => {
    const db = seeded(25);
    expect(await runReadAfterConsent(asAdmin(db), USER, DECIDED)).toEqual({ ok: true, read: 25, overLimit: false, unavailable: false });
    expect(mocks.extract).toHaveBeenCalledTimes(25);
    expect(db.rows("emails")).toHaveLength(0);
    const batches = db.callsOn("emails", "select").filter((q) => q.columns?.startsWith("id, provider_email_id"));
    expect(batches).toHaveLength(3);
    expect(batches.every((q) => q.limit === 20)).toBe(true);
  });

  it("the snapshot excludes new mail, another user, samples and non-consent failures", async () => {
    const keep = [
      waiting(3, { created_at: "2026-11-12T00:00:00.123457Z" }),
      waiting(4, { user_id: OTHER }),
      waiting(5, { provider_email_id: "demo:sample", error: null }),
      waiting(6, { error: "claude_error" }),
      waiting(7, { processing_status: "processed" }),
    ];
    const db = new FakeDb({ ai_reading_consents: [choice()], emails: [waiting(1), waiting(2, { error: "ai_consent_unknown", created_at: DECIDED }), ...keep] });
    expect(await runReadAfterConsent(asAdmin(db), USER, DECIDED)).toMatchObject({ ok: true, read: 2 });
    expect(mocks.extract).toHaveBeenCalledTimes(2);
    expect(db.rows("emails").map((r) => r.id)).toEqual(keep.map((r) => r.id));
    const query = db.callsOn("emails", "select").find((q) => q.columns?.startsWith("id, provider_email_id"))!;
    expect(query.filters).toContainEqual({ method: "in", args: ["error", ["ai_consent_required", "ai_consent_unknown"]] });
    expect(query.filters).toContainEqual({ method: "lte", args: ["created_at", DECIDED] });
  });

  it.each(["missing", "declined", "old_timestamp"])("%s cannot claim or spend, and does not change the current choice", async (state) => {
    const db = seeded();
    if (state === "missing") db.tables.ai_reading_consents = [];
    if (state === "declined") db.rows("ai_reading_consents")[0].decision = "declined";
    const before = structuredClone(db.rows("ai_reading_consents"));
    const token = state === "old_timestamp" ? "2026-11-12T00:00:00.123455Z" : DECIDED;
    expect(await runReadAfterConsent(asAdmin(db), USER, token)).toEqual({ ok: true, read: 0, overLimit: false, unavailable: false });
    expect(mocks.extract).not.toHaveBeenCalled();
    expect(mocks.triage).not.toHaveBeenCalled();
    expect(db.rows("ai_consent_read_runs")).toHaveLength(0);
    expect(db.rows("ai_reading_consents")).toEqual(before);
  });

  it("the same microsecond instant in a timezone offset cannot claim a second run", async () => {
    const db = seeded();
    expect((await runReadAfterConsent(asAdmin(db), USER, DECIDED)).read).toBe(1);
    expect(await runReadAfterConsent(asAdmin(db), USER, "2026-11-12T09:00:00.123456+09:00")).toMatchObject({ ok: true, read: 0 });
    expect(mocks.extract).toHaveBeenCalledTimes(1);
    expect(db.rows("ai_consent_read_runs")).toHaveLength(1);
  });

  it.each(["error", "throw", "malformed"])("a claim %s is a fixed failure and sends no mail", async (kind) => {
    const db = seeded();
    if (kind === "throw") vi.spyOn(db, "rpc").mockRejectedValue(new Error("private database detail"));
    else vi.spyOn(db, "rpc").mockResolvedValue(kind === "error" ? { data: null, error: { message: "private database detail" } } : { data: "true", error: null });
    const done = await runReadAfterConsent(asAdmin(db), USER, DECIDED);
    expect(done).toMatchObject({ ok: false, read: 0, message: "ai_consent_backlog_claim_failed", overLimit: false, onlyBusy: false });
    expect(JSON.stringify(done)).not.toContain("private");
    expect(mocks.extract).not.toHaveBeenCalled();
    expect(db.rows("emails")).toHaveLength(1);
    expect(db.rows("ai_reading_consents")).toEqual([choice()]);
  });

  it("a failed lookup after a successful batch is not an empty backlog or a successful drain", async () => {
    const db = seeded(21);
    let batches = 0;
    db.hooks.push((q) => {
      if (q.table === "emails" && q.op === "select" && q.columns?.startsWith("id, provider_email_id")) {
        batches++;
        if (batches === 2) return { data: null, error: { message: "lookup failed" } };
      }
    });
    expect(await runReadAfterConsent(asAdmin(db), USER, DECIDED)).toMatchObject({ ok: false, stage: "lookup", read: 20, overLimit: false, onlyBusy: false });
    expect(mocks.extract).toHaveBeenCalledTimes(20);
    expect(db.rows("emails")).toHaveLength(1);
    expect(db.rows("ai_reading_consents")).toEqual([choice()]);
  });

  it("a thrown lookup is a fixed failure, and a null response is never an empty backlog", async () => {
    for (const thrown of [false, true]) {
      const db = seeded();
      db.hooks.push((q) => {
        if (q.table !== "emails" || q.op !== "select") return;
        if (thrown) throw new Error("private database detail");
        return { data: null, error: null };
      });
      expect(await runReadAfterConsent(asAdmin(db), USER, DECIDED)).toMatchObject({ ok: false, read: 0, overLimit: false, onlyBusy: false });
      expect(db.rows("emails")).toHaveLength(1);
    }
    expect(mocks.extract).not.toHaveBeenCalled();
  });

  it("a busy mail ends automatic reading once, without charging or retrying the claim", async () => {
    const db = seeded(2);
    db.hooks.push((q) => q.table === "emails" && q.op === "update" ? { data: null, error: null } : undefined);
    expect(await runReadAfterConsent(asAdmin(db), USER, DECIDED)).toMatchObject({ ok: false, read: 0, onlyBusy: true });
    expect(mocks.extract).not.toHaveBeenCalled();
    expect(db.rows("emails")).toHaveLength(2);
    expect(await runReadAfterConsent(asAdmin(db), USER, DECIDED)).toMatchObject({ ok: true, read: 0 });
    expect(db.callsOn("emails", "update")).toHaveLength(1);
  });

  it("Claude stopped ends automatic reading and keeps the rest for the existing retry path", async () => {
    const db = seeded(3);
    mocks.extract.mockRejectedValueOnce(APIError.generate(402, { type: "error", error: { type: "billing_error", message: "stopped" } }, "stopped", new Headers()));
    expect(await runReadAfterConsent(asAdmin(db), USER, DECIDED)).toMatchObject({ ok: true, read: 0, unavailable: true, overLimit: false });
    expect(mocks.extract).toHaveBeenCalledTimes(1);
    expect(db.rows("emails")).toHaveLength(3);
  });

  it.each([150_001, 239_000])("at %d ms there is no whole-mail budget left, so the next paid call never starts", async (elapsed) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = Date.parse("2026-11-12T00:00:01Z");
    vi.setSystemTime(start);
    const db = seeded(2);
    mocks.extract.mockImplementationOnce(async () => { vi.setSystemTime(start + elapsed); return notRelevant(); });
    mocks.extract.mockImplementationOnce(async () => { vi.setSystemTime(start + elapsed + 90_000); return notRelevant(); });
    expect(await runReadAfterConsent(asAdmin(db), USER, DECIDED)).toMatchObject({ ok: false, read: 1, message: "ai_consent_backlog_time_limit", overLimit: false, onlyBusy: false });
    expect(mocks.extract).toHaveBeenCalledTimes(1);
    expect(db.rows("emails")).toHaveLength(1);
    expect(db.rows("ai_reading_consents")).toEqual([choice()]);
  });

  it.each([149_999, 150_000])("at %d ms the shared request can still hold one entire mail, including the exact boundary", async (elapsed) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = Date.parse("2026-11-12T00:00:01Z");
    vi.setSystemTime(start);
    const db = seeded(3);
    mocks.extract.mockImplementationOnce(async () => { vi.setSystemTime(start + elapsed); return notRelevant(); });
    mocks.extract.mockImplementationOnce(async () => { vi.setSystemTime(start + elapsed + 90_000); return notRelevant(); });
    expect(await runReadAfterConsent(asAdmin(db), USER, DECIDED)).toMatchObject({ ok: false, read: 2, message: "ai_consent_backlog_time_limit", overLimit: false });
    expect(mocks.extract).toHaveBeenCalledTimes(2);
    expect(db.rows("emails")).toHaveLength(1);
  });

  it("keeps the original request deadline across batches, including time spent fetching the next batch", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = Date.parse("2026-11-12T00:00:01Z");
    vi.setSystemTime(start);
    const db = seeded(21);
    mocks.extract.mockImplementation(async () => { vi.setSystemTime(Date.now() + 7_000); return notRelevant(); });
    let batches = 0;
    db.hooks.push((q) => {
      if (q.table === "emails" && q.op === "select" && q.columns?.startsWith("id, provider_email_id")) {
        batches++;
        if (batches === 2) vi.setSystemTime(start + 150_001);
      }
    });
    expect(await runReadAfterConsent(asAdmin(db), USER, DECIDED)).toMatchObject({ ok: false, read: 20, message: "ai_consent_backlog_time_limit", overLimit: false });
    expect(mocks.extract).toHaveBeenCalledTimes(20);
    expect(batches).toBe(2);
    expect(db.rows("emails")).toHaveLength(1);
  });
});
