import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@/lib/db/database.types";
import { markReceivedInChunks } from "@/lib/receipt-client";
import { runUndo } from "@/lib/undo-outcome";

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => state.db }));
const { markDeliveredForUndo, restoreStatuses } = await import("@/app/app/parcel-actions");

const USER = "00000000-0000-4000-8000-00000000000a";
const AT = "2026-11-12T10:00:00.123456+09:00";
const BYTE_BUDGET = 8192;
const MAX_BATCH = 200;
const HOSTS = {
  standard: "abcdefghijklmnopqrst.supabase.co",
  // Maximum DNS name length, valid individual labels, and a maximum-width port.
  long: `${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(61)}:65535`,
};
type Captured = { method: string; url: string; body: Record<string, unknown> | null };
const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const idsOf = (n: number) => Array.from({ length: n }, (_, index) => uuid(index + 1));
const receiptOf = (id: string) => ({ id, receipt_id: `00000000-0000-4000-a000-${id.slice(-12)}`,
  received_at: AT, updated_at: AT, previous_status: "shipped", previous_received_at: null });

function arrayIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((id) => typeof id !== "string")) throw new Error("expected an id array");
  return value as string[];
}

function setup(host: string): { db: SupabaseClient<Database>; requests: Captured[] } {
  const requests: Captured[] = [];
  const localFetch: typeof fetch = vi.fn(async (input, init) => {
    const request = new Request(input, init);
    const raw = await request.text();
    const body = raw ? JSON.parse(raw) as Record<string, unknown> : null;
    requests.push({ method: request.method, url: request.url, body });
    const url = new URL(request.url);
    let rows: unknown[];
    if (url.pathname.endsWith("/rpc/mark_parcels_received")) {
      rows = arrayIds(body?.p_ids).map((id) => ({ ...receiptOf(id), outcome: "written" }));
    } else if (url.pathname.endsWith("/rpc/restore_parcel_receipts")) {
      if (!Array.isArray(body?.p_receipts)) throw new Error("expected receipt keys in the JSON body");
      rows = body.p_receipts.map((item: { id: string }) => ({ id: item.id, outcome: "restored" }));
    } else if (url.pathname.endsWith("/parcels") && request.method === "PATCH") {
      // The deliberately reintroduced old transport is accepted by this local server too:
      // failure must come from the transport assertions, not an unrelated fake-server error.
      const filter = url.searchParams.get("id") ?? "";
      const ids = filter.startsWith("in.(") && filter.endsWith(")") ? filter.slice(4, -1).split(",") : [];
      rows = ids.map((id) => ({ ...receiptOf(id), outcome: "written" }));
    } else {
      throw new Error(`unexpected local SDK request: ${request.method} ${url.pathname}`);
    }
    return new Response(JSON.stringify(rows), { status: 200, headers: { "Content-Type": "application/json" } });
  });
  const db = createClient<Database>(`https://${host}`, "synthetic-anon-key", {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
    global: { fetch: localFetch },
  });
  // Only identity is substituted. RPC URL building, serialization, HTTP method,
  // response decoding and the production actions/chunk helpers remain real.
  vi.spyOn(db.auth, "getUser").mockResolvedValue({ data: { user: {
    id: USER, app_metadata: {}, user_metadata: {}, aud: "authenticated", created_at: AT,
  } }, error: null });
  state.db = db;

  if (process.env.RECEIPT_TRANSPORT_NEGATIVE === "legacy-patch") {
    const rpc = db.rpc.bind(db);
    Object.defineProperty(db, "rpc", { value: (name: string, args: Record<string, unknown>) => {
      if (name === "mark_parcels_received") {
        return db.from("parcels").update({ status: "delivered", received_at: AT })
          .in("id", arrayIds(args.p_ids)).eq("user_id", USER).neq("status", "cancelled").is("received_at", null).select("id");
      }
      return rpc(name as "restore_parcel_receipts", args as Database["public"]["Functions"]["restore_parcel_receipts"]["Args"]);
    } });
  }
  return { db, requests };
}

function assertRPCTransport(requests: Captured[], ids: string[], rpc: "mark_parcels_received" | "restore_parcel_receipts") {
  const batches: string[][] = [];
  for (const request of requests) {
    const url = new URL(request.url);
    // The inequality reads the URL actually emitted by the installed SDK, including
    // host, port, path and encoded query. IDs belong to the POST body, never the URL.
    expect(Buffer.byteLength(request.url, "utf8")).toBeLessThan(BYTE_BUDGET);
    expect(request.method).toBe("POST");
    expect(url.pathname).toBe(`/rest/v1/rpc/${rpc}`);
    expect(url.search).toBe("");
    expect(request.body).not.toBeNull();
    const batch = rpc === "mark_parcels_received" ? arrayIds(request.body?.p_ids)
      : (request.body?.p_receipts as { id: string }[]).map((item) => item.id);
    expect(batch.length).toBeGreaterThan(0);
    expect(batch.length).toBeLessThanOrEqual(MAX_BATCH);
    batches.push(batch);
  }
  expect(batches.flat()).toEqual(ids);
  expect(batches.map((batch) => batch.length)).toEqual(Array.from({ length: Math.ceil(ids.length / MAX_BATCH) }, (_, index) => Math.min(MAX_BATCH, ids.length - index * MAX_BATCH)));
  expect(new Set(batches.flat()).size).toBe(ids.length);
}

beforeEach(() => {
  state.db = null;
  // No real network fetch is available: only the specific client's local custom fetch can run.
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("external fetch is forbidden in receipt transport tests"); }));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("receipt transport uses bounded POST bodies through the real Supabase SDK", () => {
  for (const [name, host] of Object.entries(HOSTS)) {
    for (const count of [200, 501, 1001]) {
      it(`${name} host: marks and restores every one of ${count} ids, including the final partial batch`, async () => {
        const { requests } = setup(host);
        const ids = idsOf(count);
        const marked = await markReceivedInChunks(ids, markDeliveredForUndo);
        expect(marked.saved).toBe(count);
        expect(marked.written.map((item) => item.id)).toEqual(ids);
        assertRPCTransport(requests, ids, "mark_parcels_received");
        expect(requests.every((request) => Buffer.byteLength(request.url, "utf8") < 1024)).toBe(true);
        const markCount = requests.length;
        const restored = await runUndo(restoreStatuses, marked.written.map(({ id, receipt_id }) => ({ id, receipt_id })));
        expect(restored).toEqual({ restored: ids, changed: [], failed: [] });
        assertRPCTransport(requests.slice(markCount), ids, "restore_parcel_receipts");
        expect(vi.mocked(globalThis.fetch)).not.toHaveBeenCalled();
      });
    }
  }

  it("negative control: the old real-SDK 500-id PATCH exceeds the byte budget and is rejected by the oracle", async () => {
    const { db, requests } = setup(HOSTS.standard);
    await db.from("parcels").update({ status: "delivered", received_at: AT }).in("id", idsOf(500))
      .eq("user_id", USER).neq("status", "cancelled").is("received_at", null).select("id");
    expect(requests).toHaveLength(1);
    expect(requests[0].method).toBe("PATCH");
    expect(Buffer.byteLength(requests[0].url, "utf8")).toBe(19665);
    expect(Buffer.byteLength(requests[0].url, "utf8")).toBeGreaterThanOrEqual(BYTE_BUDGET);
    expect(() => assertRPCTransport(requests, idsOf(500), "mark_parcels_received")).toThrow();
    expect(vi.mocked(globalThis.fetch)).not.toHaveBeenCalled();
  });

  it("negative control: 200 UUIDs are not a universal safe bound for an encoded undo filter", async () => {
    const { db, requests } = setup(HOSTS.long);
    await db.from("parcels").update({ status: "shipped", received_at: null }).in("id", idsOf(200))
      .eq("user_id", USER).eq("status", "delivered").eq("received_at", AT).select("id");
    expect(requests).toHaveLength(1);
    expect(Buffer.byteLength(requests[0].url, "utf8")).toBeGreaterThanOrEqual(BYTE_BUDGET);
    expect(() => assertRPCTransport(requests, idsOf(200), "restore_parcel_receipts")).toThrow();
  });
});
