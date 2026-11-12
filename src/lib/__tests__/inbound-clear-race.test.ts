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
const { runClearAllParcels } = await import("@/lib/demo-run");
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
function fetched(local = "synthetic") { return { id: "synthetic-provider", received_for: [`${local}@in.example.test`], to: [], from: "shop@example.test", subject: "ご注文ありがとうございます", text: "ご注文を承りました。\n根拠の行\nSynthetic item", html: null, message_id: "<inbound-clear@example.test>", created_at: "2026-11-12T00:00:00Z" }; }
function request() { return new Request("https://otodoke.example.test/api/inbound", { method: "POST", body: "{}" }); }
beforeEach(() => {
  vi.stubGlobal("fetch", () => { throw new Error("external fetch is forbidden in this test"); });
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co"); vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon");
  api.extract.mockReset().mockResolvedValue(precomputed(reading({ relevance: "order", order_number: sure("ORDER-SYNTHETIC"), items: [item("Synthetic item", 1000)] })));
  api.triage.mockReset().mockResolvedValue(true); api.get.mockReset(); api.seal.mockReset();
  api.event = { type: "email.received", data: { email_id: "synthetic-provider", received_for: ["synthetic@in.example.test"] } };
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });
function database() { const db = new FakeDb({ inbox_addresses: [{ user_id: USER, local_part: "synthetic" }, { user_id: OTHER, local_part: "other" }] }); asConsentingAdmin(db); api.db = db; return db; }

describe("inbound generation begins when the owner becomes known", () => {
  it("acknowledges intentional cancellation when clear wins during receiving.get, without a retry or a paid read", async () => {
    const db = database(); const body = deferred<{ data: ReturnType<typeof fetched>; error: null }>(); api.get.mockReturnValue(body.promise);
    const pending = POST(request()); await vi.waitFor(() => expect(api.get).toHaveBeenCalledTimes(1));
    expect(await runClearAllParcels(asAdmin(db), USER)).toBeNull();
    body.resolve({ data: fetched(), error: null }); const response = await pending;
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ ok: true, outcome: "cleared" });
    expect(db.rows("emails")).toEqual([]); expect(db.rows("parcels")).toEqual([]);
    expect(api.extract).not.toHaveBeenCalled(); expect(api.triage).not.toHaveBeenCalled(); expect(api.seal).not.toHaveBeenCalled();
  });
  it("accepts a known-owner arrival started after clear", async () => {
    const db = database(); await runClearAllParcels(asAdmin(db), USER); api.get.mockResolvedValue({ data: fetched(), error: null });
    const response = await POST(request()); expect(await response.json()).toEqual({ ok: true, outcome: "processed" });
    expect(db.rows("emails")).toHaveLength(1); expect(api.extract).toHaveBeenCalledTimes(1);
  });
  it("acknowledges clear during Claude instead of retrying and recreating the reserved mail", async () => {
    const db = database(); api.get.mockResolvedValue({ data: fetched(), error: null });
    const extraction = deferred<ReturnType<typeof precomputed>>(); api.extract.mockReturnValue(extraction.promise);
    const pending = POST(request()); await vi.waitFor(() => expect(api.extract).toHaveBeenCalledTimes(1));
    expect(db.rows("emails")).toHaveLength(1); await runClearAllParcels(asAdmin(db), USER);
    extraction.resolve(precomputed(reading({ relevance: "order", order_number: sure("ORDER-SYNTHETIC"), items: [item("Synthetic item", 1000)] })));
    const response = await pending; expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, outcome: "cleared" });
    expect(db.rows("emails")).toEqual([]); expect(db.rows("parcels")).toEqual([]); expect(api.seal).not.toHaveBeenCalled();
  });
  it("uses a separately discovered fetched recipient's scope, never the announced owner's scope", async () => {
    const db = database(); const body = deferred<{ data: ReturnType<typeof fetched>; error: null }>(); api.get.mockReturnValue(body.promise);
    const pending = POST(request()); await vi.waitFor(() => expect(api.get).toHaveBeenCalledTimes(1)); await runClearAllParcels(asAdmin(db), USER);
    body.resolve({ data: fetched("other"), error: null }); const response = await pending;
    expect(await response.json()).toEqual({ ok: true, outcome: "processed" });
    expect(db.rows("emails").map((mail) => mail.user_id)).toEqual([OTHER]); expect(api.extract).toHaveBeenCalledTimes(1);
  });
  it("legacy events first know the owner after fetch and begin their scope at that discovery", async () => {
    const db = database(); api.event = { type: "email.received", data: { email_id: "synthetic-provider" } };
    const body = deferred<{ data: ReturnType<typeof fetched>; error: null }>(); api.get.mockReturnValue(body.promise);
    const pending = POST(request()); await vi.waitFor(() => expect(api.get).toHaveBeenCalledTimes(1)); await runClearAllParcels(asAdmin(db), USER);
    body.resolve({ data: fetched(), error: null }); const response = await pending;
    expect(await response.json()).toEqual({ ok: true, outcome: "processed" }); expect(api.extract).toHaveBeenCalledTimes(1);
  });
});
