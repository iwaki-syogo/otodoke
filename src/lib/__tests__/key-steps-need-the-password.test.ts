import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { amrEntries, FRESH_AUTH_MS, isFresh, type Freshness } from "@/lib/auth-session";
import { KEY_SESSION_STALE } from "@/lib/login-errors";

/**
 * Review R3-PW-2: Supabase's verify records `otp` in `amr` for every mail token it accepts, so a
 * session from the 8-digit code (still on for the iOS app's second build) or a magic link looks
 * like one from a reset link. Whoever reads the mailbox could then, within 15 minutes, put a new
 * key in use (retiring the user's) or store a wrap that opens with nothing, without changing the
 * password: the mail sealed to the user's key would never open again.
 *
 * Decision 10, as it stands now:
 * - putting a key in use and wrapping it again (the web's activateMailKey, rewrapMailKey), and
 *   every step of the iOS key API: a sign-in with the password in the last 15 minutes, only;
 * - registering a key on the web (registerMailKey): that, or a reset link's session, because the
 *   reset registers the key for the new password before finishReset puts it in use;
 * - finishReset: a reset link's session, and it puts the key in use itself (not through activateMailKey).
 */

const NOW = Date.UTC(2026, 10, 6, 13, 0, 0);
const MINUTE = 60_000;
const seconds = (ms: number) => Math.floor(ms / 1000);
const b64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
/** An access token of `sub`, signed in with `method` `agoMs` ago (Supabase Auth checks the signature: stubbed). */
const jwt = (method: string, agoMs: number, sub = "user-1") => `${b64url({ alg: "ES256" })}.${b64url({ sub, amr: [{ method, timestamp: seconds(NOW - agoMs) }] })}.c2ln`;

const MAILBOX = ["otp", "recovery", "magiclink"] as const;

describe("what each need counts (auth-session.ts isFresh)", () => {
  const fresh = (method: string, agoMs: number, need: Freshness) => isFresh(amrEntries([{ method, timestamp: seconds(NOW - agoMs) }]), need, NOW);

  it.each([
    // method, ago, login, login_or_reset, reset
    ["password", MINUTE, true, true, false],
    ["password", FRESH_AUTH_MS, true, true, false],
    ["password", FRESH_AUTH_MS + 1000, false, false, false],
    ["otp", MINUTE, false, true, true],
    ["recovery", MINUTE, false, true, true],
    ["magiclink", MINUTE, false, true, true],
    ["otp", FRESH_AUTH_MS + 1000, false, false, false],
    ["oauth", MINUTE, false, false, false],
    ["token_refresh", MINUTE, false, false, false],
  ] as const)("%s %i ms ago: login %s, login_or_reset %s, reset %s", (method, ago, login, loginOrReset, reset) => {
    expect(fresh(method, ago, "login")).toBe(login);
    expect(fresh(method, ago, "login_or_reset")).toBe(loginOrReset);
    expect(fresh(method, ago, "reset")).toBe(reset);
  });

  it("a fresh mail token next to an old password sign-in is not the password", () => {
    const amr = amrEntries([
      { method: "password", timestamp: seconds(NOW - 3 * 3_600_000) },
      { method: "otp", timestamp: seconds(NOW - MINUTE) },
    ]);
    expect(isFresh(amr, "login", NOW)).toBe(false);
    expect(isFresh(amr, "login_or_reset", NOW)).toBe(true);
  });
});

// ---- The web: the key Actions of 設定, and finishReset ------------------------------------------

const auth = vi.hoisted(() => ({ getSession: vi.fn(), getUser: vi.fn(), updateUser: vi.fn(), bearerUser: vi.fn() }));
const store = vi.hoisted(() => ({ register: vi.fn(), activate: vi.fn(), rewrap: vi.fn(), restore: vi.fn(), readKey: vi.fn() }));
vi.mock("@/lib/crypto/reset-key-check", () => ({ checkResetKey: async () => ({ ok: true, keyId: "a".repeat(32) }) }));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ "x-real-ip": "203.0.113.7" }) }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getSession: auth.getSession, getUser: auth.getUser, updateUser: auth.updateUser } }),
  getUser: async () => ({ id: "user-1" }),
}));
// The Bearer check of the iOS key API (auth-session.ts readBearerSession).
vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({ auth: { getUser: auth.bearerUser } }) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ admin: true }) }));
vi.mock("@/lib/mail-keys", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/mail-keys")>()),
  registerKey: store.register,
  activateKey: store.activate,
  rewrapKey: store.rewrap,
  restoreKeyWrap: store.restore,
  readStoredKey: store.readKey,
}));

const keys = await import("@/app/app/settings/key-actions");
const { finishReset } = await import("@/app/reset-password/actions");
const routes = {
  register: await import("@/app/api/keys/register/route"),
  activate: await import("@/app/api/keys/activate/route"),
  rewrap: await import("@/app/api/keys/rewrap/route"),
  restore: await import("@/app/api/keys/restore/route"),
};

const KEY_ID = "a".repeat(32);
const b64 = (n: number, first = 1) => Buffer.from(Uint8Array.from({ length: n }, (_, i) => (i === 0 ? first : (i * 7) % 256))).toString("base64");
const REGISTRATION = { publicKey: b64(65, 4), wrappedPrivateKey: b64(154), wrapIv: b64(12), kdfSalt: b64(16), kdfIterations: 600_000, expectedCurrentKeyId: null };
const ACTIVATION = { keyId: KEY_ID, challenge: b64(32), expectedCurrentKeyId: null };
const REWRAP = { keyId: KEY_ID, previousWrappedPrivateKey: b64(154, 2), wrappedPrivateKey: b64(154, 3), wrapIv: b64(12), kdfSalt: b64(16), kdfIterations: 600_000 };
const RESTORE = { keyId: KEY_ID, rewrappedPrivateKey: b64(154, 3), wrappedPrivateKey: b64(154, 2), wrapIv: b64(12), kdfSalt: b64(16), kdfIterations: 600_000 };
const NEW_SECRET = "1".repeat(64);

/** This browser's cookie session: an access token of user-1 signed in with `method` `agoMs` ago. */
function cookieSession(method: string, agoMs = MINUTE) {
  auth.getSession.mockResolvedValue({ data: { session: { access_token: jwt(method, agoMs) } }, error: null });
  auth.getUser.mockResolvedValue({ data: { user: { id: "user-1", email: "someone@example.com" } }, error: null });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon");
  for (const fn of [...Object.values(auth), ...Object.values(store)]) fn.mockReset();
  store.register.mockResolvedValue({ ok: true, keyId: KEY_ID, challenge: { v: 1, kid: KEY_ID } });
  store.activate.mockResolvedValue({ ok: true, keyId: KEY_ID });
  store.rewrap.mockResolvedValue({ ok: true, keyId: KEY_ID });
  store.restore.mockResolvedValue({ ok: true, keyId: KEY_ID });
  store.readKey.mockResolvedValue({ ok: true, key: null });
  auth.updateUser.mockResolvedValue({ data: { user: {} }, error: null });
  auth.bearerUser.mockResolvedValue({ data: { user: { id: "user-1" } }, error: null });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("the web's key Actions (key-actions.ts)", () => {
  it.each(MAILBOX)("a session from a mail's token (%s, a minute old): putting a key in use and rewrapping are refused, nothing changes", async (method) => {
    cookieSession(method);
    expect(await keys.activateMailKey(ACTIVATION, "user-1")).toEqual({ ok: false, error: KEY_SESSION_STALE });
    expect(await keys.rewrapMailKey(REWRAP, "user-1")).toEqual({ ok: false, error: KEY_SESSION_STALE });
    expect(store.activate).not.toHaveBeenCalled();
    expect(store.rewrap).not.toHaveBeenCalled();
  });

  it.each(MAILBOX)("control: the same session (%s) registers a key (the reset page does), and reads", async (method) => {
    cookieSession(method);
    expect(await keys.registerMailKey(REGISTRATION, "user-1")).toMatchObject({ ok: true, keyId: KEY_ID });
    expect(store.register).toHaveBeenCalledWith({ admin: true }, "user-1", REGISTRATION);
    expect(await keys.readMailKey({ keyId: null }, "user-1")).toEqual({ ok: true, key: null });
  });

  it("a password sign-in of the last 15 minutes does all three: the first key after the login, and 「ほかのパスワードで開く」", async () => {
    cookieSession("password", 14 * MINUTE);
    expect((await keys.registerMailKey(REGISTRATION, "user-1")).ok).toBe(true);
    expect((await keys.activateMailKey(ACTIVATION, "user-1")).ok).toBe(true);
    expect((await keys.rewrapMailKey(REWRAP, "user-1")).ok).toBe(true);
    expect(store.register).toHaveBeenCalledTimes(1);
    expect(store.activate).toHaveBeenCalledTimes(1);
    expect(store.rewrap).toHaveBeenCalledTimes(1);
  });

  it("a password sign-in more than 15 minutes ago, or a reset link more than 15 minutes ago, does none", async () => {
    for (const method of ["password", "otp"]) {
      cookieSession(method, FRESH_AUTH_MS + MINUTE);
      expect(await keys.registerMailKey(REGISTRATION, "user-1")).toEqual({ ok: false, error: KEY_SESSION_STALE });
      expect(await keys.activateMailKey(ACTIVATION, "user-1")).toEqual({ ok: false, error: KEY_SESSION_STALE });
      expect(await keys.rewrapMailKey(REWRAP, "user-1")).toEqual({ ok: false, error: KEY_SESSION_STALE });
    }
    expect(store.register).not.toHaveBeenCalled();
  });
});

describe("the reset puts its key in use through finishReset, not activateMailKey", () => {
  const RESET = { expectedUserId: "user-1", expectedEmailNorm: "someone@example.com", authSecret: NEW_SECRET, keyId: KEY_ID, challenge: b64(32), expectedCurrentKeyId: null };

  it.each(MAILBOX)("on a reset link's session (%s): the key is registered, then finishReset sets the secret and puts the key in use", async (method) => {
    cookieSession(method);
    expect((await keys.registerMailKey(REGISTRATION, "user-1")).ok).toBe(true);
    expect(await finishReset(RESET)).toEqual({ ok: true, keyId: KEY_ID });
    expect(auth.updateUser).toHaveBeenCalledWith({ password: NEW_SECRET });
    expect(store.activate).toHaveBeenCalledWith({ admin: true }, "user-1", { keyId: KEY_ID, challenge: RESET.challenge, expectedCurrentKeyId: null });
    // The same session cannot put a key in use without the new password (the hole of R3-PW-2).
    store.activate.mockClear();
    expect(await keys.activateMailKey(ACTIVATION, "user-1")).toEqual({ ok: false, error: KEY_SESSION_STALE });
    expect(store.activate).not.toHaveBeenCalled();
  });

  it("negative control: a password session does not finish a reset", async () => {
    cookieSession("password");
    expect(await finishReset(RESET)).toEqual({ ok: false, code: "reset_expired" });
    expect(auth.updateUser).not.toHaveBeenCalled();
    expect(store.activate).not.toHaveBeenCalled();
  });
});

// ---- The iOS key API -----------------------------------------------------------------------------

type Step = keyof typeof routes;
const STEPS = Object.keys(routes) as Step[];
const BODIES: Record<Step, unknown> = { register: REGISTRATION, activate: ACTIVATION, rewrap: REWRAP, restore: RESTORE };
const STORE: Record<Step, ReturnType<typeof vi.fn>> = { register: store.register, activate: store.activate, rewrap: store.rewrap, restore: store.restore };

async function call(step: Step, token: string) {
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const res = await routes[step].POST(new Request(`https://otodoke.app/api/keys/${step}`, { method: "POST", headers, body: JSON.stringify(BODIES[step]) }));
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

describe("the iOS key API (src/app/api/keys/**): the password only, for every step", () => {
  it.each(STEPS.flatMap((step) => MAILBOX.map((method) => [step, method] as const)))("%s with a session from %s, a minute old: 403 stale_session, nothing changes", async (step, method) => {
    expect(await call(step, jwt(method, MINUTE))).toEqual({ status: 403, json: { ok: false, code: "stale_session" } });
    expect(STORE[step]).not.toHaveBeenCalled();
    // Supabase Auth did accept the token: the refusal is the method, not a signed-out session.
    expect(auth.bearerUser).toHaveBeenCalledTimes(1);
  });

  it.each(STEPS)("%s with a password sign-in a minute ago goes ahead (control)", async (step) => {
    expect(await call(step, jwt("password", MINUTE))).toMatchObject({ status: 200, json: { ok: true } });
    expect(STORE[step]).toHaveBeenCalledWith({ admin: true }, "user-1", BODIES[step]);
  });
});
