import { describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { beginMailGeneration, beginSampleLoad, MailGenerationExpiredError, SAMPLE_GENERATION_HEADER, SAMPLE_USER_HEADER, withSampleGeneration } from "@/lib/sample-generation-db";
import { withMailRun } from "@/lib/mail-run-db";
import type { Database } from "@/lib/db/database.types";

const USER = "00000000-0000-4000-8000-00000000000a";
const GENERATION = "00000000-0000-4000-8000-000000000001";
const NEXT = "00000000-0000-4000-8000-000000000002";

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

  it("retains the captured generation through the owned proxy and replaces a sample scope without nested header overwrite", async () => {
    const requests: Array<{ path: string; headers: Headers }> = [];
    let current = GENERATION;
    const client = createClient<Database>("http://127.0.0.1:54321", "synthetic-test-key", {
      auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
      global: { fetch: async (url, init) => {
        const path = new URL(String(url)).pathname;
        requests.push({ path, headers: new Headers(init?.headers) });
        return new Response(JSON.stringify(path.endsWith("begin_sample_load") ? current : []), { status: 200, headers: { "Content-Type": "application/json" } });
      } },
    });
    const scoped = await beginMailGeneration(client, USER);
    const owned = withMailRun(scoped, USER, GENERATION);
    current = NEXT;
    expect(await beginMailGeneration(owned, USER)).toBe(owned);
    expect(requests).toHaveLength(1);
    await owned.from("emails").update({ error: "Synthetic owned update" }).eq("id", USER);
    expect(requests.at(-1)?.headers.get(SAMPLE_GENERATION_HEADER)).toBe(GENERATION);
    const fresh = await beginMailGeneration(client, USER);
    await withSampleGeneration(fresh, USER, GENERATION).from("parcels").select("id");
    expect(requests.at(-1)?.headers.get(SAMPLE_GENERATION_HEADER)).toBe(GENERATION);
    await client.from("emails").select("id");
    expect(requests.at(-1)?.headers.has(SAMPLE_GENERATION_HEADER)).toBe(false);
    expect(requests.filter((r) => r.path.endsWith("begin_sample_load"))).toHaveLength(2);
  });

  it.each([
    { name: "confirmed missing mail and changed generation", row: null, changed: true, lookupFailed: false, compareFailed: false, cleared: true },
    { name: "another owner's existing mail", row: { user_id: "00000000-0000-4000-8000-00000000000b" }, changed: true, lookupFailed: false, compareFailed: false, cleared: false },
    { name: "same generation", row: null, changed: false, lookupFailed: false, compareFailed: false, cleared: false },
    { name: "failed mail lookup", row: null, changed: true, lookupFailed: true, compareFailed: false, cleared: false },
    { name: "failed current-generation lookup", row: null, changed: true, lookupFailed: false, compareFailed: true, cleared: false },
    { name: "unknown ownership error", row: null, changed: true, lookupFailed: false, compareFailed: false, cleared: false, failure: { code: "42501", message: "Synthetic unknown ownership error" } },
    { name: "unrecognized 55000", row: null, changed: true, lookupFailed: false, compareFailed: false, cleared: false, failure: { code: "55000", message: "Synthetic unrelated database failure" } },
  ])("classifies missing-owner SQL only with proof of clear: $name", async ({ row, changed, lookupFailed, compareFailed, cleared, failure }) => {
    let generations = 0;
    const sqlError = failure ?? { code: "55000", message: "sample generation or owner is missing" };
    const client = createClient<Database>("http://127.0.0.1:54321", "synthetic-test-key", {
      auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
      global: { fetch: async (url) => {
        const path = new URL(String(url)).pathname;
        let body: unknown = sqlError;
        let status = 400;
        if (path.endsWith("begin_sample_load")) {
          generations++;
          status = generations > 1 && compareFailed ? 500 : 200;
          body = status === 500 ? { code: "XX000", message: "Synthetic comparison failure" } : generations > 1 && changed ? NEXT : GENERATION;
        } else if (path.endsWith("/emails")) {
          status = lookupFailed ? 500 : 200;
          body = lookupFailed ? { code: "XX000", message: "Synthetic lookup failure" } : row ? [row] : [];
        }
        return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
      } },
    });
    const scoped = await beginMailGeneration(client, USER);
    const writing = scoped.rpc("mail_run_write", { p_email_id: USER, p_run_id: GENERATION, p_table: "parcels", p_operation: "insert", p_values: {}, p_filters: [] });
    if (cleared) await expect(writing).rejects.toBeInstanceOf(MailGenerationExpiredError);
    else expect((await writing).error).toMatchObject(sqlError);
  });
});
