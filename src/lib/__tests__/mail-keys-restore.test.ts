import { describe, expect, it } from "vitest";
import { randomBytes, toBase64 } from "@/lib/crypto/bytes";
import { challengeAad, openBytes } from "@/lib/crypto/envelope";
import { KEY_WRAP_CHANGED } from "@/lib/crypto/key-messages";
import { createWrappedKey, openStoredKeyWithKek, rewrapStoredKey, type StoredKey, type WrappedKey } from "@/lib/crypto/key-wrap";
import { newKdfSalt } from "@/lib/crypto/password-v1";
import { activateKey, KeyRestoreSchema, registerKey, restoreKeyWrap, rewrapKey, type KeyRestore } from "@/lib/mail-keys";
import { FakeDb, type Row } from "./fake-db";
import { OTHER, USER, asAdmin } from "./pipeline-fixtures";

/**
 * restoreKeyWrap: when a password change stored its new wrap (rewrapKey) but the new login secret
 * could not be set, the wrap from before goes back, so the key opens again with the password that
 * still signs in. Written only over the wrap that change stored (the same check as rewrapKey).
 * KEKs are made from random bytes here; the wrap is key-wrap.ts's KEK version, as password v1 uses it.
 */

const rawKek = () => crypto.subtle.importKey("raw", randomBytes(32), "AES-GCM", false, ["encrypt", "decrypt"]);
const stored = (db: FakeDb, keyId: string) => db.rows("user_keys").find((k) => k.key_id === keyId) as unknown as StoredKey & Row;
const wrapOf = (row: WrappedKey): WrappedKey => ({ wrapped_private_key: row.wrapped_private_key, wrap_iv: row.wrap_iv, kdf_salt: row.kdf_salt, kdf_iterations: row.kdf_iterations });
const isOperationError = (e: unknown) => e instanceof Error && e.name === "OperationError";

/** A key made, registered and put in use as the browser does it, wrapped with `kek`. */
async function keyInUse(db: FakeDb, kek: CryptoKey, userId = USER): Promise<string> {
  const created = await createWrappedKey(kek, newKdfSalt(), userId);
  const w = created.wrapped;
  const reg = await registerKey(asAdmin(db), userId, { publicKey: toBase64(created.publicKey), wrappedPrivateKey: w.wrapped_private_key, wrapIv: w.wrap_iv, kdfSalt: w.kdf_salt, kdfIterations: w.kdf_iterations, expectedCurrentKeyId: null });
  if (!reg.ok) throw new Error(reg.error);
  const answer = await openBytes(await openStoredKeyWithKek(stored(db, reg.keyId), kek, userId), challengeAad(userId, reg.keyId), reg.challenge);
  const act = await activateKey(asAdmin(db), userId, { keyId: reg.keyId, challenge: toBase64(answer), expectedCurrentKeyId: null });
  if (!act.ok) throw new Error(act.error);
  return reg.keyId;
}

/** A password change up to the new wrap the server stored: the wrap from before, and the new one. */
async function rewrapped(db: FakeDb, keyId: string, oldKek: CryptoKey, newKek: CryptoKey, userId = USER): Promise<{ before: WrappedKey; after: WrappedKey }> {
  const before = wrapOf(stored(db, keyId));
  const after = await rewrapStoredKey(stored(db, keyId), oldKek, newKek, newKdfSalt(), userId);
  const res = await rewrapKey(asAdmin(db), userId, { keyId, previousWrappedPrivateKey: before.wrapped_private_key, wrappedPrivateKey: after.wrapped_private_key, wrapIv: after.wrap_iv, kdfSalt: after.kdf_salt, kdfIterations: after.kdf_iterations });
  if (!res.ok) throw new Error(res.error);
  return { before, after };
}

/** Put `before` back over `after`. */
const restoreOf = (keyId: string, before: WrappedKey, after: WrappedKey): KeyRestore => ({
  keyId,
  rewrappedPrivateKey: after.wrapped_private_key,
  wrappedPrivateKey: before.wrapped_private_key,
  wrapIv: before.wrap_iv,
  kdfSalt: before.kdf_salt,
  kdfIterations: before.kdf_iterations,
});

describe("putting back the wrap from before a password change that did not go through", () => {
  it("stores the wrap from before again, over the one the change stored: the key opens with the old KEK again, not the new", async () => {
    const db = new FakeDb();
    const [oldKek, newKek] = [await rawKek(), await rawKek()];
    const keyId = await keyInUse(db, oldKek);
    const { before, after } = await rewrapped(db, keyId, oldKek, newKek);
    expect(wrapOf(stored(db, keyId))).toEqual(after);

    expect(await restoreKeyWrap(asAdmin(db), USER, restoreOf(keyId, before, after))).toEqual({ ok: true, keyId });
    expect(wrapOf(stored(db, keyId))).toEqual(before);
    await expect(openStoredKeyWithKek(stored(db, keyId), oldKek, USER)).resolves.toMatchObject({ keyId });
    expect(isOperationError(await openStoredKeyWithKek(stored(db, keyId), newKek, USER).catch((e: unknown) => e))).toBe(true);
  });

  it("sends the check to the database with the write: this user, this key, in use, and the wrap the change stored", async () => {
    const db = new FakeDb();
    const oldKek = await rawKek();
    const keyId = await keyInUse(db, oldKek);
    const { before, after } = await rewrapped(db, keyId, oldKek, await rawKek());
    await restoreKeyWrap(asAdmin(db), USER, restoreOf(keyId, before, after));
    const write = db.callsOn("user_keys", "update").at(-1)!;
    expect(write.values).toEqual(before);
    expect(write.filters).toEqual(
      expect.arrayContaining([
        { method: "eq", args: ["user_id", USER] },
        { method: "eq", args: ["key_id", keyId] },
        { method: "eq", args: ["wrapped_private_key", after.wrapped_private_key] },
        { method: "not", args: ["activated_at", "is", null] },
        { method: "is", args: ["retired_at", null] },
      ]),
    );
  });

  it("is refused when the stored wrap is no longer the one the change stored (another tab changed it since); that wrap stays", async () => {
    const db = new FakeDb();
    const [oldKek, newKek, tabKek] = [await rawKek(), await rawKek(), await rawKek()];
    const keyId = await keyInUse(db, oldKek);
    const { before, after } = await rewrapped(db, keyId, oldKek, newKek);
    // Another tab changes the password again in between, from the new wrap.
    const { after: other } = await rewrapped(db, keyId, newKek, tabKek);

    expect(await restoreKeyWrap(asAdmin(db), USER, restoreOf(keyId, before, after))).toEqual({ ok: false, error: KEY_WRAP_CHANGED });
    expect(wrapOf(stored(db, keyId))).toEqual(other);
    await expect(openStoredKeyWithKek(stored(db, keyId), tabKek, USER)).resolves.toMatchObject({ keyId });
  });

  it("is safe to call again: once the wrap from before is back, it answers ok and changes nothing", async () => {
    const db = new FakeDb();
    const oldKek = await rawKek();
    const keyId = await keyInUse(db, oldKek);
    const { before, after } = await rewrapped(db, keyId, oldKek, await rawKek());
    const input = restoreOf(keyId, before, after);
    expect(await restoreKeyWrap(asAdmin(db), USER, input)).toEqual({ ok: true, keyId });
    const row = { ...stored(db, keyId) };
    // The answer was lost; the browser asks again.
    expect(await restoreKeyWrap(asAdmin(db), USER, input)).toEqual({ ok: true, keyId });
    expect(stored(db, keyId)).toEqual(row);
    // Negative control: the same wrap, but another salt than the one before, is not "already back".
    expect(await restoreKeyWrap(asAdmin(db), USER, { ...input, kdfSalt: newKdfSalt() })).toEqual({ ok: false, error: KEY_WRAP_CHANGED });
    expect(stored(db, keyId)).toEqual(row);
  });

  it("refuses another user, a retired key, and a key that is not in use, and changes nothing", async () => {
    const db = new FakeDb();
    const oldKek = await rawKek();
    const keyId = await keyInUse(db, oldKek);
    const { before, after } = await rewrapped(db, keyId, oldKek, await rawKek());
    const input = restoreOf(keyId, before, after);

    expect(await restoreKeyWrap(asAdmin(db), OTHER, input)).toEqual({ ok: false, error: "no key in use with this id" });
    expect(await restoreKeyWrap(asAdmin(db), USER, { ...input, keyId: "0".repeat(32) })).toEqual({ ok: false, error: "no key in use with this id" });
    expect(wrapOf(stored(db, keyId))).toEqual(after);

    stored(db, keyId).retired_at = "2026-11-06T00:00:00Z";
    expect(await restoreKeyWrap(asAdmin(db), USER, input)).toEqual({ ok: false, error: "no key in use with this id" });
    expect(wrapOf(stored(db, keyId))).toEqual(after);
  });

  it("refuses an unknown field (a password), the same wrap as the one to replace, and a wrap of the wrong size", async () => {
    const db = new FakeDb();
    const oldKek = await rawKek();
    const keyId = await keyInUse(db, oldKek);
    const { before, after } = await rewrapped(db, keyId, oldKek, await rawKek());
    const input = restoreOf(keyId, before, after);
    const bad: unknown[] = [
      { ...input, password: "x" },
      { ...input, passphrase: "x" },
      { ...input, wrappedPrivateKey: input.rewrappedPrivateKey },
      { ...input, wrapIv: toBase64(new Uint8Array(8)) },
      { ...input, kdfSalt: toBase64(new Uint8Array(8)) },
      { ...input, wrappedPrivateKey: toBase64(new Uint8Array(16)) },
      { ...input, kdfIterations: 100_000 },
      { ...input, keyId: "x" },
    ];
    for (const b of bad) expect((await restoreKeyWrap(asAdmin(db), USER, b)).ok, JSON.stringify(b)).toBe(false);
    expect(wrapOf(stored(db, keyId))).toEqual(after);
    expect(Object.keys(KeyRestoreSchema.shape).filter((k) => /passphrase|password|合言葉/i.test(k))).toEqual([]);
    // Positive control: the same input as it is.
    expect(await restoreKeyWrap(asAdmin(db), USER, input)).toEqual({ ok: true, keyId });
  });

  it("tells a database error, and changes nothing", async () => {
    const db = new FakeDb();
    const oldKek = await rawKek();
    const keyId = await keyInUse(db, oldKek);
    const { before, after } = await rewrapped(db, keyId, oldKek, await rawKek());
    db.hooks.push((q) => {
      if (q.table === "user_keys" && q.op === "update") return { data: null, error: { message: "connection reset" } };
    });
    expect(await restoreKeyWrap(asAdmin(db), USER, restoreOf(keyId, before, after))).toEqual({ ok: false, error: "user_keys update failed: connection reset" });
    expect(wrapOf(stored(db, keyId))).toEqual(after);
  });
});
