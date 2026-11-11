import { createClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

/** The public SDK preserves Auth's response: app-level normalization cannot hide this endpoint. */
describe("direct Auth sign-up response boundary (local fetch only)", () => {
  const user = { id: "00000000-0000-4000-8000-00000000000a", aud: "authenticated", role: "authenticated", email: "person@example.test", app_metadata: {}, user_metadata: {}, created_at: "2026-11-01T00:00:00Z" };

  it("leaves identities visible in a successful fake-user answer", async () => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const response = vi.fn(async (_input: RequestInfo | URL) => new Response(JSON.stringify({ ...user, identities: [] }), { status: 200, headers: { "content-type": "application/json" } }));
    const client = createClient("https://auth.example.test", "made-up-anon-key", { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch: response } });
    const result = await client.auth.signUp({ email: user.email, password: "a".repeat(64) });
    expect(result.error).toBeNull();
    expect(result.data.user?.identities).toEqual([]);
    expect(response).toHaveBeenCalledTimes(1);
    expect(String(response.mock.calls[0]?.[0])).toContain("/auth/v1/signup");
  });

  it("preserves the existing-user HTTP error when Auth is configured to return it", async () => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const response = vi.fn(async (_input: RequestInfo | URL) => new Response(JSON.stringify({ code: "user_already_exists", msg: "User already registered" }), { status: 422, headers: { "content-type": "application/json", "x-supabase-api-version": "2024-01-01" } }));
    const client = createClient("https://auth.example.test", "made-up-anon-key", { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch: response } });
    const result = await client.auth.signUp({ email: user.email, password: "a".repeat(64) });
    expect(result.error).toMatchObject({ status: 422, code: "user_already_exists" });
    expect(response).toHaveBeenCalledTimes(1);
  });
});
