import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes, toBase64 } from "@/lib/crypto/bytes";
import { challengeAad, openBytes } from "@/lib/crypto/envelope";
import { createWrappedKey, openStoredKeyWithKek, rewrapStoredKey, type StoredKey, type WrappedKey } from "@/lib/crypto/key-wrap";
import { newKdfSalt } from "@/lib/crypto/password-v1";
import { activateKey, registerKey, rewrapKey, type KeyRestore } from "@/lib/mail-keys";
import { FakeDb, type Row } from "./fake-db";
import { USER, asAdmin } from "./pipeline-fixtures";

/**
 * The seam between the password change and the key code: changeLoginSecret (login-auth.ts
 * changeSecret) and POST /api/keys/restore put the wrap back with restoreKeyWrap of mail-keys.ts.
 * The real key steps run over a fake database; only Supabase Auth and the limits are stubbed. What
 * the change builds to put the wrap back must be what restoreKeyWrap takes, and its answers must
 * come out as docs/api/keys.md says.
 */

const b64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
/** An access token of USER, signed in with `method` a minute ago (its signature is Supabase's to check: stubbed). */
const jwt = (method: string) => `${b64url({ alg: "ES256" })}.${b64url({ sub: USER, amr: [{ method, timestamp: Math.floor((Date.now() - 60_000) / 1000) }] })}.c2ln`;

const mocks = vi.hoisted(() => ({ db: null as unknown, getSession: vi.fn(), getUser: vi.fn(), signIn: vi.fn(), updateUser: vi.fn(), bearerUser: vi.fn() }));

vi.mock("next/headers", () => ({ headers: async () => new Headers({ "x-real-ip": "203.0.113.7" }) }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getSession: mocks.getSession, getUser: mocks.getUser, signInWithPassword: mocks.signIn, updateUser: mocks.updateUser } }),
}));
// The Bearer check of the key API (auth-session.ts readBearerSession).
vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({ auth: { getUser: mocks.bearerUser } }) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => mocks.db }));
vi.mock("@/lib/login-mail-limit", () => ({
  clientIp: () => "203.0.113.7",
  claimLoginTry: async () => "ok",
  claimLoginAttempt: async () => ({ verdict: "ok", claimId: 1 }),
  releaseLoginAttempt: async () => {},
  claimLoginMail: async () => ({ verdict: "ok", claimId: 1 }),
  releaseLoginMail: async () => {},
}));

const { changeLoginSecret } = await import("@/app/app/settings/password-actions");
const restoreRoute = await import("@/app/api/keys/restore/route");

const OLD = "0".repeat(64);
const NEW = "1".repeat(64);
const REFUSED = { data: { user: null }, error: { status: 422, code: "weak_password" } };

const rawKek = () => crypto.subtle.importKey("raw", randomBytes(32), "AES-GCM", false, ["encrypt", "decrypt"]);
const stored = (db: FakeDb, keyId: string) => db.rows("user_keys").find((k) => k.key_id === keyId) as unknown as StoredKey & Row;
const wrapOf = (row: WrappedKey): WrappedKey => ({ wrapped_private_key: row.wrapped_private_key, wrap_iv: row.wrap_iv, kdf_salt: row.kdf_salt, kdf_iterations: row.kdf_iterations });
const isOperationError = (e: unknown) => e instanceof Error && e.name === "OperationError";

/** A key made, registered and put in use as the browser does it, wrapped with `kek`. */
async function keyInUse(db: FakeDb, kek: CryptoKey): Promise<string> {
  const created = await createWrappedKey(kek, newKdfSalt(), USER);
  const w = created.wrapped;
  const reg = await registerKey(asAdmin(db), USER, { publicKey: toBase64(created.publicKey), wrappedPrivateKey: w.wrapped_private_key, wrapIv: w.wrap_iv, kdfSalt: w.kdf_salt, kdfIterations: w.kdf_iterations, expectedCurrentKeyId: null });
  if (!reg.ok) throw new Error(reg.error);
  const answer = await openBytes(await openStoredKeyWithKek(stored(db, reg.keyId), kek, USER), challengeAad(USER, reg.keyId), reg.challenge);
  const act = await activateKey(asAdmin(db), USER, { keyId: reg.keyId, challenge: toBase64(answer), expectedCurrentKeyId: null });
  if (!act.ok) throw new Error(act.error);
  return reg.keyId;
}

/** A key in use (old KEK), the browser's new wrap of it (new KEK), not stored yet. */
async function setUp() {
  const db = new FakeDb();
  mocks.db = asAdmin(db);
  const [oldKek, newKek] = [await rawKek(), await rawKek()];
  const keyId = await keyInUse(db, oldKek);
  const before = wrapOf(stored(db, keyId));
  const after = await rewrapStoredKey(stored(db, keyId), oldKek, newKek, newKdfSalt(), USER);
  return { db, oldKek, newKek, keyId, before, after };
}

const rewrapOf = (keyId: string, before: WrappedKey, after: WrappedKey) => ({
  keyId,
  previousWrappedPrivateKey: before.wrapped_private_key,
  wrappedPrivateKey: after.wrapped_private_key,
  wrapIv: after.wrap_iv,
  kdfSalt: after.kdf_salt,
  kdfIterations: after.kdf_iterations,
});

/** The body of POST /api/keys/restore: put `before` back over `after` (docs/api/keys.md). */
const restoreOf = (keyId: string, before: WrappedKey, after: WrappedKey): KeyRestore => ({
  keyId,
  rewrappedPrivateKey: after.wrapped_private_key,
  wrappedPrivateKey: before.wrapped_private_key,
  wrapIv: before.wrap_iv,
  kdfSalt: before.kdf_salt,
  kdfIterations: before.kdf_iterations,
});

async function postRestore(body: unknown) {
  const headers = { authorization: `Bearer ${jwt("password")}`, "content-type": "application/json" };
  const res = await restoreRoute.POST(new Request("https://otodoke.app/api/keys/restore", { method: "POST", headers, body: JSON.stringify(body) }));
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon");
  for (const fn of [mocks.getSession, mocks.getUser, mocks.signIn, mocks.updateUser, mocks.bearerUser]) fn.mockReset();
  mocks.getSession.mockImplementation(async () => ({ data: { session: { access_token: jwt("password") } }, error: null }));
  mocks.getUser.mockResolvedValue({ data: { user: { id: USER, email: "someone@example.com" } }, error: null });
  mocks.bearerUser.mockResolvedValue({ data: { user: { id: USER } }, error: null });
  mocks.signIn.mockResolvedValue({ data: { user: { id: USER }, session: {} }, error: null });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("changeLoginSecret puts the wrap back with restoreKeyWrap", () => {
  it("Supabase refuses the new login secret: the wrap the browser opened is stored again, over the one this change stored", async () => {
    const { db, oldKek, newKek, keyId, before, after } = await setUp();
    mocks.updateUser.mockResolvedValue(REFUSED);
    expect(await changeLoginSecret({ currentAuthSecret: OLD, newAuthSecret: NEW, rewrap: rewrapOf(keyId, before, after) }, USER)).toEqual({ ok: false, code: "secret_change_refused" });

    expect(wrapOf(stored(db, keyId))).toEqual(before);
    await expect(openStoredKeyWithKek(stored(db, keyId), oldKek, USER)).resolves.toMatchObject({ keyId });
    expect(isOperationError(await openStoredKeyWithKek(stored(db, keyId), newKek, USER).catch((e: unknown) => e))).toBe(true);
    // Two writes: the rewrap, then the wrap from before, only over the wrap the rewrap stored.
    const writes = db.callsOn("user_keys", "update");
    expect(writes.map((w) => w.values)).toEqual([after, before]);
    expect(writes[1].filters).toEqual(expect.arrayContaining([{ method: "eq", args: ["wrapped_private_key", after.wrapped_private_key] }]));
  });

  it("the wrap from before is back already when it is put back: still secret_change_refused, the key opens with the password that signs in", async () => {
    const { db, oldKek, keyId, before, after } = await setUp();
    mocks.updateUser.mockImplementation(async () => {
      // Meanwhile another call put the wrap from before back.
      Object.assign(stored(db, keyId), before);
      return REFUSED;
    });
    expect(await changeLoginSecret({ currentAuthSecret: OLD, newAuthSecret: NEW, rewrap: rewrapOf(keyId, before, after) }, USER)).toEqual({ ok: false, code: "secret_change_refused" });
    expect(wrapOf(stored(db, keyId))).toEqual(before);
    await expect(openStoredKeyWithKek(stored(db, keyId), oldKek, USER)).resolves.toMatchObject({ keyId });
  });

  it("negative control: when the wrap cannot be put back (another tab stored its own), it says secret_change_refused_key_new and leaves that wrap", async () => {
    const { db, keyId, before, after } = await setUp();
    const other = { wrapped_private_key: toBase64(randomBytes(154)), wrap_iv: toBase64(randomBytes(12)), kdf_salt: newKdfSalt(), kdf_iterations: 600_000 };
    mocks.updateUser.mockImplementation(async () => {
      Object.assign(stored(db, keyId), other);
      return REFUSED;
    });
    expect(await changeLoginSecret({ currentAuthSecret: OLD, newAuthSecret: NEW, rewrap: rewrapOf(keyId, before, after) }, USER)).toEqual({ ok: false, code: "secret_change_refused_key_new" });
    expect(wrapOf(stored(db, keyId))).toEqual(other);
  });
});

describe("POST /api/keys/restore is restoreKeyWrap (docs/api/keys.md)", () => {
  /** A key in use whose wrap the app changed (rewrap stored), as before the restore. */
  async function rewrapped() {
    const s = await setUp();
    const res = await rewrapKey(asAdmin(s.db), USER, rewrapOf(s.keyId, s.before, s.after));
    if (!res.ok) throw new Error(res.error);
    return s;
  }

  it("puts back the wrap from before; asked again (the answer was lost), it answers 200 ok and changes nothing", async () => {
    const { db, oldKek, keyId, before, after } = await rewrapped();
    const body = restoreOf(keyId, before, after);
    expect(await postRestore(body)).toEqual({ status: 200, json: { ok: true, keyId } });
    expect(wrapOf(stored(db, keyId))).toEqual(before);
    await expect(openStoredKeyWithKek(stored(db, keyId), oldKek, USER)).resolves.toMatchObject({ keyId });
    const row = { ...stored(db, keyId) };
    expect(await postRestore(body)).toEqual({ status: 200, json: { ok: true, keyId } });
    expect(stored(db, keyId)).toEqual(row);
  });

  it("409 key_wrap_changed when the stored wrap is neither (another device changed the password since): that wrap stays", async () => {
    const { db, keyId, before, after } = await rewrapped();
    const other = { wrapped_private_key: toBase64(randomBytes(154)), wrap_iv: toBase64(randomBytes(12)), kdf_salt: newKdfSalt(), kdf_iterations: 600_000 };
    Object.assign(stored(db, keyId), other);
    expect(await postRestore(restoreOf(keyId, before, after))).toEqual({ status: 409, json: { ok: false, code: "key_wrap_changed" } });
    expect(wrapOf(stored(db, keyId))).toEqual(other);
  });

  it("400 invalid_input when the wrap to put back is the wrap to replace, and nothing changes", async () => {
    const { db, keyId, before, after } = await rewrapped();
    const body = restoreOf(keyId, before, after);
    expect(await postRestore({ ...body, wrappedPrivateKey: body.rewrappedPrivateKey })).toEqual({ status: 400, json: { ok: false, code: "invalid_input" } });
    expect(wrapOf(stored(db, keyId))).toEqual(after);
  });

  it("409 key_not_in_use for a key that is not the one in use, and nothing changes", async () => {
    const { db, keyId, before, after } = await rewrapped();
    expect(await postRestore({ ...restoreOf(keyId, before, after), keyId: "0".repeat(32) })).toEqual({ status: 409, json: { ok: false, code: "key_not_in_use" } });
    expect(wrapOf(stored(db, keyId))).toEqual(after);
  });
});
