import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AiReadingNotAllowedError, requireAiReadingConsent } from "@/lib/ai-consent";
import { MAIL_LEASE_MS } from "@/lib/unread";
import { withMailRun } from "@/lib/mail-run-db";
import { FakeDb } from "./fake-db";
import { USER, asAdmin, item, mailOf, precomputed, reading, sure } from "./pipeline-fixtures";

/**
 * Seams between the reading-permission check (feature/ai-consent) and the cost guards
 * (fix/cost-guards): storage capacity, the unread set, the owned lease, and the webhook answers.
 */

const mocks = vi.hoisted(() => ({
  extract: vi.fn(),
  triage: vi.fn(),
  verify: (() => ({})) as () => unknown,
  fetched: null as unknown,
  db: null as unknown,
}));
vi.mock("@/lib/extract/extract", () => ({ extractEmail: mocks.extract }));
vi.mock("@/lib/extract/triage", () => ({ isPurchaseMail: mocks.triage }));
vi.mock("resend", () => ({
  Resend: class {
    webhooks = { verify: () => mocks.verify() };
    emails = { receiving: { get: async () => ({ data: mocks.fetched, error: null }) } };
  },
}));
vi.mock("@/lib/env", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/env")>();
  return { ...real, requireEnv: (name: string) => ({ RESEND_API_KEY: "re_test", RESEND_WEBHOOK_SECRET: "whsec_test", INBOUND_DOMAIN: "in.example.test" } as Record<string, string>)[name] ?? "" };
});
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => mocks.db }));
vi.mock("@/lib/seal-later", () => ({ scheduleSealRemaining: vi.fn() }));

const { processInboundEmail, MailBeingReadError } = await import("@/lib/pipeline");
const { runReadWaitingMail } = await import("@/lib/mail-run");
const { POST } = await import("@/app/api/inbound/route");

const NOW = Date.parse("2026-11-12T00:00:00Z");
const order = reading({ relevance: "order", order_number: sure("TEST-1"), items: [item("テスト商品", 900)], total_amount: sure(900) });
const consent = (decision = "granted", userId = USER) => ({ user_id: userId, decision, decided_at: "2026-11-12T00:00:00Z", text_version: "v1" });
const mail = (n: number) => ({ ...mailOf("2026-11-12T00:00:00Z"), providerEmailId: `provider-${n}`, messageId: `<seam-${n}@example.test>`, from: "orders@new-shop.test", subject: "ご注文ありがとうございます", fromName: null, text: `ご注文番号 TEST-${n}`, html: null });
const claims = (db: FakeDb) => db.rpcCalls.filter((c) => /claim_claude_call/.test(c.name));

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon");
  vi.stubEnv("OTODOKE_UNREAD_USER_MAIL_LIMIT", "2");
  vi.stubEnv("OTODOKE_UNREAD_GLOBAL_MAIL_LIMIT", "100");
  vi.stubEnv("OTODOKE_UNREAD_USER_BYTE_LIMIT", "100000");
  vi.stubEnv("OTODOKE_UNREAD_GLOBAL_BYTE_LIMIT", "1000000");
  mocks.extract.mockReset().mockResolvedValue(precomputed(order));
  mocks.triage.mockReset().mockResolvedValue(true);
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("waiting for permission is part of the unread set and the storage ceiling", () => {
  for (const state of ["undecided", "declined", "unknown"] as const) {
    it(`${state}: no Claude call and no allowance; the waiting rows fill the ceiling; the third mail gets the storage notice`, async () => {
      const db = new FakeDb({ ai_reading_consents: state === "declined" ? [consent("declined")] : [] });
      if (state === "unknown") db.hooks.push((q) => (q.table === "ai_reading_consents" ? { data: null, error: { message: "offline" } } : undefined));
      const code = state === "unknown" ? "ai_consent_unknown" : "ai_consent_required";
      await expect(processInboundEmail(asAdmin(db), mail(1))).rejects.toMatchObject({ code });
      await expect(processInboundEmail(asAdmin(db), mail(2))).rejects.toMatchObject({ code });
      expect(db.rows("emails").map((r) => [r.processing_status, r.error])).toEqual([["failed", code], ["failed", code]]);
      expect(await processInboundEmail(asAdmin(db), mail(3))).toEqual({ kind: "storage_limit", limit: "user_storage_limit" });
      expect(db.rows("emails")).toHaveLength(2);
      expect(db.rows("mail_intake_notices")).toHaveLength(1);
      expect(mocks.extract).not.toHaveBeenCalled();
      expect(mocks.triage).not.toHaveBeenCalled();
      expect(claims(db)).toEqual([]);
      expect(db.rows("claude_usage_daily")).toEqual([]);
    });
  }

  it("granting lets the same rows be read, frees the ceiling, and the resent mail is accepted; withdrawing stops later mail", async () => {
    const db = new FakeDb();
    await expect(processInboundEmail(asAdmin(db), mail(1))).rejects.toBeInstanceOf(AiReadingNotAllowedError);
    await expect(processInboundEmail(asAdmin(db), mail(2))).rejects.toBeInstanceOf(AiReadingNotAllowedError);
    expect((await processInboundEmail(asAdmin(db), mail(3))).kind).toBe("storage_limit");
    const ids = db.rows("emails").map((r) => r.id);
    db.rows("ai_reading_consents").push(consent());
    expect(await runReadWaitingMail(asAdmin(db), USER)).toMatchObject({ ok: true, read: 2 });
    expect(db.rows("emails").map((r) => r.id)).toEqual(ids);
    expect(db.rows("emails").every((r) => r.processing_status === "processed")).toBe(true);
    expect(mocks.extract).toHaveBeenCalledTimes(2);
    expect((await processInboundEmail(asAdmin(db), mail(3))).kind).toBe("processed");
    expect(db.rows("emails")).toHaveLength(3);
    db.rows("ai_reading_consents")[0].decision = "declined";
    const calls = mocks.extract.mock.calls.length;
    await expect(processInboundEmail(asAdmin(db), mail(4))).rejects.toMatchObject({ code: "ai_consent_required" });
    expect(mocks.extract.mock.calls.length).toBe(calls);
  });
});

describe("the owned lease and the permission check", () => {
  it("a live first read is not taken over at 181 seconds, even after the person withdrew permission", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    let release!: (value: ReturnType<typeof precomputed>) => void;
    mocks.extract.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const db = new FakeDb({ ai_reading_consents: [consent()] });
    const first = processInboundEmail(asAdmin(db), mail(1));
    await vi.waitFor(() => expect(mocks.extract).toHaveBeenCalledTimes(1));
    const row = db.rows("emails")[0];
    const before = structuredClone(row);
    db.rows("ai_reading_consents")[0].decision = "declined";
    vi.setSystemTime(Date.parse(String(row.created_at)) + 181_000);
    await expect(processInboundEmail(asAdmin(db), mail(1))).rejects.toBeInstanceOf(MailBeingReadError);
    expect(db.rows("emails")[0]).toEqual(before);
    expect(db.callsOn("extractions", "delete")).toEqual([]);
    release(precomputed(order));
    expect((await first).kind).toBe("processed");
  });

  it("a stale run cannot write the waiting state over a row another run owns or finished", async () => {
    const db = new FakeDb({ ai_reading_consents: [consent("declined")] });
    await expect(processInboundEmail(asAdmin(db), mail(1))).rejects.toBeInstanceOf(AiReadingNotAllowedError);
    const row = db.rows("emails")[0];
    const staleRun = String(row.processing_run_id);
    // Another run takes the row over (the lease ran out) and finishes it.
    Object.assign(row, { processing_status: "processed", error: null, processing_run_id: "run-b", processing_lease_until: new Date(NOW + MAIL_LEASE_MS).toISOString() });
    const saved = structuredClone(db.tables);
    const owned = withMailRun(asAdmin(db), String(row.id), staleRun);
    await expect(requireAiReadingConsent(owned, USER, String(row.id), {})).rejects.toThrow("could not retain mail awaiting reading permission");
    expect(db.tables).toEqual(saved);
    expect(row).toMatchObject({ processing_status: "processed", error: null });
  });
});

describe("the webhook keeps both answers", () => {
  const KNOWN = "bbbbbbbbbb";
  async function post() {
    const res = await POST(new Request("https://otodoke.example.test/api/inbound", { method: "POST", body: "{}", headers: { "svix-id": "m", "svix-timestamp": "1", "svix-signature": "v1,x" } }));
    return { status: res.status, body: await res.json() };
  }
  const setup = (extra: Record<string, Record<string, unknown>[]> = {}) => {
    const db = new FakeDb({ inbox_addresses: [{ id: "i1", user_id: USER, local_part: KNOWN }], ...extra });
    mocks.db = db;
    mocks.verify = () => ({ type: "email.received", data: { email_id: "re_1" } });
    return db;
  };
  const incoming = (n: number) => ({
    id: `re_${n}`, message_id: `<route-${n}@shop.example.test>`, from: "ショップ <orders@new-shop.test>", to: [`${KNOWN}@in.example.test`],
    received_for: [`${KNOWN}@in.example.test`], subject: "ご注文ありがとうございます", text: `ご注文番号 TEST-${n}`, html: null,
    headers: { date: "Sun, 01 Nov 2026 12:00:00 +0900" }, created_at: "2026-11-05T03:00:00Z",
  });

  it("no choice yet: 200 ai_consent_required, mail kept, no Claude call", async () => {
    const db = setup();
    mocks.fetched = incoming(1);
    expect(await post()).toEqual({ status: 200, body: { ok: true, outcome: "ai_consent_required" } });
    expect(db.rows("emails")).toHaveLength(1);
    expect(mocks.extract).not.toHaveBeenCalled();
  });

  it("a failed permission lookup: 500 so the provider retries", async () => {
    const db = setup();
    db.hooks.push((q) => (q.table === "ai_reading_consents" ? { data: null, error: { message: "offline" } } : undefined));
    mocks.fetched = incoming(1);
    expect(await post()).toEqual({ status: 500, body: { error: "processing failed" } });
    expect(mocks.extract).not.toHaveBeenCalled();
  });

  it("a full unread set: 200 storage_limit and the body is not stored", async () => {
    const db = setup();
    for (const n of [1, 2]) { mocks.fetched = incoming(n); await post(); }
    mocks.fetched = incoming(3);
    expect(await post()).toEqual({ status: 200, body: { ok: true, outcome: "storage_limit" } });
    expect(db.rows("emails")).toHaveLength(2);
  });
});

describe("reading started by the grant goes through the cost guards", () => {
  const DECIDED = "2026-11-12T00:00:00.123456Z";
  const waitingRow = (n: number) => ({
    id: `w-${n}`, user_id: USER, processing_status: "failed", error: "ai_consent_required", body_state: "plain",
    provider_email_id: `provider-${n}`, message_id: `<w-${n}@example.test>`, from_address: "orders@new-shop.test", from_name: null,
    subject: "ご注文ありがとうございます", sent_at: `2026-11-01T00:00:0${n}Z`, text_body: `ご注文番号 TEST-${n}`, html_body: null, created_at: "2026-11-01T00:00:00.000000Z",
  });
  const granted = (n: number) => new FakeDb({
    ai_reading_consents: [{ ...consent("granted"), decided_at: DECIDED }],
    emails: Array.from({ length: n }, (_, i) => waitingRow(i + 1)),
  });
  const run = async (db: FakeDb) => (await import("@/lib/ai-consent-run")).runReadAfterConsent(asAdmin(db), USER, DECIDED);
  const paid = (db: FakeDb) => db.rpcCalls.filter((c) => c.name === "claim_claude_call_v2");

  it("does not read a mail twice: a repeated grant response and a later manual read claim each mail once", async () => {
    const db = granted(2);
    expect(await run(db)).toMatchObject({ ok: true, read: 2 });
    expect(await run(db)).toMatchObject({ ok: true, read: 0 });
    expect(await runReadWaitingMail(asAdmin(db), USER)).toMatchObject({ read: 0 });
    expect(mocks.extract).toHaveBeenCalledTimes(2);
    expect(paid(db)).toHaveLength(2);
    expect(db.rows("emails").every((r) => r.processing_status === "processed")).toBe(true);
  });

  it("stops at the personal allowance: the mail beyond it waits, and nothing beyond it is claimed", async () => {
    const db = granted(3);
    const day = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
    const limit = (await import("@/lib/env")).env().OTODOKE_USER_DAILY_LIMIT;
    db.rows("claude_usage_daily").push({ user_id: USER, day, calls: limit - 1 });
    expect(await run(db)).toMatchObject({ ok: true, read: 1, overLimit: true });
    expect(db.rows("emails").map((r) => r.processing_status)).toEqual(["processed", "over_limit", "failed"]);
    expect(db.rows("emails")[2].error).toBe("ai_consent_required");
    expect(mocks.extract).toHaveBeenCalledTimes(1);
  });

  it("does not read after the person withdrew: a late run for the old grant starts nothing", async () => {
    const db = granted(2);
    db.rows("ai_reading_consents")[0].decision = "declined";
    expect(await run(db)).toMatchObject({ ok: true, read: 0 });
    expect(mocks.extract).not.toHaveBeenCalled();
    expect(paid(db)).toEqual([]);
    expect(db.rows("emails").every((r) => r.processing_status === "failed")).toBe(true);
  });

  it("does not take over a mail another run is reading under a live lease", async () => {
    const db = granted(1);
    let taken = false;
    db.hooks.push((q) => {
      if (taken || q.table !== "emails" || q.op !== "select" || q.filters.length === 0) return undefined;
      taken = true;
      Object.assign(db.find("emails", "w-1")!, { processing_status: "pending", error: null, processing_run_id: "other-run", processing_lease_until: new Date(Date.now() + 360_000).toISOString() });
      return undefined;
    });
    await run(db);
    expect(taken).toBe(true);
    expect(mocks.extract).not.toHaveBeenCalled();
    expect(paid(db)).toEqual([]);
    expect(db.find("emails", "w-1")).toMatchObject({ processing_status: "pending", processing_run_id: "other-run", text_body: "ご注文番号 TEST-1" });
  });
});
