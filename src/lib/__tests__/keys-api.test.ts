import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KEY_IN_USE_CHANGED, KEY_WRAP_CHANGED } from "@/lib/crypto/key-messages";
import { FRESH_AUTH_MS } from "@/lib/auth-session";

/**
 * The iOS app's key API (src/app/api/keys/**, decision 13): a Bearer token checked by Supabase
 * Auth, the same 15 minutes as the web, strict bodies, and fixed codes for the answers of
 * src/lib/mail-keys.ts. docs/api/keys.md describes the same.
 */

const NOW = Date.UTC(2026, 10, 6, 13, 0, 0);
const b64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const jwt = (method: string, agoMs: number, sub = "user-1") =>
  `${b64url({ alg: "ES256" })}.${b64url({ sub, amr: [{ method, timestamp: Math.floor((NOW - agoMs) / 1000) }] })}.c2ln`;

const mocks = vi.hoisted(() => ({ getUser: vi.fn(), register: vi.fn(), activate: vi.fn(), rewrap: vi.fn() }));

vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({ auth: { getUser: mocks.getUser } }) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ admin: true }) }));
vi.mock("@/lib/mail-keys", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/mail-keys")>()),
  registerKey: mocks.register,
  activateKey: mocks.activate,
  rewrapKey: mocks.rewrap,
}));

const routes = {
  register: await import("@/app/api/keys/register/route"),
  activate: await import("@/app/api/keys/activate/route"),
  rewrap: await import("@/app/api/keys/rewrap/route"),
  restore: await import("@/app/api/keys/restore/route"),
};

const KEY_ID = "a".repeat(32);
const BODIES = {
  register: { publicKey: "AA==", wrappedPrivateKey: "AA==", wrapIv: "AA==", kdfSalt: "AA==", kdfIterations: 600_000, expectedCurrentKeyId: null },
  activate: { keyId: KEY_ID, challenge: "AA==", expectedCurrentKeyId: null },
  rewrap: { keyId: KEY_ID, previousWrappedPrivateKey: "T0xE", wrappedPrivateKey: "TkVX", wrapIv: "AA==", kdfSalt: "AA==", kdfIterations: 600_000 },
  restore: { keyId: KEY_ID, rewrappedPrivateKey: "TkVX", wrappedPrivateKey: "T0xE", wrapIv: "AA==", kdfSalt: "AA==", kdfIterations: 600_000 },
};
type Step = keyof typeof routes;
const STEPS = Object.keys(routes) as Step[];

async function call(step: Step, { token, body = BODIES[step], raw }: { token?: string | null; body?: unknown; raw?: string } = {}) {
  const headers = new Headers({ "content-type": "application/json" });
  const bearer = token === undefined ? jwt("password", 60_000) : token;
  if (bearer !== null) headers.set("authorization", `Bearer ${bearer}`);
  const res = await routes[step].POST(new Request(`https://otodoke.app/api/keys/${step}`, { method: "POST", headers, body: raw ?? JSON.stringify(body) }));
  return { status: res.status, json: (await res.json()) as Record<string, unknown>, cache: res.headers.get("cache-control") };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon");
  for (const fn of Object.values(mocks)) fn.mockReset();
  mocks.getUser.mockResolvedValue({ data: { user: { id: "user-1" } }, error: null });
  mocks.register.mockResolvedValue({ ok: true, keyId: KEY_ID, challenge: { v: 1, kid: KEY_ID } });
  mocks.activate.mockResolvedValue({ ok: true, keyId: KEY_ID });
  mocks.rewrap.mockResolvedValue({ ok: true, keyId: KEY_ID });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("who may call", () => {
  it.each(STEPS)("%s: 401 without a Bearer token, or with one that is not a JWT", async (step) => {
    for (const token of [null, "", "not-a-jwt", "a.b"]) {
      expect(await call(step, { token })).toMatchObject({ status: 401, json: { ok: false, code: "unauthorized" } });
    }
    expect(mocks.getUser).not.toHaveBeenCalled();
  });

  it.each(STEPS)("%s: 401 when Supabase Auth refuses the token (a forged or signed-out one)", async (step) => {
    mocks.getUser.mockResolvedValue({ data: { user: null }, error: { status: 403, code: "bad_jwt" } });
    expect(await call(step)).toMatchObject({ status: 401, json: { ok: false, code: "unauthorized" } });
    // A token whose subject is not the user Supabase answered is not that user's.
    mocks.getUser.mockResolvedValue({ data: { user: { id: "someone-else" } }, error: null });
    expect(await call(step)).toMatchObject({ status: 401 });
    expect(mocks.register).not.toHaveBeenCalled();
  });

  it("asks Supabase Auth about the very token sent", async () => {
    const token = jwt("password", 1000);
    await call("register", { token });
    expect(mocks.getUser).toHaveBeenCalledWith(token);
  });

  it.each(STEPS)("%s: 403 stale_session more than 15 minutes after the password, and nothing changes", async (step) => {
    expect(await call(step, { token: jwt("password", FRESH_AUTH_MS + 60_000) })).toMatchObject({ status: 403, json: { ok: false, code: "stale_session" } });
    for (const fn of [mocks.register, mocks.activate, mocks.rewrap]) expect(fn).not.toHaveBeenCalled();
  });

  it("503 unavailable, not 401, when Supabase Auth cannot be asked", async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null }, error: { status: 0, name: "AuthRetryableFetchError" } });
    expect(await call("register")).toMatchObject({ status: 503, json: { ok: false, code: "unavailable" } });
    mocks.getUser.mockRejectedValue(new TypeError("fetch failed"));
    expect(await call("register")).toMatchObject({ status: 503 });
  });
});

describe("what it does", () => {
  it("register: the mail-keys step with the token's user, and its answer as JSON", async () => {
    expect(await call("register")).toEqual({ status: 200, json: { ok: true, keyId: KEY_ID, challenge: { v: 1, kid: KEY_ID } }, cache: "no-store" });
    expect(mocks.register).toHaveBeenCalledWith({ admin: true }, "user-1", BODIES.register);
  });

  it("activate and rewrap: the same steps as the web", async () => {
    expect(await call("activate")).toMatchObject({ status: 200, json: { ok: true, keyId: KEY_ID } });
    expect(mocks.activate).toHaveBeenCalledWith({ admin: true }, "user-1", BODIES.activate);
    expect(await call("rewrap")).toMatchObject({ status: 200, json: { ok: true, keyId: KEY_ID } });
    expect(mocks.rewrap).toHaveBeenCalledWith({ admin: true }, "user-1", BODIES.rewrap);
  });

  it("restore: puts back the wrap from before, only over the wrap the rewrap stored", async () => {
    expect(await call("restore")).toMatchObject({ status: 200, json: { ok: true, keyId: KEY_ID } });
    expect(mocks.rewrap).toHaveBeenCalledWith({ admin: true }, "user-1", {
      keyId: KEY_ID,
      previousWrappedPrivateKey: BODIES.restore.rewrappedPrivateKey,
      wrappedPrivateKey: BODIES.restore.wrappedPrivateKey,
      wrapIv: BODIES.restore.wrapIv,
      kdfSalt: BODIES.restore.kdfSalt,
      kdfIterations: BODIES.restore.kdfIterations,
    });
  });

  it.each(STEPS)("%s: 400 for a body that is not JSON, too long, or has a field it does not take", async (step) => {
    expect(await call(step, { raw: "{not json" })).toMatchObject({ status: 400, json: { ok: false, code: "invalid_input" } });
    expect(await call(step, { raw: JSON.stringify({ ...BODIES[step], pad: "x".repeat(20_000) }) })).toMatchObject({ status: 400 });
    // The user comes from the token, never from the body; and no secret is taken.
    for (const extra of [{ userId: "someone-else" }, { password: "x" }, { passphrase: "x" }, { authSecret: "0".repeat(64) }]) {
      expect(await call(step, { body: { ...BODIES[step], ...extra } })).toMatchObject({ status: 400, json: { code: "invalid_input" } });
    }
    for (const fn of [mocks.register, mocks.activate, mocks.rewrap]) expect(fn).not.toHaveBeenCalled();
  });

  it.each([
    ["activate", KEY_IN_USE_CHANGED, 409, "key_in_use_changed"],
    ["activate", "user_keys activate failed: activate_user_key: no matching key is waiting to be activated", 409, "key_not_pending"],
    ["activate", "no key is waiting to be activated", 409, "key_not_pending"],
    ["activate", "the key did not open its challenge", 422, "key_challenge_failed"],
    ["register", KEY_IN_USE_CHANGED, 409, "key_in_use_changed"],
    ["register", "wrap iv must be 12 bytes", 400, "invalid_input"],
    ["rewrap", KEY_WRAP_CHANGED, 409, "key_wrap_changed"],
    ["rewrap", "no key in use with this id", 409, "key_not_in_use"],
    ["rewrap", "user_keys update failed: deadlock detected (row (a, b, c))", 500, "key_failed"],
  ] as const)("%s refused with %s: %i %s, and the text is not passed on", async (step, error, status, code) => {
    const fn = step === "activate" ? mocks.activate : step === "register" ? mocks.register : mocks.rewrap;
    fn.mockResolvedValue({ ok: false, error });
    const res = await call(step);
    expect(res).toMatchObject({ status, json: { ok: false, code } });
    expect(JSON.stringify(res.json)).not.toContain(error);
  });

  it("500 key_failed when a step throws", async () => {
    mocks.register.mockRejectedValue(new Error("boom"));
    expect(await call("register")).toMatchObject({ status: 500, json: { ok: false, code: "key_failed" } });
  });

  it("answers POST only: no other method is exported (Next.js answers 405)", () => {
    for (const step of STEPS) expect(Object.keys(routes[step]).sort()).toEqual(["POST"]);
  });
});
