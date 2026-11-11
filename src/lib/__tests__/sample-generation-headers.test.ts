import { describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { beginSampleLoad, SAMPLE_GENERATION_HEADER, SAMPLE_USER_HEADER } from "@/lib/sample-generation-db";
import type { Database } from "@/lib/db/database.types";

const USER = "00000000-0000-4000-8000-00000000000a";
const GENERATION = "00000000-0000-4000-8000-000000000001";

describe("sample generation headers with the real Supabase SDK", () => {
  it("sends both headers on each scoped query and RPC without leaking them to the original client", async () => {
    const requests: Array<{ path: string; method: string; headers: Headers }> = [];
    const client = createClient<Database>("http://127.0.0.1:54321", "synthetic-test-key", {
      auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
      global: { fetch: async (url, init) => {
        const path = new URL(String(url)).pathname;
        requests.push({ path, method: init?.method ?? "GET", headers: new Headers(init?.headers) });
        return new Response(JSON.stringify(path.endsWith("begin_sample_load") ? GENERATION : []), { status: 200, headers: { "Content-Type": "application/json" } });
      } },
    });
    const scoped = await beginSampleLoad(client, USER);
    await Promise.all([
      scoped.from("parcels").insert({ user_id: USER, shop: "Synthetic shop" }).select("id"),
      scoped.from("parcels").update({ title: "Synthetic title" }).eq("user_id", USER),
      scoped.from("parcels").delete().eq("user_id", USER),
      scoped.from("parcels").select("id").eq("user_id", USER),
      scoped.rpc("mail_run_write", { p_email_id: USER, p_run_id: GENERATION, p_table: "parcels", p_operation: "update", p_values: {}, p_filters: [] }),
      scoped.rpc("receive_sample_parcels", { p_user_id: USER, p_parcel_ids: [], p_received_at: "2026-11-12T00:00:00Z" }),
    ]);
    expect(requests).toHaveLength(7);
    for (const request of requests.slice(1)) {
      expect(request.headers.get(SAMPLE_USER_HEADER)).toBe(USER);
      expect(request.headers.get(SAMPLE_GENERATION_HEADER)).toBe(GENERATION);
    }
    await client.from("parcels").update({ title: "Ordinary request" }).eq("user_id", USER);
    await client.rpc("begin_sample_load", { p_user_id: USER });
    for (const request of [requests[0], ...requests.slice(-2)]) {
      expect(request.headers.has(SAMPLE_USER_HEADER)).toBe(false);
      expect(request.headers.has(SAMPLE_GENERATION_HEADER)).toBe(false);
    }
  });
});
