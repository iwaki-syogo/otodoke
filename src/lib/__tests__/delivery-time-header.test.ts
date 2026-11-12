import { describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { withSampleGeneration, SAMPLE_GENERATION_HEADER, SAMPLE_USER_HEADER } from "@/lib/sample-generation-db";
import type { AdminClient } from "@/lib/supabase/admin";
import { USER } from "./pipeline-fixtures";

const GENERATION = "11111111-1111-4111-8111-111111111111";
const ARGS = { p_user_id: USER, p_email_id: "E", p_run_id: "R", p_columns: {}, p_expected_created_at: null, p_limits: {} };
const TIME_HEADER = "x-otodoke-delivery-created-at";

/** The real supabase-js client and PostgREST builder; the fetch only records and answers with a made-up verdict. */
function recordingClient() {
  const seen: Array<{ url: string; headers: Headers }> = [];
  const fetchStub = async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init?.headers).forEach((v, k) => headers.set(k, v));
    seen.push({ url: String(input instanceof Request ? input.url : input), headers });
    return new Response(JSON.stringify([{ verdict: "ok", email_id: "E" }]), { status: 200, headers: { "content-type": "application/json" } });
  };
  const client = createClient("https://example.supabase.co", "synthetic-key", { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: fetchStub } });
  return { seen, wrapped: withSampleGeneration(client as unknown as AdminClient, USER, GENERATION) };
}

describe("the delivery time header and the generation headers ride on one store_mail_run request", () => {
  it("all three headers are sent by the real builder through the generation proxy (the form used by the pipeline call)", async () => {
    const { seen, wrapped } = recordingClient();
    const call = wrapped.rpc("store_mail_run", ARGS);
    const result = await call.setHeader(TIME_HEADER, "2026-11-12T00:00:00.000Z");
    expect(result.error).toBeNull();
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toContain("https://example.supabase.co/rest/v1/rpc/store_mail_run");
    expect(seen[0].headers.get(TIME_HEADER)).toBe("2026-11-12T00:00:00.000Z");
    expect(seen[0].headers.get(SAMPLE_GENERATION_HEADER)).toBe(GENERATION);
    expect(seen[0].headers.get(SAMPLE_USER_HEADER)).toBe(USER);
  });
  it("without a time, the request still carries the generation headers and no time header", async () => {
    const { seen, wrapped } = recordingClient();
    await wrapped.rpc("store_mail_run", ARGS);
    expect(seen).toHaveLength(1);
    expect(seen[0].headers.has(TIME_HEADER)).toBe(false);
    expect(seen[0].headers.get(SAMPLE_GENERATION_HEADER)).toBe(GENERATION);
    expect(seen[0].headers.get(SAMPLE_USER_HEADER)).toBe(USER);
  });
});
