import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getUser: vi.fn(), signIn: vi.fn(), updateUser: vi.fn(), read: vi.fn(), rewrap: vi.fn(), restore: vi.fn(), claim: vi.fn(), release: vi.fn(), cookie: vi.fn(), calls: [] as string[] }));
vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({ auth: { getUser: mocks.getUser, signInWithPassword: mocks.signIn, updateUser: mocks.updateUser } }) }));
vi.mock("@/lib/supabase/server", () => ({ createClient: mocks.cookie }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ admin: true }) }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/seal-later", () => ({ scheduleSealRemaining: vi.fn() }));
vi.mock("@/lib/login-mail-limit", () => ({ clientIp: () => null, claimLoginTry: async () => "ok", claimLoginAttempt: mocks.claim, releaseLoginAttempt: mocks.release, claimLoginMail: vi.fn(), releaseLoginMail: vi.fn() }));
vi.mock("@/lib/mail-keys", async (actual) => ({ ...await actual<typeof import("@/lib/mail-keys")>(), readStoredKey: mocks.read, rewrapKey: mocks.rewrap, restoreKeyWrap: mocks.restore }));
const { POST } = await import("@/app/api/account/password/route");
const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const TOKEN = `${b64({ alg: "ES256" })}.${b64({ sub: "owner", amr: [{ method: "otp", timestamp: 1 }] })}.c2ln`;
const OLD = "0".repeat(64), NEW = "1".repeat(64), KEY = "a".repeat(32);
const STORED = { key_id: KEY, wrapped_private_key: Buffer.alloc(154, 1).toString("base64"), wrap_iv: Buffer.alloc(12, 2).toString("base64"), kdf_salt: Buffer.alloc(16, 3).toString("base64"), kdf_iterations: 600000 };
const WRAP = { keyId: KEY, previousWrappedPrivateKey: STORED.wrapped_private_key, wrappedPrivateKey: Buffer.alloc(154, 4).toString("base64"), wrapIv: Buffer.alloc(12, 5).toString("base64"), kdfSalt: Buffer.alloc(16, 6).toString("base64"), kdfIterations: 600000 };
const INPUT = { currentAuthSecret: OLD, newAuthSecret: NEW, rewrap: WRAP, captchaToken: "test-captcha" };
async function call(input: unknown = INPUT, bearer: string | null = TOKEN) {
  const headers = new Headers({ "content-type": "application/json" });
  if (bearer !== null) headers.set("authorization", `Bearer ${bearer}`);
  const res = await POST(new Request("https://otodoke.app/api/account/password", { method: "POST", headers, body: JSON.stringify(input) }));
  return { status: res.status, json: await res.json(), cache: res.headers.get("cache-control") };
}
beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co"); vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon");
  for (const value of Object.values(mocks)) if (typeof value === "function") value.mockReset();
  mocks.calls.length = 0;
  mocks.getUser.mockResolvedValue({ data: { user: { id: "owner", email: "sample@example.invalid" } }, error: null });
  mocks.signIn.mockImplementation(async () => { mocks.calls.push("signIn"); return { data: { user: { id: "owner" } }, error: null }; });
  mocks.read.mockImplementation(async () => { mocks.calls.push("read"); return { ok: true, key: STORED }; });
  mocks.rewrap.mockImplementation(async () => { mocks.calls.push("rewrap"); return { ok: true, keyId: KEY }; });
  mocks.updateUser.mockImplementation(async () => { mocks.calls.push("update"); return { error: null }; });
  mocks.restore.mockImplementation(async () => { mocks.calls.push("restore"); return { ok: true, keyId: KEY }; });
  mocks.claim.mockResolvedValue({ verdict: "ok", claimId: 7 }); mocks.release.mockResolvedValue(undefined);
  mocks.cookie.mockRejectedValue(new Error("cookie client must not be used"));
  vi.spyOn(console, "warn").mockImplementation(() => {}); vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("native login-secret change uses the Web transaction steps", () => {
  it("checks the Bearer owner then current secret, rewraps the same key, then sets the new secret without cookies", async () => {
    expect(await call()).toEqual({ status: 200, json: { ok: true }, cache: "no-store" });
    expect(mocks.calls).toEqual(["signIn", "read", "rewrap", "update"]);
    expect(mocks.signIn).toHaveBeenCalledWith({ email: "sample@example.invalid", password: OLD, options: { captchaToken: "test-captcha" } });
    expect(mocks.rewrap).toHaveBeenCalledWith({ admin: true }, "owner", WRAP);
    expect(mocks.updateUser).toHaveBeenCalledWith({ password: NEW });
    expect(mocks.cookie).not.toHaveBeenCalled();
  });
  it("restores the original wrap on a confirmed Auth refusal", async () => {
    mocks.updateUser.mockImplementation(async () => { mocks.calls.push("update"); return { error: { status: 422, code: "weak_password" } }; });
    expect((await call()).json).toEqual({ ok: false, code: "secret_change_refused" });
    expect(mocks.calls).toEqual(["signIn", "read", "rewrap", "update", "restore"]);
    expect(mocks.restore.mock.calls[0][2]).toMatchObject({ keyId: KEY, rewrappedPrivateKey: WRAP.wrappedPrivateKey, wrappedPrivateKey: STORED.wrapped_private_key });
  });
  it("keeps the new wrap when the Auth response is uncertain", async () => {
    mocks.updateUser.mockRejectedValue(new TypeError("lost response"));
    expect((await call()).json).toEqual({ ok: false, code: "secret_change_unknown" });
    expect(mocks.restore).not.toHaveBeenCalled(); expect(mocks.updateUser).toHaveBeenCalledTimes(1);
  });
  it("a wrong current secret, CAPTCHA or attempt limit never changes the key", async () => {
    mocks.signIn.mockResolvedValue({ data: { user: null }, error: { status: 400, code: "invalid_credentials" } });
    expect((await call()).json).toEqual({ ok: false, code: "credentials" });
    expect(mocks.rewrap).not.toHaveBeenCalled(); expect(mocks.updateUser).not.toHaveBeenCalled();
    mocks.signIn.mockResolvedValue({ data: { user: null }, error: { status: 400, code: "captcha_failed" } });
    expect((await call()).json).toEqual({ ok: false, code: "captcha" });
    mocks.claim.mockResolvedValue({ verdict: "limited" });
    expect((await call()).json).toEqual({ ok: false, code: "rate" });
  });
  it("an absent or rejected Bearer session never reaches the change", async () => {
    expect((await call(INPUT, null)).status).toBe(401);
    mocks.getUser.mockResolvedValue({ data: { user: null }, error: { status: 403 } });
    expect((await call()).status).toBe(401); expect(mocks.signIn).not.toHaveBeenCalled();
  });
  it("raw passwords, extra identity fields and malformed wraps are invalid before sign-in", async () => {
    for (const input of [{ ...INPUT, password: "raw" }, { ...INPUT, userId: "other" }, { ...INPUT, currentAuthSecret: "raw" }, { ...INPUT, rewrap: { ...WRAP, keyId: "invalid" } }]) {
      expect((await call(input)).status).toBe(400);
    }
    expect(mocks.signIn).not.toHaveBeenCalled(); expect(mocks.rewrap).not.toHaveBeenCalled();
  });
  it("a different signed-in owner or changed stored wrap never sets the new secret", async () => {
    mocks.signIn.mockResolvedValue({ data: { user: { id: "other" } }, error: null });
    expect((await call()).json).toEqual({ ok: false, code: "other" });
    expect(mocks.updateUser).not.toHaveBeenCalled();
    mocks.signIn.mockResolvedValue({ data: { user: { id: "owner" } }, error: null });
    mocks.read.mockResolvedValue({ ok: true, key: { ...STORED, wrapped_private_key: "changed" } });
    expect((await call()).json).toEqual({ ok: false, code: "key_wrap_changed" });
    expect(mocks.updateUser).not.toHaveBeenCalled();
  });
});
