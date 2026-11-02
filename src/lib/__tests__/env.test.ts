import { afterEach, describe, expect, it, vi } from "vitest";

const required = {
  NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon",
};

async function loadEnv(values: Record<string, string>) {
  vi.resetModules();
  for (const [key, value] of Object.entries({ ...required, ...values })) vi.stubEnv(key, value);
  return (await import("../env")).env;
}

describe("env", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("treats a blank optional key as not configured", async () => {
    const env = await loadEnv({ RESEND_API_KEY: "", INBOUND_DOMAIN: "" });
    expect(env().RESEND_API_KEY).toBeUndefined();
    expect(env().INBOUND_DOMAIN).toBeUndefined();
  });

  it("still rejects a blank required key", async () => {
    const env = await loadEnv({ NEXT_PUBLIC_SUPABASE_ANON_KEY: "" });
    expect(() => env()).toThrow("NEXT_PUBLIC_SUPABASE_ANON_KEY");
  });
});
