import { createClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runReadAfterConsent } from "@/lib/ai-consent-run";
import { runReadWaitingMail } from "@/lib/mail-run";
import { env } from "@/lib/env";
import { FakeDb, consentWaitingRetentionMs, type Row } from "./fake-db";
import { OTHER, USER, asAdmin, precomputed, reading } from "./pipeline-fixtures";
import type { AdminClient } from "@/lib/supabase/admin";

const mocks = vi.hoisted(() => ({ extract: vi.fn(), triage: vi.fn() }));
vi.mock("@/lib/extract/extract", () => ({ extractEmail: mocks.extract }));
vi.mock("@/lib/extract/triage", () => ({ isPurchaseMail: mocks.triage }));

const GRANTED = "2026-11-12T00:00:00.123456Z";
const NOW = Date.parse("2026-11-12T00:00:01Z");
const RECEIVED = "2026-11-10T00:00:00.000000Z";
const granted = () => ({ user_id: USER, decision: "granted", decided_at: GRANTED, text_version: "v1" });
/** Post-120000 state: the migration assigns the marker without replacing a legacy error. */
const migrated = (id: number, over: Partial<Row> = {}): Row => ({
  id: `migrated-${id}`, user_id: USER, processing_status: "over_limit", error: "user_limit", body_state: "plain",
  provider_email_id: `provider-${id}`, message_id: `<migrated-${id}@example.test>`,
  from_address: "orders@example.test", from_name: null, subject: "ご注文ありがとうございます",
  text_body: `ご注文番号 TEST-${id}`, html_body: null, classification: null,
  sent_at: new Date(Date.parse(RECEIVED) + id * 1000).toISOString(), received_at: RECEIVED, created_at: RECEIVED,
  consent_waiting_until: new Date(Date.parse(RECEIVED) + consentWaitingRetentionMs()).toISOString(), ...over,
});
const dbFor = (rows: Row[]) => new FakeDb({ ai_reading_consents: [granted()], emails: rows });
const start = (db: FakeDb) => runReadAfterConsent(asAdmin(db), USER, GRANTED);
const backlogQueries = (db: FakeDb) => db.callsOn("emails", "select").filter((q) => q.columns?.startsWith("id, provider_email_id"));
const savedReading = () => precomputed(reading({ relevance: "other_purchase", relevance_evidence: "ご注文番号" }));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon");
  mocks.extract.mockReset().mockImplementation(async () => savedReading());
  mocks.triage.mockReset().mockResolvedValue(true);
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("N2: migration-marked pre-consent mail participates in the first automatic reading", () => {
  it("reads old allowance, stopped-Claude and other-failure reasons by their marker without rewriting the displayed reasons first", async () => {
    const rows = [migrated(1), migrated(2, { processing_status: "failed", error: "claude_unavailable", provider_email_id: null }), migrated(3, { processing_status: "failed", error: "old database failure", created_at: "2026-11-12T00:00:00.123457Z" })];
    const db = dbFor(rows);
    const reasonsAtSelection: unknown[][] = [];
    db.hooks.push((q) => {
      if (q.table === "emails" && q.op === "select" && q.columns?.startsWith("id, provider_email_id")) reasonsAtSelection.push(db.rows("emails").map((row) => row.error));
    });
    expect(await start(db)).toEqual({ ok: true, read: 3, overLimit: false, unavailable: false });
    expect(reasonsAtSelection[0]).toEqual(["user_limit", "claude_unavailable", "old database failure"]);
    expect(db.rows("emails").every((row) => row.processing_status === "processed")).toBe(true);
    expect(mocks.extract).toHaveBeenCalledTimes(3);
    expect(mocks.triage).not.toHaveBeenCalled();
    expect(db.rows("ai_consent_read_runs")).toHaveLength(1);
    expect(await start(db)).toMatchObject({ ok: true, read: 0 });
  });

  it("applies all exclusions before the twenty-row limit so earlier non-candidates cannot hide a legitimate legacy mail", async () => {
    const notCandidates = [
      ...Array.from({ length: 20 }, (_, index) => migrated(index + 1, { consent_waiting_until: null, error: "ai_consent_required" })),
      migrated(21, { provider_email_id: "demo:sample", error: "ai_consent_required" }),
      migrated(22, { classification: "forwarding_confirmation", error: "ai_consent_required" }),
      migrated(23, { received_at: "2026-11-12T00:00:00.123457Z", error: "ai_consent_required" }),
      migrated(24, { user_id: OTHER, error: "ai_consent_required" }),
      migrated(25, { body_state: "sealed", error: "ai_consent_required" }),
      migrated(26, { processing_status: "processed", error: "ai_consent_required" }),
      migrated(27, { consent_waiting_until: new Date(NOW).toISOString(), error: "ai_consent_required" }),
    ];
    const db = dbFor([...notCandidates, migrated(99)]);
    const untouched = structuredClone(db.rows("emails").slice(0, notCandidates.length));
    expect(await start(db)).toMatchObject({ ok: true, read: 1 });
    expect(mocks.extract).toHaveBeenCalledTimes(1);
    expect(db.rows("emails").slice(0, notCandidates.length)).toEqual(untouched);
    expect(backlogQueries(db).every((q) => q.limit === 20)).toBe(true);
    expect(backlogQueries(db).every((q) => q.filters.filter((f) => f.method === "or").length === 1)).toBe(true);
  });

  it.each(["user", "global"] as const)("a renewed %s allowance stop retains the current limit and all untouched legacy reasons", async (kind) => {
    const db = dbFor([migrated(1, { error: `${kind}_limit` }), migrated(2, { processing_status: "failed", error: "claude_unavailable" })]);
    const untouched = structuredClone(db.rows("emails")[1]);
    const limits = env();
    db.rows("claude_usage_daily").push({ user_id: kind === "user" ? USER : OTHER, day: "2026-11-12", calls: kind === "user" ? limits.OTODOKE_USER_DAILY_LIMIT : limits.OTODOKE_GLOBAL_DAILY_LIMIT });
    expect(await start(db)).toEqual({ ok: true, read: 0, overLimit: true, unavailable: false });
    expect(db.rows("emails")[0]).toMatchObject({ processing_status: "over_limit", error: `${kind}_limit` });
    expect(db.rows("emails")[1]).toEqual(untouched);
    expect(mocks.extract).not.toHaveBeenCalled();
    expect(mocks.triage).not.toHaveBeenCalled();
    expect(db.rows("ai_reading_consents")).toEqual([granted()]);
  });

  it("uses received_at rather than a retry's updated created_at, preserving the grant's microseconds", async () => {
    const db = dbFor([migrated(1, { error: "ai_consent_required", received_at: GRANTED, created_at: "2026-11-12T00:00:00.123457Z" }), migrated(2, { error: "ai_consent_required", received_at: "2026-11-12T00:00:00.123457Z", created_at: RECEIVED })]);
    expect(await start(db)).toMatchObject({ ok: true, read: 1 });
    expect(db.rows("emails")[0].processing_status).toBe("processed");
    expect(db.rows("emails")[1]).toMatchObject({ processing_status: "over_limit", error: "ai_consent_required" });
    expect(mocks.extract).toHaveBeenCalledTimes(1);
  });

  it("excludes a deadline equal to the grant even when the application clock is fractionally earlier", async () => {
    vi.setSystemTime(Date.parse(GRANTED));
    const db = dbFor([migrated(1, { error: "ai_consent_required", consent_waiting_until: GRANTED })]);
    expect(await start(db)).toMatchObject({ ok: true, read: 0 });
    expect(mocks.extract).not.toHaveBeenCalled();
    expect(db.rows("emails")[0].processing_status).toBe("over_limit");
  });

  it("refreshes the expiry cutoff for every batch without adding a mail-count cap", async () => {
    const rows = Array.from({ length: 20 }, (_, index) => migrated(index + 1));
    rows.push(migrated(21, { consent_waiting_until: new Date(NOW + 1000).toISOString() }));
    const db = dbFor(rows);
    mocks.extract.mockImplementation(async () => { vi.setSystemTime(Date.now() + 50); return savedReading(); });
    expect(await start(db)).toMatchObject({ ok: true, read: 20 });
    expect(mocks.extract).toHaveBeenCalledTimes(20);
    expect(db.rows("emails")[20].processing_status).toBe("over_limit");
    const queries = backlogQueries(db);
    expect(queries).toHaveLength(2);
    expect(queries[0].filters).toContainEqual({ method: "gt", args: ["consent_waiting_until", new Date(NOW).toISOString()] });
    expect(queries[1].filters).toContainEqual({ method: "gt", args: ["consent_waiting_until", new Date(NOW + 1000).toISOString()] });
  });

  it("the existing store expiry check prevents Claude when a selected mail expires before takeover", async () => {
    const expiry = NOW + 1;
    const db = dbFor([migrated(1, { consent_waiting_until: new Date(expiry).toISOString() })]);
    let crossed = false;
    db.hooks.push((q) => {
      if (!crossed && q.table === "emails" && q.op === "select" && q.columns?.includes("processing_run_id")) { vi.setSystemTime(expiry); crossed = true; }
    });
    expect(await start(db)).toMatchObject({ ok: true, read: 1 });
    expect(crossed).toBe(true);
    expect(db.rows("emails")).toEqual([]);
    expect(mocks.extract).not.toHaveBeenCalled();
    expect(mocks.triage).not.toHaveBeenCalled();
    expect(db.rpcCalls.filter((call) => /claim_claude_call/.test(call.name))).toEqual([]);
  });

  it("the manual reader keeps its wider non-consent-failure set", async () => {
    const db = dbFor([migrated(1, { consent_waiting_until: null, processing_status: "failed", error: "old database failure" })]);
    expect(await start(db)).toMatchObject({ ok: true, read: 0 });
    expect(await runReadWaitingMail(asAdmin(db), USER)).toMatchObject({ ok: true, read: 1 });
    expect(mocks.extract).toHaveBeenCalledTimes(1);
  });

  it("the real SDK emits a single logical filter with all eligibility predicates before limit, using only an in-memory fetch stub", async () => {
    const urls: URL[] = [];
    const fetchStub: typeof fetch = async (input) => {
      urls.push(new URL(input instanceof Request ? input.url : String(input)));
      return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
    };
    const db = createClient("http://127.0.0.1:1", "local-test-key", { global: { fetch: fetchStub }, auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
    expect(await runReadWaitingMail(db as unknown as AdminClient, USER, { consentDecidedAt: GRANTED })).toMatchObject({ ok: true, read: 0 });
    expect(urls).toHaveLength(1);
    const query = urls[0].searchParams;
    expect(query.get("user_id")).toBe(`eq.${USER}`);
    expect(query.get("body_state")).toBe("eq.plain");
    expect(query.get("received_at")).toBe(`lte.${GRANTED}`);
    expect(query.get("consent_waiting_until")).toBe(`gt.${new Date(NOW).toISOString()}`);
    expect(query.get("limit")).toBe("20");
    expect(query.get("error")).toBeNull();
    expect(query.getAll("or")).toHaveLength(1);
    expect(query.get("or")).toContain(`consent_waiting_until.gt.${GRANTED}`);
    expect(query.get("or")).toContain("provider_email_id.is.null,provider_email_id.not.like.demo:%");
    expect(query.get("or")).toContain("classification.is.null,classification.neq.forwarding_confirmation");
    expect(query.get("or")).toContain("processing_status.in.(over_limit,failed)");
    expect(mocks.extract).not.toHaveBeenCalled();
    expect(mocks.triage).not.toHaveBeenCalled();
  });
});
