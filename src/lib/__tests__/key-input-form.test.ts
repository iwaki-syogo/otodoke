import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes, toBase64 } from "@/lib/crypto/bytes";
import { challengeAad, openBytes } from "@/lib/crypto/envelope";
import * as keyMessages from "@/lib/crypto/key-messages";
import { createWrappedKey, openStoredKeyWithKek, rewrapStoredKey, type StoredKey, type WrappedKey } from "@/lib/crypto/key-wrap";
import { newKdfSalt } from "@/lib/crypto/password-v1";
import { ChangeSecretInputSchema } from "@/lib/login-input";
import { activateKey, registerKey, rewrapKey } from "@/lib/mail-keys";
import { FakeDb, type Row } from "./fake-db";
import { USER, asAdmin } from "./pipeline-fixtures";

/**
 * Reviews R3-PW-5 and R3-PW-8: a value of the wrong form is the app's mistake, so the key steps
 * refuse it as `invalid_input` (400 on the iOS key API, docs/api/keys.md), before it reaches the
 * database or the key code. Before, a value that was not base64, or a public key that was not a
 * 65-byte point, came out as 500 key_failed, which tells the app to try again later.
 *
 * Also refused as invalid_input: a rewrap whose new wrap is the one it replaces (the restore after
 * it could never tell the two apart), and a key registered again that is in use or retired already
 * (the database's 23505, a 500 before).
 *
 * The real key steps run over a fake database; only Supabase Auth is stubbed.
 */

const KEY_INPUT_INVALID = (keyMessages as Record<string, string>).KEY_INPUT_INVALID;

const b64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
/** An access token of USER, signed in with the password a minute ago (Supabase Auth checks it: stubbed). */
const jwt = () => `${b64url({ alg: "ES256" })}.${b64url({ sub: USER, amr: [{ method: "password", timestamp: Math.floor((Date.now() - 60_000) / 1000) }] })}.c2ln`;

const mocks = vi.hoisted(() => ({ db: null as unknown, bearerUser: vi.fn() }));
vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({ auth: { getUser: mocks.bearerUser } }) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => mocks.db }));

const routes = {
  register: await import("@/app/api/keys/register/route"),
  activate: await import("@/app/api/keys/activate/route"),
  rewrap: await import("@/app/api/keys/rewrap/route"),
  restore: await import("@/app/api/keys/restore/route"),
};
type Step = keyof typeof routes;

async function post(step: Step, body: unknown) {
  const headers = { authorization: `Bearer ${jwt()}`, "content-type": "application/json" };
  const res = await routes[step].POST(new Request(`https://otodoke.app/api/keys/${step}`, { method: "POST", headers, body: JSON.stringify(body) }));
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

const rawKek = () => crypto.subtle.importKey("raw", randomBytes(32), "AES-GCM", false, ["encrypt", "decrypt"]);
const stored = (db: FakeDb, keyId: string) => db.rows("user_keys").find((k) => k.key_id === keyId) as unknown as StoredKey & Row;
const wrapOf = (row: WrappedKey): WrappedKey => ({ wrapped_private_key: row.wrapped_private_key, wrap_iv: row.wrap_iv, kdf_salt: row.kdf_salt, kdf_iterations: row.kdf_iterations });
const bytes = (n: number, first = 7) => toBase64(Uint8Array.from({ length: n }, (_, i) => (i === 0 ? first : (i * 13) % 256)));

/** A registration as the browser and the app make it (a new pair, wrapped with `kek`). */
async function registration(kek: CryptoKey, expectedCurrentKeyId: string | null = null) {
  const made = await createWrappedKey(kek, newKdfSalt(), USER);
  const w = made.wrapped;
  return { publicKey: toBase64(made.publicKey), wrappedPrivateKey: w.wrapped_private_key, wrapIv: w.wrap_iv, kdfSalt: w.kdf_salt, kdfIterations: w.kdf_iterations, expectedCurrentKeyId };
}

/** Register and put in use, through the API, as the app does. */
async function keyInUse(db: FakeDb, kek: CryptoKey, expectedCurrentKeyId: string | null = null) {
  const body = await registration(kek, expectedCurrentKeyId);
  const reg = await post("register", body);
  expect(reg.status).toBe(200);
  const keyId = reg.json.keyId as string;
  const answer = await openBytes(await openStoredKeyWithKek(stored(db, keyId), kek, USER), challengeAad(USER, keyId), reg.json.challenge as never);
  expect(await post("activate", { keyId, challenge: toBase64(answer), expectedCurrentKeyId })).toMatchObject({ status: 200 });
  return { keyId, body };
}

/** The primary key of user_keys (user_id, key_id), as Postgres keeps it: a second row is 23505. */
function withPrimaryKey(db: FakeDb) {
  db.hooks.push((q, d) => {
    if (q.table !== "user_keys" || q.op !== "insert") return;
    const row = q.values as Row;
    if (!d.rows("user_keys").some((k) => k.user_id === row.user_id && k.key_id === row.key_id)) return;
    const error = { message: 'duplicate key value violates unique constraint "user_keys_pkey"', code: "23505" };
    return { data: null, error };
  });
}

let db: FakeDb;
beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon");
  mocks.bearerUser.mockReset();
  mocks.bearerUser.mockResolvedValue({ data: { user: { id: USER } }, error: null });
  db = new FakeDb();
  mocks.db = asAdmin(db);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("a value of the wrong form: 400 invalid_input, and nothing is stored", () => {
  /** A point that is 65 bytes and starts with 0x04, but is not on the curve. */
  const offCurve = toBase64(Uint8Array.from({ length: 65 }, (_, i) => (i === 0 ? 4 : 1)));

  it.each([
    ["publicKey", "not base64!"],
    ["publicKey", bytes(33, 2)], // a compressed point
    ["publicKey", bytes(64, 4)],
    ["publicKey", bytes(65, 2)],
    ["publicKey", offCurve],
    ["wrappedPrivateKey", "not base64!"],
    ["wrappedPrivateKey", bytes(16)],
    ["wrappedPrivateKey", bytes(513)],
    ["wrapIv", "not base64!"],
    ["wrapIv", bytes(8)],
    ["wrapIv", bytes(16)],
    ["kdfSalt", bytes(12)],
    ["kdfSalt", "AAAAAAAAAAAAAAAAAAAAAA"], // 16 bytes without the padding
  ] as const)("register with %s = %j", async (field, value) => {
    const body = { ...(await registration(await rawKek())), [field]: value };
    expect(await post("register", body)).toEqual({ status: 400, json: { ok: false, code: "invalid_input" } });
    expect(db.rows("user_keys")).toEqual([]);
  });

  it.each([["not base64!"], [bytes(31)], [bytes(33)]] as const)("activate with challenge = %j", async (challenge) => {
    const reg = await post("register", await registration(await rawKek()));
    const keyId = reg.json.keyId as string;
    expect(await post("activate", { keyId, challenge, expectedCurrentKeyId: null })).toEqual({ status: 400, json: { ok: false, code: "invalid_input" } });
    expect(stored(db, keyId).activated_at ?? null).toBeNull();
  });

  it("rewrap and restore with a value that is not base64, or of the wrong size", async () => {
    const [oldKek, newKek] = [await rawKek(), await rawKek()];
    const { keyId } = await keyInUse(db, oldKek);
    const before = wrapOf(stored(db, keyId));
    const after = await rewrapStoredKey(stored(db, keyId), oldKek, newKek, newKdfSalt(), USER);
    const rewrap = { keyId, previousWrappedPrivateKey: before.wrapped_private_key, wrappedPrivateKey: after.wrapped_private_key, wrapIv: after.wrap_iv, kdfSalt: after.kdf_salt, kdfIterations: after.kdf_iterations };
    const restore = { keyId, rewrappedPrivateKey: after.wrapped_private_key, wrappedPrivateKey: before.wrapped_private_key, wrapIv: before.wrap_iv, kdfSalt: before.kdf_salt, kdfIterations: before.kdf_iterations };
    for (const [step, body] of [
      ["rewrap", { ...rewrap, previousWrappedPrivateKey: "not base64!" }],
      ["rewrap", { ...rewrap, wrappedPrivateKey: "not base64!" }],
      ["rewrap", { ...rewrap, wrapIv: bytes(8) }],
      ["rewrap", { ...rewrap, kdfSalt: "AAAA" }],
      ["restore", { ...restore, rewrappedPrivateKey: "not base64!" }],
      ["restore", { ...restore, wrappedPrivateKey: bytes(16) }],
      ["restore", { ...restore, wrapIv: "not base64!" }],
    ] as const) {
      expect(await post(step, body), `${step} ${JSON.stringify(Object.keys(body))}`).toEqual({ status: 400, json: { ok: false, code: "invalid_input" } });
    }
    expect(wrapOf(stored(db, keyId))).toEqual(before);
    // Control: the same bodies as they are go through.
    expect(await post("rewrap", rewrap)).toMatchObject({ status: 200, json: { ok: true, keyId } });
    expect(await post("restore", restore)).toMatchObject({ status: 200, json: { ok: true, keyId } });
    expect(wrapOf(stored(db, keyId))).toEqual(before);
  });

  it("the web's steps answer one fixed text for it, never zod's", async () => {
    expect(KEY_INPUT_INVALID).toEqual(expect.any(String));
    const body = await registration(await rawKek());
    expect(await registerKey(asAdmin(db), USER, { ...body, publicKey: "not base64!" })).toEqual({ ok: false, error: KEY_INPUT_INVALID });
    expect(await registerKey(asAdmin(db), USER, { ...body, password: "x" })).toEqual({ ok: false, error: KEY_INPUT_INVALID });
    expect(await activateKey(asAdmin(db), USER, { keyId: "a".repeat(32), challenge: "!", expectedCurrentKeyId: null })).toEqual({ ok: false, error: KEY_INPUT_INVALID });
    expect(db.rows("user_keys")).toEqual([]);
  });

  it("control: the forms the browser and the app make go through, and the key is put in use", async () => {
    const { keyId } = await keyInUse(db, await rawKek());
    expect(stored(db, keyId).activated_at).toBeTruthy();
  });
});

describe("a rewrap whose new wrap is the one it replaces (R3-PW-8)", () => {
  it("is 400 invalid_input on the API, refused on the web and by the change's input, and the wrap stays", async () => {
    const kek = await rawKek();
    const { keyId } = await keyInUse(db, kek);
    const now = wrapOf(stored(db, keyId));
    const same = { keyId, previousWrappedPrivateKey: now.wrapped_private_key, wrappedPrivateKey: now.wrapped_private_key, wrapIv: now.wrap_iv, kdfSalt: now.kdf_salt, kdfIterations: now.kdf_iterations };
    expect(await post("rewrap", same)).toEqual({ status: 400, json: { ok: false, code: "invalid_input" } });
    expect(await rewrapKey(asAdmin(db), USER, same)).toEqual({ ok: false, error: KEY_INPUT_INVALID });
    // changeLoginSecret takes the same rewrap (login-input.ts): refused before it signs in.
    expect(ChangeSecretInputSchema.safeParse({ currentAuthSecret: "0".repeat(64), newAuthSecret: "1".repeat(64), rewrap: same }).success).toBe(false);
    expect(db.callsOn("user_keys", "update")).toEqual([]);
    expect(wrapOf(stored(db, keyId))).toEqual(now);
  });

  it("control: a new wrap of the same key, with a new salt and IV, goes through", async () => {
    const [oldKek, newKek] = [await rawKek(), await rawKek()];
    const { keyId } = await keyInUse(db, oldKek);
    const before = wrapOf(stored(db, keyId));
    const after = await rewrapStoredKey(stored(db, keyId), oldKek, newKek, newKdfSalt(), USER);
    const rewrap = { keyId, previousWrappedPrivateKey: before.wrapped_private_key, wrappedPrivateKey: after.wrapped_private_key, wrapIv: after.wrap_iv, kdfSalt: after.kdf_salt, kdfIterations: after.kdf_iterations };
    expect(ChangeSecretInputSchema.safeParse({ currentAuthSecret: "0".repeat(64), newAuthSecret: "1".repeat(64), rewrap }).success).toBe(true);
    expect(await post("rewrap", rewrap)).toEqual({ status: 200, json: { ok: true, keyId } });
    expect(wrapOf(stored(db, keyId))).toEqual(after);
  });
});

describe("registering a key that is registered already (R3-PW-8)", () => {
  it("in use, or retired: 400 invalid_input, not 500 key_failed, and nothing changes", async () => {
    withPrimaryKey(db);
    const kek = await rawKek();
    const first = await keyInUse(db, kek);
    // As the app would send it now: the key in use is this one.
    const again = { ...first.body, expectedCurrentKeyId: first.keyId };
    expect(await post("register", again)).toEqual({ status: 400, json: { ok: false, code: "invalid_input" } });
    expect(await registerKey(asAdmin(db), USER, again)).toEqual({ ok: false, error: KEY_INPUT_INVALID });
    expect(stored(db, first.keyId).activated_at).toBeTruthy();

    // The first one retired by a second key: registering it again is refused the same way.
    const second = await keyInUse(db, kek, first.keyId);
    expect(stored(db, first.keyId).retired_at).toBeTruthy();
    expect(await post("register", { ...first.body, expectedCurrentKeyId: second.keyId })).toEqual({ status: 400, json: { ok: false, code: "invalid_input" } });
    expect(db.rows("user_keys")).toHaveLength(2);
  });

  it("control: the same registration sent again while it waits (a retry after a lost answer) is taken, with a new challenge", async () => {
    withPrimaryKey(db);
    const body = await registration(await rawKek());
    const one = await post("register", body);
    const two = await post("register", body);
    expect(one.status).toBe(200);
    expect(two).toMatchObject({ status: 200, json: { ok: true, keyId: one.json.keyId } });
    expect(two.json.challenge).not.toEqual(one.json.challenge);
    expect(db.rows("user_keys")).toHaveLength(1);
  });

  it("control: another database error is still 500 key_failed", async () => {
    db.hooks.push((q) => {
      if (q.table === "user_keys" && q.op === "insert") return { data: null, error: { message: "connection reset" } };
    });
    expect(await post("register", await registration(await rawKek()))).toEqual({ status: 500, json: { ok: false, code: "key_failed" } });
  });
});

describe("the forms are the database's (migration 20261106120000)", () => {
  it("public_key, wrap_iv and kdf_salt: the text lengths its checks ask for are the byte counts the schema takes", () => {
    const sql = readFileSync(path.join(process.cwd(), "supabase/migrations/20261106120000_mail_encryption_keys.sql"), "utf8");
    expect(sql).toMatch(/public_key\s+text not null check \(length\(public_key\) = 88\)/);
    expect(sql).toMatch(/wrap_iv\s+text not null check \(length\(wrap_iv\) = 16\)/);
    expect(sql).toMatch(/kdf_salt\s+text not null check \(length\(kdf_salt\) = 24\)/);
    expect([bytes(65, 4).length, bytes(12).length, bytes(16).length]).toEqual([88, 16, 24]);
  });
});
