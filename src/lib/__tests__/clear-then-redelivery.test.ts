import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeDb } from "./fake-db";
import { OTHER, USER, asAdmin, asConsentingAdmin, item, precomputed, reading, sure } from "./pipeline-fixtures";
const api = vi.hoisted(() => ({ extract: vi.fn(), triage: vi.fn(), get: vi.fn(), seal: vi.fn(), event: {} as unknown, db: null as unknown }));
vi.mock("@/lib/extract/extract", () => ({ extractEmail: api.extract }));
vi.mock("@/lib/extract/triage", () => ({ isPurchaseMail: api.triage }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => api.db }));
vi.mock("@/lib/seal-later", () => ({ scheduleSealRemaining: api.seal }));
vi.mock("resend", () => ({ Resend: class { webhooks = { verify: () => api.event }; emails = { receiving: { get: api.get } }; } }));
vi.mock("@/lib/env", async (original) => ({ ...(await original<typeof import("@/lib/env")>()), requireEnv: (name: string) => ({ RESEND_API_KEY: "synthetic", RESEND_WEBHOOK_SECRET: "synthetic", INBOUND_DOMAIN: "in.example.test" } as Record<string, string>)[name] }));
const { POST } = await import("@/app/api/inbound/route");
const { runClearAllParcels, runLoadDemo } = await import("@/lib/demo-run");
const { processInboundEmail } = await import("@/lib/pipeline");

type Mail = { id: string; message_id: string | null; order: string; local?: string; created?: () => string | undefined; eventCreated?: string };
/** Before any clear in a test (the real clock is later than this). */
const LONG_AGO = () => "2000-01-01T00:00:00Z";
function fetched(m: Mail) { return { id: m.id, received_for: [`${m.local ?? "synthetic"}@in.example.test`], to: [], from: "shop@example.test", subject: "ご注文ありがとうございます", text: `ご注文を承りました。\n根拠の行\nSynthetic item ${m.order}`, html: null, ...(m.message_id ? { message_id: m.message_id } : {}), created_at: (m.created ?? LONG_AGO)() }; }
const request = () => new Request("https://otodoke.example.test/api/inbound", { method: "POST", body: "{}" });
const readingOf = (order: string) => precomputed(reading({ relevance: "order", order_number: sure(order), items: [item("Synthetic item", 1000)] }));
const mails = new Map<string, Mail>();
/** One webhook delivery of provider mail `id`; the mail body is looked up from what the test registered. */
async function deliver(id: string) {
  const m = mails.get(id)!;
  api.event = { type: "email.received", data: { email_id: id, received_for: [`${m.local ?? "synthetic"}@in.example.test`], ...(m.eventCreated ? { created_at: m.eventCreated } : {}) } };
  const response = await POST(request());
  return { status: response.status, body: (await response.json()) as { outcome?: string } };
}
function mail(id: string, message_id: string | null, order = "ORDER-SYNTHETIC", local?: string, extra: Partial<Mail> = {}): Mail { const m = { id, message_id, order, local, ...extra }; mails.set(id, m); return m; }
const warned = (text: string) => vi.mocked(console.warn).mock.calls.filter((c) => c[0] === text).length;
const UNKNOWN = "inbound: delivery time unknown; message-id mark not applied";
const DIFFERS = "inbound: delivery time differs between event and API";
const claims = (db: FakeDb) => db.rpcCalls.filter((c) => /claim_claude_call/.test(c.name)).length;
const clear = async (db: FakeDb) => expect(await runClearAllParcels(asAdmin(db), USER)).toBeNull();

beforeEach(() => {
  mails.clear();
  vi.stubGlobal("fetch", () => { throw new Error("external fetch is forbidden in this test"); });
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co"); vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon");
  api.extract.mockReset().mockImplementation(async (input: { text?: string | null }) => readingOf(/ORDER-[A-Z0-9-]+/.exec(String(input?.text ?? JSON.stringify(input)))?.[0] ?? "ORDER-SYNTHETIC"));
  api.triage.mockReset().mockResolvedValue(true); api.seal.mockReset();
  api.get.mockReset().mockImplementation(async (id: string) => ({ data: fetched(mails.get(id)!), error: null }));
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });
function database() { const db = new FakeDb({ inbox_addresses: [{ user_id: USER, local_part: "synthetic" }, { user_id: OTHER, local_part: "other" }] }); asConsentingAdmin(db); api.db = db; return db; }

/** The state after a redelivery that follows a clear: nothing rebuilt, nothing paid for, and still a 200. */
function expectNothingRebuilt(db: FakeDb, before: { extract: number; triage: number; claims: number }, r: { status: number; body: { outcome?: string } }) {
  expect(r.status).toBe(200);
  expect(r.body.outcome).not.toBe("processed");
  expect(db.rows("emails")).toEqual([]); expect(db.rows("parcels")).toEqual([]);
  expect(api.extract.mock.calls.length - before.extract).toBe(0);
  expect(api.triage.mock.calls.length - before.triage).toBe(0);
  expect(claims(db) - before.claims).toBe(0);
  expect.hasAssertions();
}
const snapshot = (db: FakeDb) => ({ extract: api.extract.mock.calls.length, triage: api.triage.mock.calls.length, claims: claims(db) });
const M = "<redelivery@example.test>";

describe("a redelivery of a mail the person cleared must not rebuild it", () => {
  it("R1: the same event again after the clear (natural resend / replay)", async () => {
    const db = database(); mail("P", M);
    expect((await deliver("P")).body.outcome).toBe("processed");
    expect(claims(db)).toBeGreaterThan(0); // the counter really sees a paid read
    await clear(db); const before = snapshot(db);
    expectNothingRebuilt(db, before, await deliver("P"));
  });
  it("R2: a delivery that failed with 500 after it was stored, resent after the clear", async () => {
    const db = database(); mail("P", M);
    api.extract.mockRejectedValueOnce(new Error("synthetic transient failure"));
    expect((await deliver("P")).status).toBe(500);
    await clear(db); const before = snapshot(db);
    expectNothingRebuilt(db, before, await deliver("P"));
  });
  it("R3: a mail with no Message-ID", async () => {
    const db = database(); mail("P", null);
    expect((await deliver("P")).body.outcome).toBe("processed");
    await clear(db); const before = snapshot(db);
    expectNothingRebuilt(db, before, await deliver("P"));
  });
  it("R4: an alias that took over a kept row (P1 failed, P2 took over), then P1 resent after the clear", async () => {
    const db = database(); mail("P1", M); mail("P2", M);
    api.extract.mockRejectedValueOnce(new Error("synthetic transient failure"));
    expect((await deliver("P1")).status).toBe(500);
    expect((await deliver("P2")).body.outcome).toBe("processed");
    expect(db.rows("emails").map((r) => r.provider_email_id)).toEqual(["P2"]);
    await clear(db); const before = snapshot(db);
    expectNothingRebuilt(db, before, await deliver("P1"));
  });
  it("R5: an alias answered as duplicate (P1 processed, P2 duplicate), then P2 resent after the clear", async () => {
    const db = database(); mail("P1", M); mail("P2", M);
    expect((await deliver("P1")).body.outcome).toBe("processed");
    expect((await deliver("P2")).body.outcome).toBe("duplicate");
    await clear(db); const before = snapshot(db);
    expectNothingRebuilt(db, before, await deliver("P2"));
  });
  it("R6: two clears, each followed by a resend", async () => {
    const db = database(); mail("P", M);
    expect((await deliver("P")).body.outcome).toBe("processed");
    await clear(db); const before = snapshot(db);
    expectNothingRebuilt(db, before, await deliver("P"));
    await clear(db);
    expectNothingRebuilt(db, before, await deliver("P"));
  });
});

describe("a cleared delivery that meets a row kept after the clear does not take it over (A27-2)", () => {
  /** P read, cleared; the person forwards the same mail again (F, after the clear) and its read fails: one failed row F stays. */
  async function failedForwardAfterClear() {
    const db = database(); mail("P", M);
    expect((await deliver("P")).body.outcome).toBe("processed");
    await clear(db);
    mail("F", M, "ORDER-SYNTHETIC", undefined, { created: () => new Date(Date.now() + 60_000).toISOString() });
    api.extract.mockRejectedValueOnce(new Error("synthetic transient failure"));
    expect((await deliver("F")).status).toBe(500);
    const kept = structuredClone(db.rows("emails"));
    expect(kept.map((r) => [r.provider_email_id, r.processing_status])).toEqual([["F", "failed"]]);
    return { db, kept };
  }
  it("R7: the cleared delivery P resent after that is a duplicate: F's row (content, version, state) and the costs stay as they were", async () => {
    const { db, kept } = await failedForwardAfterClear();
    const before = snapshot(db);
    const r = await deliver("P");
    expect(r.status).toBe(200);
    expect(r.body.outcome).toBe("duplicate");
    expect(db.rows("emails")).toEqual(kept);
    expect(db.rows("parcels")).toEqual([]);
    expect(api.extract.mock.calls.length - before.extract).toBe(0);
    expect(api.triage.mock.calls.length - before.triage).toBe(0);
    expect(claims(db) - before.claims).toBe(0);
  });
  it("R7: F's own resend (its provider ID has no mark) still reads the kept row", async () => {
    const { db } = await failedForwardAfterClear();
    expect((await deliver("P")).body.outcome).toBe("duplicate");
    expect((await deliver("F")).body.outcome).toBe("processed");
    expect(db.rows("emails").map((r) => [r.provider_email_id, r.processing_status])).toEqual([["F", "processed"]]);
  });
  it("R7: reading the kept row again from its stored copy (as 設定 and the backlog do) still goes through", async () => {
    const { db } = await failedForwardAfterClear();
    expect((await deliver("P")).body.outcome).toBe("duplicate");
    const row = db.rows("emails")[0];
    const outcome = await processInboundEmail(asAdmin(db), {
      userId: USER, providerEmailId: row.provider_email_id as string, messageId: row.message_id as string, from: String(row.from_address ?? ""),
      fromName: (row.from_name as string | null) ?? null, subject: String(row.subject ?? ""), sentAt: (row.sent_at as string | null) ?? null,
      text: (row.text_body as string | null) ?? null, html: (row.html_body as string | null) ?? null,
    }, { replacesEmailId: String(row.id), replacesCreatedAt: String(row.created_at) });
    expect(outcome.kind).toBe("processed");
  });
});

describe("legitimate input after a clear still goes through", () => {
  it("L1: a new mail from the same shop", async () => {
    const db = database(); mail("P", M); await deliver("P"); await clear(db);
    mail("N", "<new@example.test>", "ORDER-NEW");
    expect((await deliver("N")).body.outcome).toBe("processed"); expect(db.rows("emails")).toHaveLength(1);
  });
  it("L2: a later shipping mail of the same order number (new provider id, new Message-ID)", async () => {
    const db = database(); mail("P", M); await deliver("P"); await clear(db);
    mail("S", "<shipped@example.test>");
    expect((await deliver("S")).body.outcome).toBe("processed");
  });
  it("L3: a delivery never stored before the clear, with a Message-ID no cleared mail had, goes through", async () => {
    const db = database(); mail("P", M); await deliver("P"); await clear(db);
    mail("Q", "<never-seen@example.test>", "ORDER-Q");
    expect((await deliver("Q")).body.outcome).toBe("processed");
  });
  it("L3 limit (accepted, A27-4): a delivery never stored, but with a cleared mail's Message-ID and created before the clear, is a duplicate", async () => {
    const db = database(); mail("P", M); await deliver("P");
    // Q reached the provider 10 minutes before the clear, but Otodoke first hears of it after the clear.
    mail("Q", M, "ORDER-SYNTHETIC", undefined, { created: () => new Date(Date.now() - 600_000).toISOString() });
    await clear(db); const before = snapshot(db);
    expectNothingRebuilt(db, before, await deliver("Q"));
  });
  it("L4: a new mail with no Message-ID", async () => {
    const db = database(); mail("P", M); await deliver("P"); await clear(db);
    mail("N", null, "ORDER-NOID");
    expect((await deliver("N")).body.outcome).toBe("processed");
  });
  it("L5: the same Message-ID delivered to another person is processed for that person", async () => {
    const db = database(); mail("P", M); await deliver("P"); await clear(db);
    mail("O", M, "ORDER-OTHER", "other");
    expect((await deliver("O")).body.outcome).toBe("processed");
    expect(db.rows("emails").map((r) => r.user_id)).toEqual([OTHER]);
  });
  it("L6: loading the sample again after a clear succeeds", async () => {
    const db = database(); mail("P", M); await deliver("P"); await clear(db);
    expect((await runLoadDemo(() => asAdmin(db), USER)).ok).toBe(true);
  });
  it("a person forwarding the same mail by hand after a clear (new provider id, same Message-ID, delivery created after the clear) is processed", async () => {
    const db = database(); mail("P", M); await deliver("P"); await clear(db);
    mail("F", M, "ORDER-SYNTHETIC", undefined, { created: () => new Date(Date.now() + 60_000).toISOString() });
    expect((await deliver("F")).body.outcome).toBe("processed"); expect(db.rows("emails")).toHaveLength(1);
    expect(warned(UNKNOWN)).toBe(0);
  });
  it("the same Message-ID with a new provider id and no delivery time from the API is processed, with one 'time unknown' warning", async () => {
    const db = database(); mail("P", M); await deliver("P"); await clear(db);
    mail("F", M, "ORDER-SYNTHETIC", undefined, { created: () => undefined });
    expect((await deliver("F")).body.outcome).toBe("processed");
    expect(warned(UNKNOWN)).toBe(1);
  });
  it("known remaining risk: an alias created 60 seconds before the clear (inside the 120 second margin) is processed", async () => {
    const db = database(); mail("P", M); await deliver("P"); await clear(db);
    mail("A", M, "ORDER-SYNTHETIC", undefined, { created: () => new Date(Date.now() - 60_000).toISOString() });
    expect((await deliver("A")).body.outcome).toBe("processed");
  });
  it("an alias created well before the clear (beyond the margin) is stopped", async () => {
    const db = database(); mail("P", M); await deliver("P"); await clear(db);
    mail("A", M, "ORDER-SYNTHETIC", undefined, { created: () => new Date(Date.now() - 600_000).toISOString() });
    const before = snapshot(db);
    expectNothingRebuilt(db, before, await deliver("A"));
  });
  it("an event time that differs from the API time is warned once, and the API time decides", async () => {
    const db = database(); mail("P", M); await deliver("P"); await clear(db);
    // API says long ago (stopped); the event claims a time after the clear (would pass).
    mail("A", M, "ORDER-SYNTHETIC", undefined, { eventCreated: new Date(Date.now() + 600_000).toISOString() });
    const before = snapshot(db);
    expectNothingRebuilt(db, before, await deliver("A"));
    expect(warned(DIFFERS)).toBe(1); expect(warned(UNKNOWN)).toBe(0);
  });
  it("an event time that agrees with the API time (different spelling) does not warn", async () => {
    const db = database(); mail("P", M); await deliver("P"); await clear(db);
    mail("A", M, "ORDER-SYNTHETIC", undefined, { created: () => "2000-01-01T00:00:00Z", eventCreated: "2000-01-01T00:00:00.000+00:00" });
    await deliver("A");
    expect(warned(DIFFERS)).toBe(0);
  });
  it("marks older than 35 days no longer stop a resend", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const db = database(); mail("P", M); await deliver("P"); await clear(db);
    vi.setSystemTime(Date.now() + 36 * 86_400_000);
    expect((await deliver("P")).body.outcome).toBe("processed");
  });
  it("marks younger than 35 days still stop a resend", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const db = database(); mail("P", M); await deliver("P"); await clear(db);
    vi.setSystemTime(Date.now() + 34 * 86_400_000);
    const before = snapshot(db);
    expectNothingRebuilt(db, before, await deliver("P"));
  });
});

describe("the Route passes on only an exact delivery instant (A27-5)", () => {
  // The clear happens at 20:00Z; every forward below has a new provider ID and the cleared Message-ID.
  const CLEAR_AT = "2026-11-12T20:00:00Z";
  async function clearedAt() {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(CLEAR_AT));
    const db = database(); mail("P", M); await deliver("P"); await clear(db);
    return db;
  }
  for (const [label, value] of [
    ["a date with no time", "2026-11-12"],
    ["a time with no zone", "2026-11-12T00:00:00"],
    ["a day that does not exist", "2026-02-30T00:00:00Z"],
  ] as const) {
    it(`${label} (${value}) is an unknown time: the forward goes through, with one 'time unknown' warning`, async () => {
      const db = await clearedAt();
      mail("F", M, "ORDER-SYNTHETIC", undefined, { created: () => value });
      expect((await deliver("F")).body.outcome).toBe("processed");
      expect(db.rows("emails")).toHaveLength(1);
      expect(warned(UNKNOWN)).toBe(1);
    });
  }
  it("an exact instant with an offset before the clear is still read (stopped), and one after it goes through, with no warning", async () => {
    const db = await clearedAt();
    mail("A", M, "ORDER-SYNTHETIC", undefined, { created: () => "2026-11-13T04:00:00+09:00" }); // 19:00Z
    const before = snapshot(db);
    expectNothingRebuilt(db, before, await deliver("A"));
    mail("F", M, "ORDER-SYNTHETIC", undefined, { created: () => "2026-11-12T20:30:00.123456+00:00" });
    expect((await deliver("F")).body.outcome).toBe("processed");
    expect(warned(UNKNOWN)).toBe(0);
  });
});
