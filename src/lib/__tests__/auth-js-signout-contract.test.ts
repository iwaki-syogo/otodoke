import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GoTrueClient } from "@supabase/auth-js";

// Pins how the real auth-js signOut({ scope: "local" }) treats the stored
// session when the Auth server cannot be reached. No network is used.

const KEY = "sb-test-auth-token";
const HOST = "https://auth.example.invalid/";
const NOW = new Date("2026-11-13T00:00:00Z");

const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");

function seededClient(expiresInSec: number, fetchImpl: () => Promise<Response>) {
  const map = new Map<string, string>();
  const storage = {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
  const exp = Math.floor(NOW.getTime() / 1000) + expiresInSec;
  const session = {
    access_token: `${b64({ alg: "none", typ: "JWT" })}.${b64({ sub: "11111111-1111-4111-8111-111111111111", exp })}.sig`,
    refresh_token: "r",
    token_type: "bearer",
    expires_in: 3600,
    expires_at: exp,
    user: { id: "11111111-1111-4111-8111-111111111111", aud: "authenticated", role: "authenticated", app_metadata: {}, user_metadata: {}, created_at: "2026-01-01T00:00:00Z" },
  };
  const seeded = JSON.stringify(session);
  map.set(KEY, seeded);
  const fetchMock = vi.fn(async (...args: unknown[]) => { void args; return fetchImpl(); });
  const client = new GoTrueClient({
    url: `${HOST}auth/v1`,
    headers: { apikey: "test" },
    storageKey: KEY,
    storage,
    persistSession: true,
    autoRefreshToken: false,
    detectSessionInUrl: false,
    fetch: fetchMock as unknown as typeof fetch,
  });
  return { client, storage, fetchMock, seeded };
}

const networkDown = async () => { throw new TypeError("fetch failed"); };

// Runs signOut while advancing fake timers so retry backoff sleeps finish.
async function signOutLocal(client: GoTrueClient) {
  const p = client.signOut({ scope: "local" });
  await vi.runAllTimersAsync();
  return p;
}

describe("auth-js local signOut contract", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  it("valid token, network down: local session is removed", async () => {
    const { client, storage, fetchMock } = seededClient(3600, networkDown);
    await signOutLocal(client);
    expect(storage.getItem(KEY)).toBeNull();
    for (const [url] of fetchMock.mock.calls) expect(String(url).startsWith(HOST)).toBe(true);
  });

  it("valid token, server 503: local session is removed and an error is returned", async () => {
    const { client, storage, fetchMock } = seededClient(3600, async () => new Response("{}", { status: 503 }));
    const { error } = await signOutLocal(client);
    expect(error).not.toBeNull();
    expect(storage.getItem(KEY)).toBeNull();
    for (const [url] of fetchMock.mock.calls) expect(String(url).startsWith(HOST)).toBe(true);
  });

  it("valid token, server 204: local session is removed without error", async () => {
    const { client, storage, fetchMock } = seededClient(3600, async () => new Response(null, { status: 204 }));
    const { error } = await signOutLocal(client);
    expect(error).toBeNull();
    expect(storage.getItem(KEY)).toBeNull();
    expect(fetchMock).toHaveBeenCalled();
    for (const [url] of fetchMock.mock.calls) expect(String(url).startsWith(HOST)).toBe(true);
  });

  it("expired token, refresh fails on network: error returned and the session stays stored", async () => {
    const { client, storage, fetchMock, seeded } = seededClient(-3600, networkDown);
    const { error } = await signOutLocal(client);
    expect(error).not.toBeNull();
    expect(storage.getItem(KEY)).toBe(seeded);
    for (const [url] of fetchMock.mock.calls) expect(String(url).startsWith(HOST)).toBe(true);
  });
});
