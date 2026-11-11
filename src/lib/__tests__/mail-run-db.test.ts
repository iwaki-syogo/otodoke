import { createClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@/lib/db/database.types";
import { withMailRun } from "@/lib/mail-run-db";

const EMAIL = "00000000-0000-4000-8000-000000000001";
const RUN = "00000000-0000-4000-8000-000000000002";
const USER = "00000000-0000-4000-8000-000000000003";
const PARCEL = "00000000-0000-4000-8000-000000000004";

type SentRequest = { path: string; method: string; body: unknown; search: URLSearchParams };
type Reply = { body: unknown; status?: number; headers?: Record<string, string> };

/** Use the installed Supabase transport; the only fetch records and answers locally. */
function transport(...replies: Reply[]) {
  const sent: SentRequest[] = [];
  const db = createClient<Database>("https://transport.example.test", "synthetic-service-key", {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      fetch: async (input, init) => {
        const request = new Request(input, init);
        const url = new URL(request.url);
        sent.push({
          path: url.pathname,
          method: request.method,
          body: ["GET", "HEAD"].includes(request.method) ? null : await request.json(),
          search: url.searchParams,
        });
        const reply = replies.shift();
        if (!reply) throw new Error("unexpected extra request");
        return new Response(request.method === "HEAD" ? null : JSON.stringify(reply.body), {
          status: reply.status ?? 200,
          headers: { "Content-Type": "application/json", ...reply.headers },
        });
      },
    },
  });
  return { db, owned: withMailRun(db, EMAIL, RUN), sent };
}

function expectOwnedPost(sent: SentRequest[], table: string, operation: string, values: unknown, filters: unknown[] = []) {
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({
    path: "/rest/v1/rpc/mail_run_write", method: "POST",
    body: { p_email_id: EMAIL, p_run_id: RUN, p_table: table, p_operation: operation, p_values: values, p_filters: filters },
  });
  // A source-table write would evade the owner check even if an RPC was also sent.
  expect(sent.some((request) => !request.path.includes("/rpc/") && ["POST", "PATCH", "DELETE"].includes(request.method))).toBe(false);
}

beforeEach(() => {
  vi.stubGlobal("fetch", () => { throw new Error("all transport must use the local custom fetch"); });
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("mail-run ownership adapter over the real Supabase transport", () => {
  it("insert + select + single sends its values through the owned RPC and returns one row", async () => {
    const { owned, sent } = transport({ body: [{ id: PARCEL }] });
    const values = { user_id: USER, shop: "テスト店", title: "テストの荷物", source: "mail" };
    const result = await owned.from("parcels").insert(values).select("id").single();
    expect(result).toMatchObject({ data: { id: PARCEL }, error: null });
    expectOwnedPost(sent, "parcels", "insert", values);
  });

  it("update + eq/in/or + select + maybeSingle preserves each filter in the RPC JSON", async () => {
    const { owned, sent } = transport({ body: [{ id: PARCEL }] });
    const values = { total_amount: 900 };
    const result = await owned.from("parcels").update(values)
      .eq("user_id", USER).in("id", [PARCEL]).or("source.neq.manual,total_amount.is.null")
      .select("id").maybeSingle();
    expect(result).toMatchObject({ data: { id: PARCEL }, error: null });
    expectOwnedPost(sent, "parcels", "update", values, [
      { method: "eq", args: ["user_id", USER] },
      { method: "in", args: ["id", [PARCEL]] },
      { method: "or", args: ["source.neq.manual,total_amount.is.null"] },
    ]);
  });

  it("delete + select returns an array through the RPC without a source-table DELETE", async () => {
    const { owned, sent } = transport({ body: [{ id: EMAIL }] });
    const result = await owned.from("extractions").delete().eq("email_id", EMAIL).select("id");
    expect(result).toMatchObject({ data: [{ id: EMAIL }], error: null });
    expectOwnedPost(sent, "extractions", "delete", null, [{ method: "eq", args: ["email_id", EMAIL] }]);
  });

  it("a mutation without select returns no data even when the RPC returns changed rows", async () => {
    const { owned, sent } = transport({ body: [{ id: EMAIL }] });
    const result = await owned.from("emails").update({ processing_status: "failed" }).eq("id", EMAIL);
    expect(result).toMatchObject({ data: null, error: null });
    expectOwnedPost(sent, "emails", "update", { processing_status: "failed" }, [{ method: "eq", args: ["id", EMAIL] }]);
  });

  it("a parcel-item batch preserves the value array and uses one owned POST", async () => {
    const { owned, sent } = transport({ body: [{ id: "item-a" }, { id: "item-b" }] });
    const values = [
      { user_id: USER, parcel_id: PARCEL, name: "テスト商品A" },
      { user_id: USER, parcel_id: PARCEL, name: "テスト商品B" },
    ];
    const result = await owned.from("parcel_items").insert(values);
    expect(result).toMatchObject({ data: null, error: null });
    expectOwnedPost(sent, "parcel_items", "insert", values);
  });

  it.each(["single", "maybeSingle"] as const)("%s gives the expected cardinality result for zero owned rows", async (singularity) => {
    const { owned, sent } = transport({ body: [] });
    const query = owned.from("emails").update({ processing_status: "failed" }).eq("id", EMAIL).select("id");
    const result = await query[singularity]();
    expect(result.data).toBeNull();
    if (singularity === "single") expect(result.error?.code).toBe("PGRST116");
    else expect(result.error).toBeNull();
    expectOwnedPost(sent, "emails", "update", { processing_status: "failed" }, [{ method: "eq", args: ["id", EMAIL] }]);
  });

  it("maybeSingle rejects multiple rows, matching the installed SDK instead of hiding an ambiguous update", async () => {
    const rows = [{ id: EMAIL }, { id: PARCEL }];
    const { db, owned, sent } = transport({ body: rows }, { body: rows });
    const native = await db.from("emails").select("id").maybeSingle();
    expect(native.error?.code).toBe("PGRST116");
    const result = await owned.from("emails").update({ processing_status: "failed" }).eq("user_id", USER).select("id").maybeSingle();
    expect(sent[1].path).toBe("/rest/v1/rpc/mail_run_write");
    expect(result.data).toBeNull();
    expect(result.error?.code).toBe(native.error?.code);
  });

  it("an RPC rejection remains an error and is not converted to an empty successful write", async () => {
    const error = { code: "42501", message: "mail run no longer owns this mail", details: null, hint: null };
    const { owned, sent } = transport({ body: error, status: 403 });
    const result = await owned.from("emails").update({ processing_status: "processed" }).eq("id", EMAIL).select("id").maybeSingle();
    expect(result).toMatchObject({ data: null, error });
    expectOwnedPost(sent, "emails", "update", { processing_status: "processed" }, [{ method: "eq", args: ["id", EMAIL] }]);
  });

  it.each([
    ["claim_claude_call", "ok"],
    ["claim_claude_call_v2", [{ verdict: "ok", claim_id: 7 }]],
  ] as const)("%s uses the owned RPC and preserves the original return shape", async (name, response) => {
    const { owned, sent } = transport({ body: response });
    const args = { p_user_id: USER, p_user_limit: 30, p_global_limit: 300 };
    const result = await owned.rpc(name, args);
    expect(result.data).toEqual(response);
    expect(result.error).toBeNull();
    expectOwnedPost(sent, name, "claim", args);
  });

  it("reads use the ordinary table endpoint with their original filters and single-row shape", async () => {
    const { owned, sent } = transport({ body: [{ id: EMAIL }] });
    const result = await owned.from("emails").select("id").eq("user_id", USER).in("id", [EMAIL]).maybeSingle();
    expect(result).toMatchObject({ data: { id: EMAIL }, error: null, status: 200 });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ path: "/rest/v1/emails", method: "GET", body: null });
    expect(sent[0].search.get("select")).toBe("id");
    expect(sent[0].search.get("user_id")).toBe(`eq.${USER}`);
    expect(sent[0].search.get("id")).toBe(`in.(${EMAIL})`);
  });

  it("a HEAD count remains an ordinary read and preserves the transport's count", async () => {
    const { owned, sent } = transport({ body: null, headers: { "Content-Range": "0-1/2" } });
    const result = await owned.from("parcel_items").select("id", { count: "exact", head: true }).eq("parcel_id", PARCEL);
    expect(result).toMatchObject({ data: null, count: 2, error: null, status: 200 });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ path: "/rest/v1/parcel_items", method: "HEAD", body: null });
    expect(sent[0].search.get("parcel_id")).toBe(`eq.${PARCEL}`);
  });

  it("release passes through to its original RPC without being fenced as a new claim", async () => {
    const { owned, sent } = transport({ body: 1 });
    const args = { p_claim_id: 7, p_user_id: USER };
    const result = await owned.rpc("release_claude_call", args);
    expect(result).toMatchObject({ data: 1, error: null });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ path: "/rest/v1/rpc/release_claude_call", method: "POST", body: args });
  });

  const version = "2026-11-12T01:00:00.123456+09:00";
  const items = [{ name: "テスト商品", quantity: 2, unit_price: 900, evidence: "テスト商品 2点" }];
  const filingRpcs = [
    {
      name: "create_mail_parcel" as const,
      args: {
        p_snapshot: [{ id: PARCEL, updated_at: version, item_names: ["テスト商品"] }],
        p_values: { user_id: USER, shop: "テスト店", title: "テスト商品", total_amount: 1800, received_at: null },
        p_items: items,
      },
      ok: [{ verdict: "ok", parcel_id: PARCEL }],
      retry: [{ verdict: "retry", parcel_id: null }],
    },
    {
      name: "ensure_mail_parcel_items" as const,
      args: { p_parcel_id: PARCEL, p_expected_updated_at: version, p_items: items },
      ok: [{ verdict: "ok" }],
      retry: [{ verdict: "retry" }],
    },
    {
      name: "update_mail_parcel" as const,
      args: {
        p_snapshot: [{ id: PARCEL, updated_at: version, item_names: ["テスト商品"] }],
        p_parcel_id: PARCEL,
        p_expected_updated_at: version,
        p_values: { status: "delivered", total_amount: 0, expected_date: null },
        p_category: { category: "other", category_source: "auto" },
        p_items: items,
      },
      ok: [{ verdict: "ok", parcel_id: PARCEL, parcel_row: { id: PARCEL, status: "delivered", total_amount: 0, expected_date: null } }],
      retry: [{ verdict: "retry", parcel_id: null, parcel_row: null }],
    },
  ];

  for (const rpc of filingRpcs) {
    it.each(["ok", "retry", "denied"] as const)(`${rpc.name} preserves filing arguments and %s while the run context wins`, async (outcome) => {
      const error = { code: "42501", message: "mail run no longer owns this mail", details: null, hint: null };
      const response = outcome === "denied" ? error : rpc[outcome];
      const { owned, sent } = transport({ body: response, status: outcome === "denied" ? 403 : 200 });
      // A caller-supplied identity cannot replace the context this adapter was created with.
      const args = { ...rpc.args, p_email_id: USER, p_run_id: PARCEL };
      const before = JSON.stringify(args);
      const result = await owned.rpc(rpc.name, args);
      expect(JSON.stringify(args)).toBe(before);
      expect(sent).toHaveLength(1);
      expect(sent[0].path).toBe(`/rest/v1/rpc/${rpc.name}`);
      expect(sent[0].method).toBe("POST");
      expect(sent[0].body).toEqual({ ...rpc.args, p_email_id: EMAIL, p_run_id: RUN });
      expect(sent.some((request) => !request.path.includes("/rpc/"))).toBe(false);
      if (outcome === "denied") expect(result).toMatchObject({ data: null, error, status: 403 });
      else expect(result).toMatchObject({ data: response, error: null, status: 200 });
    });
  }
});
