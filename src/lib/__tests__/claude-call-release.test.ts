import { APIConnectionError, APIError } from "@anthropic-ai/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClaudeUnavailableError } from "@/lib/extract/claude-error";
import type { InboundEmail } from "@/lib/pipeline";
import { FakeDb } from "./fake-db";
import { OTHER, USER, asConsentingAdmin, mailOf, precomputed, reading, sure, item } from "./pipeline-fixtures";

/**
 * Giving back the allowance of a Claude call that Claude refused (supabase/migrations/
 * 20261112020000_claude_call_release.sql, src/lib/claude-usage.ts). Made-up mails only.
 * The SQL itself was run on a local Postgres 17; the fake database mirrors its rules, and the
 * seams between old and new code and database are played here with it.
 */

const order = reading({ relevance: "order", order_number: sure("ORD-55550000"), items: [item("テスト商品", 900)], total_amount: sure(900) });
const mocks = vi.hoisted(() => ({ extractEmail: vi.fn(), isPurchaseMail: vi.fn() }));
vi.mock("@/lib/extract/extract", () => ({ extractEmail: mocks.extractEmail }));
vi.mock("@/lib/extract/triage", () => ({ isPurchaseMail: mocks.isPurchaseMail }));

const { processInboundEmail } = await import("@/lib/pipeline");
const { claimClaudeCall } = await import("@/lib/claude-usage");

const apiError = (status: number, type: string, message: string) => APIError.generate(status, { type: "error", error: { type, message } }, message, new Headers());
const tierLimit = () => APIError.generate(429, { type: "error", error: { type: "rate_limit_error", message: "x", details: { error_code: "enforced_spend_limit_reached" } } }, "x", new Headers());
const ownLimit = () => apiError(400, "invalid_request_error", "You have reached your specified API usage limits. You will regain access on 2027-01-01 at 00:00 UTC.");
const credit = () => apiError(400, "invalid_request_error", "Your credit balance is too low to access the Anthropic API.");

/** An ordinary order mail: passes the free rules, so only the reading claims. */
const orderMail = (id = "a"): InboundEmail => ({ ...mailOf("2026-11-03T01:00:00Z"), messageId: `<${id}@example.test>`, subject: "ご注文ありがとうございます", text: "ご注文番号 ORD-1 を承りました" });
/** An ad the free rules drop and are sure about; it gets a cheap check only from a marked sender. */
const ad = (id = "ad"): InboundEmail => ({ ...mailOf("2026-11-03T01:00:00Z"), messageId: `<${id}@example.test>`, from: "news@mall.example.test", subject: "今週のおすすめ", text: "新着アイテムのご案内。配信停止はこちら" });
const markedDb = () => {
  const db = new FakeDb();
  db.rows("screen_events").push({ id: "flag", user_id: USER, decision: "dropped", subject: "前に落としたメール", from_domain: "mall.example.test", flagged_at: "2026-11-02T00:00:00Z", created_at: "2026-11-02T00:00:00Z" });
  return db;
};

const used = (db: FakeDb, user = USER) => db.rows("claude_usage_daily").filter((r) => r.user_id === user).reduce((n, r) => n + Number(r.calls), 0);
const rpcs = (db: FakeDb, name: string) => db.rpcCalls.filter((c) => c.name === name);

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon");
  mocks.extractEmail.mockReset();
  mocks.extractEmail.mockImplementation(async () => precomputed(order));
  mocks.isPurchaseMail.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("claimClaudeCall", () => {
  it("claims through v2 and release gives the call back, once", async () => {
    const db = new FakeDb();
    const claim = await claimClaudeCall(asConsentingAdmin(db), USER);
    expect(claim.verdict).toBe("ok");
    expect(used(db)).toBe(1);
    await claim.release();
    await claim.release();
    expect(used(db)).toBe(0);
    expect(rpcs(db, "release_claude_call")).toHaveLength(1);
  });

  it("a refused verdict has nothing to release", async () => {
    const db = new FakeDb({ claude_usage_daily: [{ user_id: USER, day: "2026-11-03", calls: 30 }] });
    db.claudeNow = () => Date.parse("2026-11-03T01:00:00Z");
    const claim = await claimClaudeCall(asConsentingAdmin(db), USER);
    expect(claim.verdict).toBe("user_limit");
    await claim.release();
    expect(rpcs(db, "release_claude_call")).toHaveLength(0);
    expect(used(db)).toBe(30);
  });

  it("a release that fails is logged and does not throw", async () => {
    const db = new FakeDb();
    const claim = await claimClaudeCall(asConsentingAdmin(db), USER);
    db.claudeReleaseMissing = true;
    await expect(claim.release()).resolves.toBeUndefined();
    expect(console.warn).toHaveBeenCalled();
  });

  it("two releases of one claim at once give back one call (the database's rule)", async () => {
    const db = new FakeDb();
    const first = await db.rpc("claim_claude_call_v2", { p_user_id: USER, p_user_limit: 30, p_global_limit: 300 });
    const second = await db.rpc("claim_claude_call_v2", { p_user_id: USER, p_user_limit: 30, p_global_limit: 300 });
    const id = (first.data as Array<{ claim_id: number }>)[0].claim_id;
    expect((second.data as Array<{ claim_id: number }>)[0].claim_id).not.toBe(id);
    const answers = await Promise.all([db.rpc("release_claude_call", { p_claim_id: id, p_user_id: USER }), db.rpc("release_claude_call", { p_claim_id: id, p_user_id: USER })]);
    expect(answers.map((a) => a.data).sort()).toEqual([0, 1]);
    expect(used(db)).toBe(1);
  });

  describe("a release that is legitimate but has nothing to give back answers 0 and changes nothing", () => {
    it("someone else's id, an unknown id", async () => {
      const db = new FakeDb();
      const claim = await db.rpc("claim_claude_call_v2", { p_user_id: USER, p_user_limit: 30, p_global_limit: 300 });
      const id = (claim.data as Array<{ claim_id: number }>)[0].claim_id;
      expect((await db.rpc("release_claude_call", { p_claim_id: id, p_user_id: OTHER })).data).toBe(0);
      expect((await db.rpc("release_claude_call", { p_claim_id: 999, p_user_id: USER })).data).toBe(0);
      expect(used(db)).toBe(1);
    });

    it("a claim row that was pruned", async () => {
      const db = new FakeDb();
      const claim = await db.rpc("claim_claude_call_v2", { p_user_id: USER, p_user_limit: 30, p_global_limit: 300 });
      const id = (claim.data as Array<{ claim_id: number }>)[0].claim_id;
      db.tables.claude_call_claims = [];
      expect((await db.rpc("release_claude_call", { p_claim_id: id, p_user_id: USER })).data).toBe(0);
      expect(used(db)).toBe(1);
    });

    it("a day's count set to 0 by hand: never negative", async () => {
      const db = new FakeDb();
      const claim = await db.rpc("claim_claude_call_v2", { p_user_id: USER, p_user_limit: 30, p_global_limit: 300 });
      const id = (claim.data as Array<{ claim_id: number }>)[0].claim_id;
      db.rows("claude_usage_daily")[0].calls = 0;
      expect((await db.rpc("release_claude_call", { p_claim_id: id, p_user_id: USER })).data).toBe(0);
      expect(used(db)).toBe(0);
    });
  });
});

describe("seams between the code and the database", () => {
  it("1. new code, migration not applied (v2 missing): the old claim is used, the count goes down as before, no error", async () => {
    const db = new FakeDb();
    db.claudeReleaseMissing = true;
    const claim = await claimClaudeCall(asConsentingAdmin(db), USER);
    expect(claim.verdict).toBe("ok");
    expect(rpcs(db, "claim_claude_call")).toHaveLength(1);
    // Going back to the old function is said in the log, every time.
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("claim_claude_call_v2 is missing"));
    await claim.release();
    expect(rpcs(db, "release_claude_call")).toHaveLength(0);
    expect(used(db)).toBe(1);
    expect(db.rows("claude_call_claims")).toHaveLength(0);
  });

  it("1. a mail whose reading Claude refuses, with the migration not applied: failed / claude_unavailable as in the first batch, the call stays used", async () => {
    mocks.extractEmail.mockRejectedValue(credit());
    const db = new FakeDb();
    db.claudeReleaseMissing = true;
    await expect(processInboundEmail(asConsentingAdmin(db), orderMail())).rejects.toBeInstanceOf(ClaudeUnavailableError);
    expect(db.rows("emails")[0]).toMatchObject({ processing_status: "failed", error: "claude_unavailable" });
    expect(used(db)).toBe(1);
  });

  it("2. the first batch's code (the old claim) on an applied database: counts, writes no claim row", async () => {
    const db = new FakeDb();
    const args = { p_user_id: USER, p_user_limit: 30, p_global_limit: 300 };
    expect((await db.rpc("claim_claude_call", args)).data).toBe("ok");
    expect((await db.rpc("claim_claude_call", args)).data).toBe("ok");
    expect(used(db)).toBe(2);
    expect(db.rows("claude_call_claims")).toHaveLength(0);
  });

  it("3. new code, applied database: a refused reading gives its call back", async () => {
    mocks.extractEmail.mockRejectedValue(credit());
    const db = new FakeDb();
    await expect(processInboundEmail(asConsentingAdmin(db), orderMail())).rejects.toBeInstanceOf(ClaudeUnavailableError);
    expect(used(db)).toBe(0);
    expect(db.rows("claude_call_claims")).toMatchObject([{ user_id: USER }]);
    expect(db.rows("claude_call_claims")[0].released_at).not.toBeNull();
  });

  it("4. new code after the rollback SQL: v2 is missing again, the old claim is used", async () => {
    const db = new FakeDb();
    const before = await claimClaudeCall(asConsentingAdmin(db), USER);
    db.claudeReleaseMissing = true;
    const after = await claimClaudeCall(asConsentingAdmin(db), USER);
    expect(after.verdict).toBe("ok");
    await after.release();
    expect(used(db)).toBe(2);
    expect(before.verdict).toBe("ok");
  });

  it("5. v2 and the old claim count the same row by the same rule (Preview and production on one database)", async () => {
    const db = new FakeDb();
    const args = { p_user_id: USER, p_user_limit: 3, p_global_limit: 300 };
    expect((await db.rpc("claim_claude_call", args)).data).toBe("ok");
    expect(((await db.rpc("claim_claude_call_v2", args)).data as Array<{ verdict: string }>)[0].verdict).toBe("ok");
    expect((await db.rpc("claim_claude_call", args)).data).toBe("ok");
    // The third call of three is spent: both functions now refuse by the same row.
    expect((await db.rpc("claim_claude_call", args)).data).toBe("user_limit");
    expect(((await db.rpc("claim_claude_call_v2", args)).data as Array<{ verdict: string }>)[0].verdict).toBe("user_limit");
    expect(db.rows("claude_usage_daily")).toHaveLength(1);
    expect(used(db)).toBe(3);
  });

  it("6. claimed at 23:59 JST, released at 0:01 JST: the earlier day gives the call back, the new day is not touched", async () => {
    const db = new FakeDb();
    db.claudeNow = () => Date.parse("2026-11-10T14:59:00Z"); // 2026-11-10 23:59 JST
    const claim = await claimClaudeCall(asConsentingAdmin(db), USER);
    db.claudeNow = () => Date.parse("2026-11-10T15:01:00Z"); // 2026-11-11 00:01 JST
    const today = await claimClaudeCall(asConsentingAdmin(db), USER);
    await claim.release();
    const byDay = Object.fromEntries(db.rows("claude_usage_daily").map((r) => [String(r.day), r.calls]));
    expect(byDay).toEqual({ "2026-11-10": 0, "2026-11-11": 1 });
    expect(today.verdict).toBe("ok");
  });

  it("only a function that is missing falls back; any other database error is a failure, not a fallback", async () => {
    for (const error of [{ code: "XX000", message: "boom" }, { code: "57014", message: "canceling statement due to statement timeout" }, { message: "connection refused" }]) {
      const db = new FakeDb();
      db.hooks.push(() => undefined);
      const rpc = db.rpc.bind(db);
      db.rpc = (name: string, args?: unknown) => (name === "claim_claude_call_v2" ? Promise.resolve({ data: null, error }) : rpc(name, args));
      await expect(claimClaudeCall(asConsentingAdmin(db), USER)).rejects.toThrow(/claim_claude_call failed/);
      expect(rpcs(db, "claim_claude_call")).toHaveLength(0);
    }
  });

  it("a missing function is told by its code or by its message", async () => {
    for (const error of [{ code: "PGRST202", message: "x" }, { code: "42883", message: "x" }, { message: "Could not find the function public.claim_claude_call_v2(p_global_limit, p_user_id, p_user_limit) in the schema cache" }]) {
      const db = new FakeDb();
      const rpc = db.rpc.bind(db);
      db.rpc = (name: string, args?: unknown) => (name === "claim_claude_call_v2" ? Promise.resolve({ data: null, error }) : rpc(name, args));
      expect((await claimClaudeCall(asConsentingAdmin(db), USER)).verdict).toBe("ok");
      expect(rpcs(db, "claim_claude_call")).toHaveLength(1);
    }
  });
});

describe("the reading gives the call back only when Claude is stopped (claude_unavailable)", () => {
  it.each([
    ["402 (no credit)", () => apiError(402, "billing_error", "x"), true],
    ["400 (credit balance too low)", () => credit(), true],
    ["400 (own spend limit)", () => ownLimit(), true],
    ["429 (the monthly spend limit of the tier)", () => tierLimit(), true],
    ["404 (no such model)", () => apiError(404, "not_found_error", "x"), true],
    ["500 (server trouble: whether the request was billed is unknown)", () => apiError(500, "api_error", "x"), false],
    ["529 (overloaded)", () => apiError(529, "overloaded_error", "x"), false],
    ["429 (an ordinary rate limit)", () => apiError(429, "rate_limit_error", "x"), false],
    ["a broken connection (it may have been served)", () => new APIConnectionError({ message: "socket hang up" }), false],
    ["a reading that does not parse", () => new SyntaxError("Unexpected token } in JSON"), false],
  ])("%s", async (_name, make, given) => {
    mocks.extractEmail.mockRejectedValue(make());
    const db = new FakeDb();
    await processInboundEmail(asConsentingAdmin(db), orderMail()).catch(() => {});
    expect(used(db)).toBe(given ? 0 : 1);
    expect(rpcs(db, "release_claude_call")).toHaveLength(given ? 1 : 0);
  });

  it("a mail that reads fine keeps its call", async () => {
    const db = new FakeDb();
    expect((await processInboundEmail(asConsentingAdmin(db), orderMail())).kind).toBe("processed");
    expect(used(db)).toBe(1);
    expect(rpcs(db, "release_claude_call")).toHaveLength(0);
  });

  it("many mails while Claude is stopped do not use up the day: after it is back, the next mail is read", async () => {
    mocks.extractEmail.mockRejectedValue(credit());
    const db = new FakeDb();
    for (let i = 0; i < 40; i++) await processInboundEmail(asConsentingAdmin(db), orderMail(`s${i}`)).catch(() => {});
    expect(used(db)).toBe(0);
    mocks.extractEmail.mockImplementation(async () => precomputed(order));
    expect((await processInboundEmail(asConsentingAdmin(db), orderMail("back"))).kind).toBe("processed");
  });
});

describe("the cheap check (second look) never stops the reading by itself", () => {
  it.each([
    ["402", () => apiError(402, "billing_error", "x")],
    ["404 (the cheap model is gone)", () => apiError(404, "not_found_error", "x")],
    ["403 (no permission for the cheap model)", () => apiError(403, "permission_error", "x")],
  ])("%s: the call of the check comes back, the mail is kept and read, and a good reading makes it processed", async (_name, make) => {
    mocks.isPurchaseMail.mockRejectedValue(make());
    const db = markedDb();
    expect((await processInboundEmail(asConsentingAdmin(db), ad())).kind).toBe("processed");
    expect(mocks.extractEmail).toHaveBeenCalledTimes(1);
    expect(rpcs(db, "claim_claude_call_v2")).toHaveLength(2);
    expect(rpcs(db, "release_claude_call")).toHaveLength(1);
    // The call of the check came back; the call of the reading is spent.
    expect(used(db)).toBe(1);
    expect(db.rows("emails")).toMatchObject([{ processing_status: "processed" }]);
  });

  it("the cheap check and the reading both 402: it stops at the reading (failed / claude_unavailable), both calls come back", async () => {
    mocks.isPurchaseMail.mockRejectedValue(credit());
    mocks.extractEmail.mockRejectedValue(credit());
    const db = markedDb();
    await expect(processInboundEmail(asConsentingAdmin(db), ad())).rejects.toBeInstanceOf(ClaudeUnavailableError);
    expect(db.rows("emails")).toMatchObject([{ user_id: USER, processing_status: "failed", error: "claude_unavailable" }]);
    expect(mocks.extractEmail).toHaveBeenCalledTimes(1);
    expect(used(db)).toBe(0);
  });

  it("a temporary failure (500): the mail is kept and read, and the call of the check is not given back", async () => {
    mocks.isPurchaseMail.mockRejectedValue(apiError(500, "api_error", "x"));
    const db = markedDb();
    expect((await processInboundEmail(asConsentingAdmin(db), ad())).kind).toBe("processed");
    expect(mocks.extractEmail).toHaveBeenCalledTimes(1);
    expect(rpcs(db, "release_claude_call")).toHaveLength(0);
    expect(used(db)).toBe(2);
  });

  it("a broken connection: the mail is kept and read, and the call of the check is not given back", async () => {
    mocks.isPurchaseMail.mockRejectedValue(new APIConnectionError({ message: "socket hang up" }));
    const db = markedDb();
    expect((await processInboundEmail(asConsentingAdmin(db), ad())).kind).toBe("processed");
    expect(rpcs(db, "release_claude_call")).toHaveLength(0);
    expect(used(db)).toBe(2);
  });

  it("an answer 'not a purchase' keeps its call (it was paid for)", async () => {
    mocks.isPurchaseMail.mockResolvedValue(false);
    const db = markedDb();
    expect((await processInboundEmail(asConsentingAdmin(db), ad())).kind).toBe("screened_out");
    expect(used(db)).toBe(1);
    expect(db.rows("emails")).toHaveLength(0);
  });

  it("with the migration not applied: a 402 of the cheap check does not stop the reading, and no call comes back", async () => {
    mocks.isPurchaseMail.mockRejectedValue(credit());
    const db = markedDb();
    db.claudeReleaseMissing = true;
    expect((await processInboundEmail(asConsentingAdmin(db), ad())).kind).toBe("processed");
    expect(used(db)).toBe(2);
  });
});
