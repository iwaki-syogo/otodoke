import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KEY_IN_USE_CHANGED, KEY_WRAP_CHANGED } from "@/lib/crypto/key-messages";
import { FRESH_AUTH_MS } from "@/lib/auth-session";

/**
 * finishReset (/reset-password) and changeLoginSecret (設定): the order of their steps, what each
 * Supabase answer becomes, and when the wrap of the key is put back.
 */

const NOW = Date.UTC(2026, 10, 6, 13, 0, 0);
const b64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const jwt = (method: string, agoMs: number, sub = "user-1") =>
  `${b64url({ alg: "ES256" })}.${b64url({ sub, amr: [{ method, timestamp: Math.floor((NOW - agoMs) / 1000) }] })}.c2ln`;

const order: string[] = [];
const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  getUser: vi.fn(),
  signIn: vi.fn(),
  updateUser: vi.fn(),
  activate: vi.fn(),
  readKey: vi.fn(),
  rewrap: vi.fn(),
  claim: vi.fn(),
  release: vi.fn(),
}));

vi.mock("next/headers", () => ({ headers: async () => new Headers({ "x-real-ip": "203.0.113.7" }) }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getSession: mocks.getSession, getUser: mocks.getUser, signInWithPassword: mocks.signIn, updateUser: mocks.updateUser } }),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ admin: true }) }));
vi.mock("@/lib/login-mail-limit", () => ({
  clientIp: () => "203.0.113.7",
  claimLoginAttempt: mocks.claim,
  releaseLoginAttempt: mocks.release,
  claimLoginMail: mocks.claim,
  releaseLoginMail: mocks.release,
}));
vi.mock("@/lib/mail-keys", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/mail-keys")>()),
  activateKey: mocks.activate,
  readStoredKey: mocks.readKey,
  rewrapKey: mocks.rewrap,
}));

const { finishReset } = await import("@/app/reset-password/actions");
const { changeLoginSecret } = await import("@/app/app/settings/password-actions");
const { changeSecret } = await import("@/lib/login-auth");

const OLD = "0".repeat(64);
const NEW = "1".repeat(64);
const KEY_ID = "a".repeat(32);
const RESET = { authSecret: NEW, keyId: KEY_ID, challenge: "Y2hhbGxlbmdl", expectedCurrentKeyId: "b".repeat(32) };
const STORED = { key_id: KEY_ID, public_key: "P".repeat(88), wrapped_private_key: "T0xEV1JBUA==", wrap_iv: "b2xkaXZvbGRpdm9s", kdf_salt: "b2xkc2FsdG9sZHNhbHQxMg==", kdf_iterations: 600_000 };
const REWRAP = { keyId: KEY_ID, previousWrappedPrivateKey: STORED.wrapped_private_key, wrappedPrivateKey: "TkVXV1JBUA==", wrapIv: "bmV3aXZuZXdpdm5l", kdfSalt: "bmV3c2FsdG5ld3NhbHQxMg==", kdfIterations: 600_000 };
const CHANGE = { currentAuthSecret: OLD, newAuthSecret: NEW, rewrap: REWRAP };

function session(method: string | null, agoMs = 60_000, email: string | null = "someone@example.com") {
  const token = method ? jwt(method, agoMs) : null;
  mocks.getSession.mockResolvedValue({ data: { session: token ? { access_token: token } : null }, error: null });
  mocks.getUser.mockResolvedValue({ data: { user: { id: "user-1", email } }, error: null });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  order.length = 0;
  for (const fn of Object.values(mocks)) fn.mockReset();
  mocks.claim.mockResolvedValue({ verdict: "ok", claimId: 9 });
  mocks.release.mockResolvedValue(undefined);
  mocks.signIn.mockImplementation(async () => (order.push("signIn"), { data: { user: { id: "user-1" }, session: {} }, error: null }));
  mocks.updateUser.mockImplementation(async () => (order.push("updateUser"), { data: { user: {} }, error: null }));
  mocks.activate.mockImplementation(async () => (order.push("activate"), { ok: true, keyId: KEY_ID }));
  mocks.readKey.mockImplementation(async () => (order.push("readKey"), { ok: true, key: STORED }));
  mocks.rewrap.mockImplementation(async () => (order.push("rewrap"), { ok: true, keyId: KEY_ID }));
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("finishReset", () => {
  it("sets the new login secret first, then puts the new key in use, on a session from a reset link", async () => {
    session("otp");
    expect(await finishReset(RESET)).toEqual({ ok: true, keyId: KEY_ID });
    expect(order).toEqual(["updateUser", "activate"]);
    expect(mocks.updateUser).toHaveBeenCalledWith({ password: NEW });
    expect(mocks.activate).toHaveBeenCalledWith({ admin: true }, "user-1", { keyId: KEY_ID, challenge: RESET.challenge, expectedCurrentKeyId: RESET.expectedCurrentKeyId });
  });

  it.each([
    ["a password session (no reset link)", "password", 60_000],
    ["a reset link opened more than 15 minutes ago", "otp", FRESH_AUTH_MS + 60_000],
  ])("refuses %s with reset_expired and changes nothing", async (_what, method, ago) => {
    session(method, ago);
    expect(await finishReset(RESET)).toEqual({ ok: false, code: "reset_expired" });
    expect(mocks.updateUser).not.toHaveBeenCalled();
    expect(mocks.activate).not.toHaveBeenCalled();
  });

  it("says signed_out without a session, network when Supabase cannot be asked", async () => {
    session(null);
    expect(await finishReset(RESET)).toEqual({ ok: false, code: "signed_out" });
    session("otp");
    mocks.getUser.mockResolvedValue({ data: { user: null }, error: { status: 502 } });
    expect(await finishReset(RESET)).toEqual({ ok: false, code: "network" });
  });

  it("goes on to the key when the secret is that one already (a retry after a lost answer)", async () => {
    session("otp");
    mocks.updateUser.mockResolvedValue({ data: { user: null }, error: { status: 422, code: "same_password" } });
    expect(await finishReset(RESET)).toEqual({ ok: true, keyId: KEY_ID });
    expect(mocks.activate).toHaveBeenCalledTimes(1);
  });

  it.each([
    [{ status: 500, code: "unexpected_failure" }, "secret_change_unknown"],
    [{ status: 0, name: "AuthRetryableFetchError" }, "secret_change_unknown"],
    [{ status: 429, code: "over_request_rate_limit" }, "rate"],
    [{ status: 400, name: "AuthSessionMissingError" }, "signed_out"],
    [{ status: 422, code: "weak_password" }, "other"],
  ] as const)("does not put the key in use when Supabase answers %j (%s)", async (error, code) => {
    session("otp");
    mocks.updateUser.mockResolvedValue({ data: { user: null }, error });
    expect(await finishReset(RESET)).toEqual({ ok: false, code });
    expect(mocks.activate).not.toHaveBeenCalled();
  });

  it("does not put the key in use when updateUser throws (unknown)", async () => {
    session("otp");
    mocks.updateUser.mockRejectedValue(new TypeError("fetch failed"));
    expect(await finishReset(RESET)).toEqual({ ok: false, code: "secret_change_unknown" });
    expect(mocks.activate).not.toHaveBeenCalled();
  });

  it.each([
    [KEY_IN_USE_CHANGED, "key_in_use_changed"],
    ["no key is waiting to be activated", "key_not_pending"],
    ["user_keys activate failed: activate_user_key: no matching key is waiting to be activated", "key_not_pending"],
    ["the key did not open its challenge", "key_challenge_failed"],
    ["user_keys lookup failed: connection reset", "key_failed"],
  ])("answers the activation's code when only the activation fails (%s)", async (error, code) => {
    session("otp");
    mocks.activate.mockResolvedValue({ ok: false, error });
    expect(await finishReset(RESET)).toEqual({ ok: false, code });
    // The new secret was set: calling again is safe (same_password, above).
    expect(mocks.updateUser).toHaveBeenCalledTimes(1);
  });

  it("refuses anything but 64 lowercase hex as the secret, and a password field", async () => {
    session("otp");
    expect(await finishReset({ ...RESET, authSecret: "Tr0ub4dor&3" })).toEqual({ ok: false, code: "invalid_input" });
    expect(await finishReset({ ...RESET, password: "x" } as never)).toEqual({ ok: false, code: "invalid_input" });
    expect(mocks.updateUser).not.toHaveBeenCalled();
  });
});

describe("changeLoginSecret", () => {
  it("checks the current secret, rewraps the key over the wrap the browser opened, then sets the new secret", async () => {
    session("password", 3 * 3_600_000);
    expect(await changeLoginSecret(CHANGE)).toEqual({ ok: true });
    expect(order).toEqual(["signIn", "readKey", "rewrap", "updateUser"]);
    // The address is the session's, never one from the input.
    expect(mocks.signIn).toHaveBeenCalledWith({ email: "someone@example.com", password: OLD, options: { captchaToken: undefined } });
    expect(mocks.rewrap).toHaveBeenCalledWith({ admin: true }, "user-1", REWRAP);
    expect(mocks.updateUser).toHaveBeenCalledWith({ password: NEW });
  });

  it("refuses the same secret as the new one, before anything", async () => {
    session("password");
    expect(await changeLoginSecret({ ...CHANGE, newAuthSecret: OLD })).toEqual({ ok: false, code: "same_secret" });
    expect(order).toEqual([]);
  });

  it("answers credentials for a wrong current secret, keeps that attempt counted, and changes nothing", async () => {
    session("password");
    mocks.signIn.mockResolvedValue({ data: { user: null, session: null }, error: { status: 400, code: "invalid_credentials" } });
    expect(await changeLoginSecret(CHANGE)).toEqual({ ok: false, code: "credentials" });
    expect(mocks.claim).toHaveBeenCalledWith("someone@example.com", "203.0.113.7");
    expect(mocks.release).not.toHaveBeenCalled();
    expect(mocks.rewrap).not.toHaveBeenCalled();
    expect(mocks.updateUser).not.toHaveBeenCalled();
  });

  it("answers rate without trying when the attempt limit is used up", async () => {
    session("password");
    mocks.claim.mockResolvedValue({ verdict: "email_10m", claimId: null });
    expect(await changeLoginSecret(CHANGE)).toEqual({ ok: false, code: "rate" });
    expect(mocks.signIn).not.toHaveBeenCalled();
  });

  it("refuses a missing rewrap while a key is in use (it would no longer open), and takes none without a key", async () => {
    session("password");
    expect(await changeLoginSecret({ ...CHANGE, rewrap: null })).toEqual({ ok: false, code: "key_in_use_changed" });
    expect(mocks.updateUser).not.toHaveBeenCalled();
    mocks.readKey.mockResolvedValue({ ok: true, key: null });
    expect(await changeLoginSecret({ ...CHANGE, rewrap: null })).toEqual({ ok: true });
  });

  it("refuses a rewrap of a wrap that is not the stored one, or of another key", async () => {
    session("password");
    expect(await changeLoginSecret({ ...CHANGE, rewrap: { ...REWRAP, previousWrappedPrivateKey: "T1RIRVI=" } })).toEqual({ ok: false, code: "key_wrap_changed" });
    expect(await changeLoginSecret({ ...CHANGE, rewrap: { ...REWRAP, keyId: "c".repeat(32) } })).toEqual({ ok: false, code: "key_not_in_use" });
    mocks.rewrap.mockResolvedValue({ ok: false, error: KEY_WRAP_CHANGED });
    expect(await changeLoginSecret(CHANGE)).toEqual({ ok: false, code: "key_wrap_changed" });
    expect(mocks.updateUser).not.toHaveBeenCalled();
  });

  it("puts the wrap back when Supabase refuses the new secret, in the same call", async () => {
    session("password");
    mocks.updateUser.mockResolvedValue({ data: { user: null }, error: { status: 422, code: "weak_password" } });
    const restore = vi.fn(async () => ({ ok: true as const, keyId: KEY_ID }));
    expect(await changeSecret(CHANGE, restore)).toEqual({ ok: false, code: "secret_change_refused" });
    expect(restore).toHaveBeenCalledWith({ admin: true }, "user-1", {
      keyId: KEY_ID,
      rewrappedPrivateKey: REWRAP.wrappedPrivateKey,
      wrappedPrivateKey: STORED.wrapped_private_key,
      wrapIv: STORED.wrap_iv,
      kdfSalt: STORED.kdf_salt,
      kdfIterations: STORED.kdf_iterations,
    });
  });

  it("says so when the wrap could not be put back", async () => {
    session("password");
    mocks.updateUser.mockResolvedValue({ data: { user: null }, error: { status: 422, code: "weak_password" } });
    const restore = vi.fn(async () => ({ ok: false as const, error: KEY_WRAP_CHANGED }));
    expect(await changeSecret(CHANGE, restore)).toEqual({ ok: false, code: "secret_change_refused_key_new" });
  });

  it("does not put the wrap back when Supabase's answer is unknown", async () => {
    session("password");
    const restore = vi.fn(async () => ({ ok: true as const, keyId: KEY_ID }));
    for (const answer of [{ data: { user: null }, error: { status: 504 } }, Promise.reject(new TypeError("fetch failed"))]) {
      mocks.updateUser.mockReturnValueOnce(answer instanceof Promise ? answer : Promise.resolve(answer));
      expect(await changeSecret(CHANGE, restore)).toEqual({ ok: false, code: "secret_change_unknown" });
    }
    expect(restore).not.toHaveBeenCalled();
  });

  it("the Action puts the wrap back through rewrapKey, over the wrap it stored only", async () => {
    session("password");
    mocks.updateUser.mockResolvedValue({ data: { user: null }, error: { status: 422, code: "weak_password" } });
    expect(await changeLoginSecret(CHANGE)).toEqual({ ok: false, code: "secret_change_refused" });
    expect(mocks.rewrap).toHaveBeenLastCalledWith({ admin: true }, "user-1", {
      keyId: KEY_ID,
      previousWrappedPrivateKey: REWRAP.wrappedPrivateKey,
      wrappedPrivateKey: STORED.wrapped_private_key,
      wrapIv: STORED.wrap_iv,
      kdfSalt: STORED.kdf_salt,
      kdfIterations: STORED.kdf_iterations,
    });
  });

  it("says signed_out without a session, and refuses a password field", async () => {
    session(null);
    expect(await changeLoginSecret(CHANGE)).toEqual({ ok: false, code: "signed_out" });
    session("password");
    expect(await changeLoginSecret({ ...CHANGE, password: "x" } as never)).toEqual({ ok: false, code: "invalid_input" });
    expect(await changeLoginSecret({ ...CHANGE, newAuthSecret: "NotHex" })).toEqual({ ok: false, code: "invalid_input" });
  });
});
