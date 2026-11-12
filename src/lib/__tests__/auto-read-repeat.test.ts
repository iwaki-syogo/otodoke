import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/db/database.types";
import { env } from "@/lib/env";
import { FakeDb, consentWaitingRetentionMs } from "./fake-db";
import { USER, asAdmin, precomputed, reading } from "./pipeline-fixtures";

const mocks = vi.hoisted(() => ({ extract: vi.fn(), triage: vi.fn(), demo: vi.fn(), fetch: vi.fn() }));
vi.mock("@/lib/extract/extract", () => ({ extractEmail: mocks.extract }));
vi.mock("@/lib/extract/triage", () => ({ isPurchaseMail: mocks.triage }));
vi.mock("@/lib/demo", () => ({
  loadDemoEntries: mocks.demo,
  demoInput: () => { throw new Error("sample input is forbidden in this test"); },
}));

const { runReadAfterConsent } = await import("@/lib/ai-consent-run");
const { runReadWaitingMail } = await import("@/lib/mail-run");
const { runClearAllParcels } = await import("@/lib/demo-run");
const NOW = Date.parse("2026-11-12T00:00:01Z");
const DECIDED = "2026-11-12T00:00:00.123456Z";
const RECEIVED = "2026-11-01T00:00:00.000000Z";
const BODY = "ご注文番号 SYNTHETIC-1 を承りました。";

function seeded(count = 1) {
  return new FakeDb({
    ai_reading_consents: [{ user_id: USER, decision: "granted", decided_at: DECIDED, text_version: "v1" }],
    emails: Array.from({ length: count }, (_, index) => ({
      id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`, user_id: USER,
      processing_status: "failed", error: "ai_consent_required", body_state: "plain",
      provider_email_id: `synthetic-provider-${index + 1}`, message_id: `<synthetic-${index + 1}@example.test>`,
      from_address: "shop@example.test", from_name: null, subject: "ご注文ありがとうございます",
      sent_at: new Date(Date.parse(RECEIVED) + index * 1000).toISOString(),
      text_body: count === 1 ? BODY : `ご注文番号 SYNTHETIC-${index + 1} を承りました。`, html_body: null,
      created_at: RECEIVED, received_at: RECEIVED,
      consent_waiting_until: new Date(Date.parse(RECEIVED) + consentWaitingRetentionMs()).toISOString(),
    })),
  });
}

function retained(variant: "unverified_unrelated" | "model_refused") {
  const result = precomputed(reading({ relevance: "unrelated", relevance_evidence: "this quote is absent from the source" }));
  return variant === "model_refused" ? { ...result, refused: true } : result;
}
const charged = (db: FakeDb) => db.rows("claude_usage_daily").reduce((sum, row) => sum + Number(row.calls), 0);
const batches = (db: FakeDb) => db.callsOn("emails", "select").filter((query) => query.columns?.startsWith("id, created_at, provider_email_id"));
const limits = (userLimit = 3, globalLimit = 10) => Object.assign(env(), { OTODOKE_USER_DAILY_LIMIT: userLimit, OTODOKE_GLOBAL_DAILY_LIMIT: globalLimit });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "dummy-public-key");
  vi.stubEnv("OTODOKE_USER_DAILY_LIMIT", "3");
  vi.stubEnv("OTODOKE_GLOBAL_DAILY_LIMIT", "10");
  limits();
  mocks.extract.mockReset();
  mocks.triage.mockReset().mockImplementation(() => { throw new Error("unexpected paid triage"); });
  mocks.demo.mockReset().mockImplementation(() => { throw new Error("fixture loading is forbidden"); });
  mocks.fetch.mockReset().mockImplementation(() => { throw new Error("external fetch is forbidden"); });
  vi.stubGlobal("fetch", mocks.fetch);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("one attempt per email in an automatic consent read", () => {
  it.each(["unverified_unrelated", "model_refused"] as const)("does not spend twice on a retained %s mail, while a later manual request can retry", async (variant) => {
    const db = seeded();
    let calls = 0;
    mocks.extract.mockImplementation(async () => {
      if (++calls > 3) throw new Error("finite extraction guard exceeded");
      return retained(variant);
    });
    const result = await runReadAfterConsent(asAdmin(db), USER, DECIDED, NOW);
    expect(mocks.extract, JSON.stringify({ result, ledger: db.rows("claude_call_claims").length, charged: charged(db) })).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ ok: true, read: 1, overLimit: false, unavailable: false });
    expect(db.rows("emails")).toHaveLength(1);
    expect(db.rows("emails")[0]).toMatchObject({ processing_status: "failed", error: variant === "model_refused" ? "model refused" : "relevance_unverified", text_body: BODY });
    expect(db.rows("emails")[0].created_at).not.toBe(RECEIVED);
    expect(db.rows("claude_call_claims")).toHaveLength(1);
    expect(charged(db)).toBe(1);
    expect(db.rows("ai_consent_read_runs")).toHaveLength(1);
    expect(db.rows("extractions")).toEqual([]);
    expect(db.rows("parcels")).toEqual([]);

    mocks.extract.mockImplementation(async () => precomputed(reading({ relevance: "unrelated", relevance_evidence: BODY })));
    expect(await runReadWaitingMail(asAdmin(db), USER)).toMatchObject({ ok: true, read: 1 });
    expect(mocks.extract).toHaveBeenCalledTimes(2);
    expect(charged(db)).toBe(2);
    expect(db.rows("emails")).toEqual([]);
    expect(mocks.triage).not.toHaveBeenCalled();
    expect(mocks.demo).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("control: a grounded unrelated verdict removes its row with one paid reading", async () => {
    const db = seeded();
    let calls = 0;
    mocks.extract.mockImplementation(async () => {
      if (++calls > 3) throw new Error("finite extraction guard exceeded");
      return precomputed(reading({ relevance: "unrelated", relevance_evidence: BODY }));
    });
    expect(await runReadAfterConsent(asAdmin(db), USER, DECIDED, NOW)).toEqual({ ok: true, read: 1, overLimit: false, unavailable: false });
    expect(mocks.extract).toHaveBeenCalledTimes(1);
    expect(db.rows("emails")).toEqual([]);
    expect(charged(db)).toBe(1);
    expect(batches(db)).toHaveLength(2);
    expect(mocks.triage).not.toHaveBeenCalled();
    expect(mocks.demo).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("survives deletion of an already attempted row between pages", async () => {
    const db = seeded(21);
    limits(100, 200);
    let calls = 0;
    mocks.extract.mockImplementation(async (mail: { body: string }) => {
      if (++calls > 21) throw new Error("finite extraction guard exceeded");
      return mail.body.includes("SYNTHETIC-21 ")
        ? precomputed(reading({ relevance: "unrelated", relevance_evidence: mail.body }))
        : retained("model_refused");
    });
    let lookups = 0;
    db.hooks.push((query) => {
      if (query.table === "emails" && query.op === "select" && query.columns?.startsWith("id, created_at, provider_email_id") && ++lookups === 3) {
        // A different manual request removed one retained row after the visited page was read.
        db.tables.emails = db.rows("emails").filter((row) => row.id !== "00000000-0000-4000-8000-000000000001");
      }
    });
    const result = await runReadAfterConsent(asAdmin(db), USER, DECIDED, NOW);
    expect(mocks.extract, JSON.stringify({ result, lookups })).toHaveBeenCalledTimes(21);
    expect(result).toEqual({ ok: true, read: 21, overLimit: false, unavailable: false });
    expect(new Set(mocks.extract.mock.calls.map(([mail]) => mail.body)).size).toBe(21);
    expect(db.rows("emails")).toHaveLength(19);
    expect(charged(db)).toBe(21);
    expect(mocks.demo).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it.each([1000, 3])("passes retained pages to a later successful mail once with a server cap of %i", async (cap) => {
    const db = seeded(41);
    db.maxRows = cap;
    limits(100, 200);
    const expectedBodies = db.rows("emails").map((row) => row.text_body);
    for (const row of db.rows("emails")) row.sent_at = cap === 3 ? null : RECEIVED;
    db.tables.emails.reverse();
    let calls = 0;
    mocks.extract.mockImplementation(async (mail: { body: string }) => {
      if (++calls > 41) throw new Error("finite extraction guard exceeded");
      return mail.body.includes("SYNTHETIC-41 ") ? precomputed(reading({
        relevance: "order", relevance_evidence: "ご注文番号",
        order_number: { value: "SYNTHETIC-41", evidence: "SYNTHETIC-41", confidence: 0.95 },
      })) : retained(calls % 2 === 0 ? "model_refused" : "unverified_unrelated");
    });
    expect(await runReadAfterConsent(asAdmin(db), USER, DECIDED, NOW)).toEqual({ ok: true, read: 41, overLimit: false, unavailable: false });
    expect(mocks.extract.mock.calls.map(([mail]) => mail.body)).toEqual(expectedBodies);
    expect(charged(db)).toBe(41);
    expect(db.rows("emails").filter((row) => row.processing_status === "failed")).toHaveLength(40);
    expect(db.rows("emails").filter((row) => row.error === "model refused")).toHaveLength(20);
    expect(db.rows("emails").filter((row) => row.error === "relevance_unverified")).toHaveLength(20);
    expect(db.rows("emails").filter((row) => row.processing_status === "processed")).toHaveLength(1);
    expect(db.rows("parcels")).toHaveLength(1);
    expect(db.rows("extractions")).toHaveLength(1);
    const pages = batches(db);
    expect(pages.every((page) => page.range?.[0] === 0 && page.range[1] === 19)).toBe(true);
    expect(pages.every((page) => page.filters.filter((filter) => filter.method === "or").length === 1)).toBe(true);
    expect(pages.some((page) => page.filters.some((filter) => String(filter.args[0]).includes("id.gt.")))).toBe(true);
    expect(mocks.triage).not.toHaveBeenCalled();
    expect(mocks.demo).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("keeps equal microsecond timestamps ordered by id before moving into NULL sent_at rows", async () => {
    const db = seeded(4);
    db.maxRows = 1;
    limits(10, 20);
    const expectedBodies = db.rows("emails").map((row) => row.text_body);
    const dates = ["2026-11-01T00:00:00.123455Z", "2026-11-01T00:00:00.123456Z", "2026-11-01T00:00:00.123456Z", null];
    db.rows("emails").forEach((row, index) => { row.sent_at = dates[index]; });
    db.tables.emails.reverse();
    let calls = 0;
    mocks.extract.mockImplementation(async () => {
      if (++calls > 4) throw new Error("finite extraction guard exceeded");
      return retained(calls % 2 === 0 ? "model_refused" : "unverified_unrelated");
    });
    expect(await runReadAfterConsent(asAdmin(db), USER, DECIDED, NOW)).toEqual({ ok: true, read: 4, overLimit: false, unavailable: false });
    expect(mocks.extract.mock.calls.map(([mail]) => mail.body)).toEqual(expectedBodies);
    expect(charged(db)).toBe(4);
    const filters = batches(db).map((page) => String(page.filters.find((filter) => filter.method === "or")?.args[0]));
    expect(filters.some((filter) => filter.includes("sent_at.eq.2026-11-01T00:00:00.123456Z,id.gt.00000000-0000-4000-8000-000000000002"))).toBe(true);
    expect(filters.some((filter) => filter.includes("and(sent_at.is.null,id.gt.00000000-0000-4000-8000-000000000004)"))).toBe(true);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it.each(["error", "null", "throw"] as const)("a later visited-page lookup %s is never an empty successful drain", async (kind) => {
    const db = seeded(2);
    db.maxRows = 1;
    let calls = 0;
    mocks.extract.mockImplementation(async () => {
      if (++calls > 2) throw new Error("finite extraction guard exceeded");
      return retained("model_refused");
    });
    db.hooks.push((query) => {
      if (query.table !== "emails" || query.op !== "select" || !query.columns?.startsWith("id, created_at, provider_email_id")
        || !query.filters.some((filter) => String(filter.args[0]).includes("id.gt."))) return;
      if (kind === "throw") throw new Error("later page threw");
      return { data: null, error: kind === "error" ? { message: "later page failed" } : null };
    });
    const result = await runReadAfterConsent(asAdmin(db), USER, DECIDED, NOW);
    expect(result).toMatchObject({ ok: false, read: 1, overLimit: false, onlyBusy: false });
    expect(result).toHaveProperty("stage", kind === "throw" ? "read" : "lookup");
    expect(mocks.extract).toHaveBeenCalledTimes(1);
    expect(charged(db)).toBe(1);
    expect(db.rows("emails")).toHaveLength(2);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("checks the whole-mail budget between visited-page lookups", async () => {
    const db = seeded(2);
    db.maxRows = 1;
    let calls = 0;
    mocks.extract.mockImplementation(async () => {
      if (++calls > 2) throw new Error("finite extraction guard exceeded");
      return retained("model_refused");
    });
    let lookups = 0;
    db.hooks.push((query) => {
      if (query.table === "emails" && query.op === "select" && query.columns?.startsWith("id, created_at, provider_email_id") && ++lookups === 2) vi.setSystemTime(NOW + 150_001);
    });
    expect(await runReadAfterConsent(asAdmin(db), USER, DECIDED, NOW)).toMatchObject({ ok: false, read: 1, message: "ai_consent_backlog_time_limit" });
    expect(lookups).toBe(2);
    expect(mocks.extract).toHaveBeenCalledTimes(1);
    expect(db.rows("emails")).toHaveLength(2);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("keeps the old generation across a clear and accepts a new explicit request afterward", async () => {
    const db = seeded(21);
    limits(100, 200);
    let calls = 0;
    mocks.extract.mockImplementation(async (mail: { body: string }) => {
      if (++calls > 22) throw new Error("finite extraction guard exceeded");
      if (calls === 20) {
        expect(await runClearAllParcels(asAdmin(db), USER)).toBeNull();
        const fresh = seeded().rows("emails")[0];
        db.rows("emails").push({ ...fresh, id: "fresh-after-clear", message_id: "<fresh-after-clear@example.test>", provider_email_id: "fresh-after-clear",
          received_at: new Date(NOW).toISOString(), created_at: new Date(NOW).toISOString(), consent_waiting_until: null });
      }
      return calls < 20 ? retained(calls % 2 === 0 ? "model_refused" : "unverified_unrelated")
        : precomputed(reading({ relevance: "unrelated", relevance_evidence: mail.body }));
    });
    expect(await runReadAfterConsent(asAdmin(db), USER, DECIDED, NOW)).toMatchObject({ ok: false, read: 19 });
    expect(mocks.extract).toHaveBeenCalledTimes(20);
    expect(db.rows("emails").map((row) => row.id)).toEqual(["fresh-after-clear"]);
    const oldGeneration = batches(db)[0].requestHeaders;
    expect(batches(db).every((page) => JSON.stringify(page.requestHeaders) === JSON.stringify(oldGeneration))).toBe(true);
    const newGeneration = db.rows("sample_generations").find((row) => row.user_id === USER)?.generation;
    expect(oldGeneration?.["x-otodoke-sample-generation"]).not.toBe(newGeneration);
    expect(charged(db)).toBe(20);
    const beforeManual = batches(db).length;
    expect(await runReadWaitingMail(asAdmin(db), USER)).toMatchObject({ ok: true, read: 1 });
    expect(mocks.extract).toHaveBeenCalledTimes(21);
    expect(batches(db)[beforeManual].requestHeaders?.["x-otodoke-sample-generation"]).toBe(newGeneration);
    expect(charged(db)).toBe(21);
    expect(db.rows("emails")).toEqual([]);
    expect(mocks.demo).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("sends one bounded SDK cursor filter with raw microseconds and the NULL-last boundary", async () => {
    const first = "00000000-0000-4000-8000-000000000001";
    const second = "00000000-0000-4000-8000-000000000002";
    const rawTimestamp = "2026-11-01T00:00:00.123456+00:00";
    const urls: URL[] = [];
    const pages = [[{ id: first, sent_at: rawTimestamp }], [{ id: second, sent_at: null }], []];
    const client = createClient<Database>("https://example.supabase.co", "dummy-public-key", {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { fetch: async (input) => {
        const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
        if (url.pathname.endsWith("/rpc/begin_sample_load")) return new Response(JSON.stringify("00000000-0000-4000-8000-000000000099"), { status: 200, headers: { "content-type": "application/json" } });
        if (!url.pathname.endsWith("/emails")) throw new Error("unexpected SDK request");
        urls.push(url);
        if (urls.length > 3) throw new Error("finite SDK page guard exceeded");
        return new Response(JSON.stringify(pages[urls.length - 1]), { status: 200, headers: { "content-type": "application/json" } });
      } },
    });
    const attemptedEmailIds = new Set([first, second, ...Array.from({ length: 5000 }, (_, index) => `already-attempted-${index}`)]);
    expect(await runReadWaitingMail(client, USER, { consentDecidedAt: DECIDED, attemptedEmailIds, deadlineAt: NOW + 270_000, minimumMailBudgetMs: 120_000 })).toEqual({ ok: true, read: 0, overLimit: false, unavailable: false });
    expect(urls).toHaveLength(3);
    for (const url of urls) {
      expect(url.searchParams.getAll("or")).toHaveLength(1);
      expect(url.searchParams.get("user_id")).toBe(`eq.${USER}`);
      expect(url.searchParams.get("body_state")).toBe("eq.plain");
      expect(url.searchParams.get("received_at")).toBe(`lte.${DECIDED}`);
      expect(url.searchParams.get("consent_waiting_until")).toBe(`gt.${new Date(NOW).toISOString()}`);
      expect(url.searchParams.get("order")).toBe("sent_at.asc.nullslast,id.asc");
      expect(url.searchParams.get("limit")).toBe("20");
      expect(url.href.length).toBeLessThan(8192);
    }
    expect(urls[1].searchParams.get("or")).toContain(`or(sent_at.gt.${rawTimestamp},and(sent_at.eq.${rawTimestamp},id.gt.${first}),sent_at.is.null)`);
    expect(urls[2].searchParams.get("or")).toContain(`and(sent_at.is.null,id.gt.${second})`);
    expect(mocks.extract).not.toHaveBeenCalled();
    expect(mocks.triage).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
});
