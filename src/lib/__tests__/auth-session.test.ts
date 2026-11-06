import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { amrEntries, bearerToken, checkFresh, FRESH_AUTH_MS, isFresh, tokenClaims, type SessionRead } from "@/lib/auth-session";
import { KEY_SESSION_STALE } from "@/lib/login-errors";

/**
 * Decision 10 (with review R3-PW-2): putting a key in use or rewrapping it needs a sign-in with the
 * password in the last 15 minutes; registering one on the web takes a reset link's session too.
 * auth-session.ts reads that from the `amr` claim of an access token Supabase Auth accepted
 * (getUser(token)); the key Actions of 設定 and the iOS key API refuse any other session.
 * key-steps-need-the-password.test.ts has the sessions from a mail's token.
 */

const NOW = Date.UTC(2026, 10, 6, 13, 0, 0);
const seconds = (ms: number) => Math.floor(ms / 1000);
const b64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
/** An access token's shape (the signature is not checked here: Supabase Auth checks it). */
const jwt = (claims: Record<string, unknown>) => `${b64url({ alg: "ES256", typ: "JWT" })}.${b64url(claims)}.c2lnbmF0dXJl`;
const token = (method: string, agoMs: number, sub = "user-1") => jwt({ sub, amr: [{ method, timestamp: seconds(NOW - agoMs) }] });

describe("the amr claim", () => {
  it("reads the methods and their times (seconds → ms) from a token's payload", () => {
    const claims = tokenClaims(jwt({ sub: "user-1", amr: [{ method: "password", timestamp: 1_700_000_000 }, { method: "otp", timestamp: 1_700_000_100 }] }));
    expect(claims?.sub).toBe("user-1");
    expect(amrEntries(claims?.amr)).toEqual([
      { method: "password", at: 1_700_000_000_000 },
      { method: "otp", at: 1_700_000_100_000 },
    ]);
  });

  it("keeps the string form without a time, and leaves out what is not an entry", () => {
    expect(amrEntries(["password", { method: 7 }, null, { timestamp: 1 }, { method: "otp", timestamp: "soon" }])).toEqual([
      { method: "password", at: null },
      { method: "otp", at: null },
    ]);
    expect(amrEntries(undefined)).toEqual([]);
    expect(amrEntries("password")).toEqual([]);
  });

  it("is null for something that is not a JWT", () => {
    for (const value of ["", "a.b", "a..c", "a.!!!.c", `a.${Buffer.from("[1]").toString("base64url")}.c`, "a.b.c.d"]) expect(tokenClaims(value)).toBeNull();
  });
});

describe("fresh enough", () => {
  it.each([
    ["password", 0, true],
    ["password", FRESH_AUTH_MS, true],
    ["password", FRESH_AUTH_MS + 1000, false],
    // A mail's token (the 8-digit code, a magic link, a reset link) is not the password.
    ["otp", 60_000, false],
    ["recovery", 60_000, false],
    ["magiclink", 60_000, false],
    ["oauth", 60_000, false],
    ["token_refresh", 60_000, false],
  ] as const)("for putting a key in use: %s, %i ms ago → %s", (method, ago, fresh) => {
    expect(isFresh(amrEntries(tokenClaims(token(method, ago))?.amr), "login", NOW)).toBe(fresh);
  });

  it("for a reset, only a mail's token counts (a reset link): the password alone does not", () => {
    expect(isFresh(amrEntries([{ method: "password", timestamp: seconds(NOW) }]), "reset", NOW)).toBe(false);
    expect(isFresh(amrEntries([{ method: "otp", timestamp: seconds(NOW - 60_000) }]), "reset", NOW)).toBe(true);
    expect(isFresh(amrEntries([{ method: "recovery", timestamp: seconds(NOW - 60_000) }]), "reset", NOW)).toBe(true);
    expect(isFresh(amrEntries([{ method: "otp", timestamp: seconds(NOW - FRESH_AUTH_MS - 1000) }]), "reset", NOW)).toBe(false);
  });

  it("takes the newest entry of a method that counts, whatever the order", () => {
    const amr = amrEntries([
      { method: "otp", timestamp: seconds(NOW - 3 * 3_600_000) },
      { method: "password", timestamp: seconds(NOW - 60_000) },
    ]);
    expect(isFresh(amr, "login", NOW)).toBe(true);
    expect(isFresh(amr, "reset", NOW)).toBe(false);
  });

  it("does not count an entry without a time (the string form), nor one far in the future", () => {
    expect(isFresh(amrEntries(["password"]), "login", NOW)).toBe(false);
    expect(isFresh(amrEntries([{ method: "password", timestamp: seconds(NOW + 3_600_000) }]), "login", NOW)).toBe(false);
    // A clock a little ahead is fine.
    expect(isFresh(amrEntries([{ method: "password", timestamp: seconds(NOW + 60_000) }]), "login", NOW)).toBe(true);
  });

  it("checkFresh says why: signed out, stale, or Supabase could not be asked", () => {
    const signedIn = (amr: unknown): SessionRead => ({ state: "signed_in", session: { userId: "user-1", email: null, amr: amrEntries(amr) } });
    expect(checkFresh({ state: "signed_out" }, "login", NOW)).toEqual({ ok: false, reason: "signed_out" });
    expect(checkFresh({ state: "unknown" }, "login", NOW)).toEqual({ ok: false, reason: "unknown" });
    expect(checkFresh(signedIn([{ method: "password", timestamp: seconds(NOW - 2 * FRESH_AUTH_MS) }]), "login", NOW)).toEqual({ ok: false, reason: "stale" });
    expect(checkFresh(signedIn([{ method: "password", timestamp: seconds(NOW) }]), "login", NOW).ok).toBe(true);
    // A mail's token is "stale" too: the screen asks to log in (with the password) again.
    expect(checkFresh(signedIn([{ method: "otp", timestamp: seconds(NOW) }]), "login", NOW)).toEqual({ ok: false, reason: "stale" });
  });
});

describe("the bearer token of an iOS request", () => {
  it("takes `Bearer <JWT>` only", () => {
    const t = token("password", 0);
    expect(bearerToken(`Bearer ${t}`)).toBe(t);
    for (const value of [null, "", t, `bearer ${t}`, `Basic ${t}`, `Bearer ${t} extra`, `Bearer abc`, `Bearer ${"a".repeat(9000)}.b.c`]) expect(bearerToken(value)).toBeNull();
  });
});

// The cookie session, through the server client's getSession and getUser(token).
const auth = vi.hoisted(() => ({ getSession: vi.fn(), getUser: vi.fn() }));
const store = vi.hoisted(() => ({ register: vi.fn(), activate: vi.fn(), rewrap: vi.fn(), readKey: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth }),
  getUser: async () => ({ id: "user-1" }),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ admin: true }) }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/mail-keys", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/mail-keys")>()),
  registerKey: store.register,
  activateKey: store.activate,
  rewrapKey: store.rewrap,
  readStoredKey: store.readKey,
}));

const keys = await import("@/app/app/settings/key-actions");

const REGISTRATION = { publicKey: "AA==", wrappedPrivateKey: "AA==", wrapIv: "AA==", kdfSalt: "AA==", kdfIterations: 600_000, expectedCurrentKeyId: null };
const ACTIVATION = { keyId: "0".repeat(32), challenge: "AA==", expectedCurrentKeyId: null };
const REWRAP = { keyId: "0".repeat(32), previousWrappedPrivateKey: "AQ==", wrappedPrivateKey: "AA==", wrapIv: "AA==", kdfSalt: "AA==", kdfIterations: 600_000 };

function session(accessToken: string | null, user: { id: string } | null = { id: "user-1" }, error: { status?: number } | null = null) {
  auth.getSession.mockResolvedValue({ data: { session: accessToken ? { access_token: accessToken } : null }, error: null });
  auth.getUser.mockResolvedValue({ data: { user }, error });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  for (const fn of [auth.getSession, auth.getUser, store.register, store.activate, store.rewrap, store.readKey]) fn.mockReset();
  store.register.mockResolvedValue({ ok: true, keyId: "k", challenge: {} });
  store.activate.mockResolvedValue({ ok: true, keyId: "k" });
  store.rewrap.mockResolvedValue({ ok: true, keyId: "k" });
  store.readKey.mockResolvedValue({ ok: true, key: null });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("the key Actions of 設定 need a fresh session", () => {
  const steps = [
    ["registerMailKey", () => keys.registerMailKey(REGISTRATION), store.register],
    ["activateMailKey", () => keys.activateMailKey(ACTIVATION), store.activate],
    ["rewrapMailKey", () => keys.rewrapMailKey(REWRAP), store.rewrap],
  ] as const;

  it.each(steps)("%s goes ahead within 15 minutes of the password, for the token's own user", async (_name, run, step) => {
    const t = token("password", 5 * 60_000);
    session(t);
    expect((await run()).ok).toBe(true);
    // Supabase Auth was asked about this very token.
    expect(auth.getUser).toHaveBeenCalledWith(t);
    expect(step).toHaveBeenCalledWith({ admin: true }, "user-1", expect.any(Object));
  });

  it("within 15 minutes of a reset link, only registering goes ahead (the reset's key is put in use by finishReset)", async () => {
    session(token("otp", 60_000));
    expect((await keys.registerMailKey(REGISTRATION)).ok).toBe(true);
    expect(await keys.activateMailKey(ACTIVATION)).toEqual({ ok: false, error: KEY_SESSION_STALE });
    expect(await keys.rewrapMailKey(REWRAP)).toEqual({ ok: false, error: KEY_SESSION_STALE });
    expect(store.activate).not.toHaveBeenCalled();
    expect(store.rewrap).not.toHaveBeenCalled();
  });

  it.each(steps)("%s refuses an older session with KEY_SESSION_STALE and changes nothing", async (_name, run, step) => {
    session(token("password", FRESH_AUTH_MS + 60_000));
    expect(await run()).toEqual({ ok: false, error: KEY_SESSION_STALE });
    expect(step).not.toHaveBeenCalled();
  });

  it.each(steps)("%s says signed out without a session, or when Supabase refuses its token", async (_name, run, step) => {
    session(null);
    expect(await run()).toEqual({ ok: false, error: "ログインし直してください" });
    session(token("password", 0), null, { status: 403 });
    expect(await run()).toEqual({ ok: false, error: "ログインし直してください" });
    // A token of another user than the one Supabase answered is not this session.
    session(token("password", 0, "someone-else"));
    expect(await run()).toEqual({ ok: false, error: "ログインし直してください" });
    expect(step).not.toHaveBeenCalled();
  });

  it.each(steps)("%s does not say signed out when Supabase could not be asked", async (_name, run) => {
    session(token("password", 0), null, { status: 503 });
    expect(await run()).toEqual({ ok: false, error: "network" });
    auth.getUser.mockRejectedValue(new TypeError("fetch failed"));
    expect(await run()).toEqual({ ok: false, error: "network" });
  });

  it("negative control: the same stale session reads a key (the reads do not need a fresh one)", async () => {
    session(token("password", 24 * 3_600_000));
    expect(await keys.readMailKey({ keyId: null })).toEqual({ ok: true, key: null });
  });
});
