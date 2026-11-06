import { pbkdf2Sync } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { equalBytes, fromBase64, randomBytes, toBase64, utf8, type Bytes } from "@/lib/crypto/bytes";
import { challengeAad, openBytes, sealBytes } from "@/lib/crypto/envelope";
import {
  createKeyPair,
  createWrappedKey,
  KDF_ITERATIONS,
  normalizePassphrase,
  openStoredKey,
  openStoredKeyWithKek,
  rewrapStoredKey,
  wrapPrivateKey,
  wrapPrivateKeyWithKek,
  type StoredKey,
  type WrappedKey,
} from "@/lib/crypto/key-wrap";

/**
 * key-wrap.ts with a KEK given from outside (password v1 makes it from the login password,
 * src/lib/crypto/password-v1.ts). The KEKs here are made from random bytes, so the wrap is tested on
 * its own; password-v1.test.ts runs the vectors through the same functions with password-v1's KEK.
 */

const USER = "00000000-0000-4000-8000-00000000000a";
const OTHER = "00000000-0000-4000-8000-00000000000b";

/** A KEK as password-v1 makes one: AES-256-GCM, for encrypt and decrypt, not exportable. */
const rawKek = (bytes: Bytes = randomBytes(32)) => crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
const newSalt = () => toBase64(randomBytes(16));

/** A new key wrapped with `kek`, as the row the server stores and the browser reads back. */
async function newRow(kek: CryptoKey, kdfSalt = newSalt(), userId = USER): Promise<StoredKey> {
  const created = await createWrappedKey(kek, kdfSalt, userId);
  return { key_id: created.keyId, public_key: toBase64(created.publicKey), ...created.wrapped };
}

/** The bytes inside a wrap, opened here with WebCrypto directly and the AAD as the spec writes it. */
async function plaintextOf(row: Pick<WrappedKey, "wrapped_private_key" | "wrap_iv">, kek: CryptoKey, userId = USER): Promise<Bytes> {
  const aad = utf8(`otodoke/key/v1|${userId}`);
  return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64(row.wrap_iv), additionalData: aad, tagLength: 128 }, kek, fromBase64(row.wrapped_private_key)));
}

const flip = (b64: string, at: number) => {
  const bytes = fromBase64(b64);
  bytes[at < 0 ? bytes.length + at : at] ^= 0x01;
  return toBase64(bytes);
};

/** The error a failed AES-GCM open gives, as tab-key.ts keyErrorText reads it (「合言葉が違います」 today). */
const isOperationError = (e: unknown) => e instanceof Error && e.name === "OperationError";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("key-wrap with a KEK: wrap, then open", () => {
  it("a new key wrapped with a KEK opens with it: the same key id and public key, a working private key that cannot be exported", async () => {
    const kek = await rawKek();
    const salt = newSalt();
    const created = await createWrappedKey(kek, salt, USER);
    expect(created.wrapped.kdf_salt).toBe(salt);
    const row: StoredKey = { key_id: created.keyId, public_key: toBase64(created.publicKey), ...created.wrapped };

    const opened = await openStoredKeyWithKek(row, kek, USER);
    expect(opened.keyId).toBe(created.keyId);
    expect(equalBytes(opened.publicKey, created.publicKey)).toBe(true);
    expect(opened.privateKey.extractable).toBe(false);
    expect(opened.privateKey.usages).toEqual(["deriveBits"]);
    const challenge = randomBytes(32);
    const sealed = await sealBytes({ keyId: created.keyId, publicKey: created.publicKey }, challengeAad(USER, created.keyId), challenge);
    expect(equalBytes(await openBytes(opened, challengeAad(USER, created.keyId), sealed), challenge)).toBe(true);
  });

  it("wrapPrivateKeyWithKek gives back the very bytes it wrapped", async () => {
    const kek = await rawKek();
    const pair = await createKeyPair();
    const wrapped = await wrapPrivateKeyWithKek(pair.pkcs8, kek, newSalt(), USER);
    expect(equalBytes(await plaintextOf(wrapped, kek), pair.pkcs8)).toBe(true);
    await expect(openStoredKeyWithKek({ key_id: pair.keyId, public_key: toBase64(pair.publicKey), ...wrapped }, kek, USER)).resolves.toMatchObject({ keyId: pair.keyId });
  });

  it("a new IV every time: the same key wrapped twice gives two wraps", async () => {
    const kek = await rawKek();
    const pair = await createKeyPair();
    const salt = newSalt();
    const a = await wrapPrivateKeyWithKek(pair.pkcs8, kek, salt, USER);
    const b = await wrapPrivateKeyWithKek(pair.pkcs8, kek, salt, USER);
    expect(a.wrap_iv).not.toBe(b.wrap_iv);
    expect(a.wrapped_private_key).not.toBe(b.wrapped_private_key);
  });

  it("the stored form is the one the migration checks (20261106120000_mail_encryption_keys.sql)", async () => {
    const sql = readFileSync(path.join(process.cwd(), "supabase", "migrations", "20261106120000_mail_encryption_keys.sql"), "utf8");
    expect(sql).toMatch(/public_key\s+text not null check \(length\(public_key\) = 88\)/);
    expect(sql).toMatch(/wrap_iv\s+text not null check \(length\(wrap_iv\) = 16\)/);
    expect(sql).toMatch(/kdf_salt\s+text not null check \(length\(kdf_salt\) = 24\)/);
    expect(sql).toMatch(/kdf_iterations\s+integer not null check \(kdf_iterations >= 600000\)/);
    const kek = await rawKek();
    const row = await newRow(kek);
    const pkcs8 = await plaintextOf(row, kek);
    expect(Object.keys(row).sort()).toEqual(["kdf_iterations", "kdf_salt", "key_id", "public_key", "wrap_iv", "wrapped_private_key"]);
    expect(row.key_id).toMatch(/^[0-9a-f]{32}$/);
    expect(row.public_key).toHaveLength(88);
    expect(row.wrap_iv).toHaveLength(16);
    expect(row.kdf_salt).toHaveLength(24);
    expect(row.kdf_iterations).toBe(600_000);
    expect(row.kdf_iterations).toBe(KDF_ITERATIONS);
    expect(fromBase64(row.wrapped_private_key)).toHaveLength(pkcs8.length + 16);
  });

  it("the wrap is the passphrase's, byte for byte: given the passphrase's KEK and the same IV, and each opener reads the other's", async () => {
    const passphrase = "うちの猫は三毛で7歳";
    const salt = randomBytes(16);
    const iv = randomBytes(12);
    const pair = await createKeyPair();
    const theirs = await wrapPrivateKey(pair.pkcs8, passphrase, USER, { salt, iv });
    // The passphrase's KEK: PBKDF2-SHA256 of the NFKC passphrase with the salt. Only the KEK differs in password v1.
    const theirKek = await rawKek(new Uint8Array(pbkdf2Sync(utf8(normalizePassphrase(passphrase)), salt, KDF_ITERATIONS, 32, "sha256")));
    const ours = await wrapPrivateKeyWithKek(pair.pkcs8, theirKek, toBase64(salt), USER, { iv });
    expect(ours).toEqual(theirs);
    const row = (w: WrappedKey): StoredKey => ({ key_id: pair.keyId, public_key: toBase64(pair.publicKey), ...w });
    await expect(openStoredKey(row(ours), passphrase, USER)).resolves.toMatchObject({ keyId: pair.keyId });
    await expect(openStoredKeyWithKek(row(theirs), theirKek, USER)).resolves.toMatchObject({ keyId: pair.keyId });
  });
});

describe("key-wrap with a KEK: what does not open", () => {
  it("another KEK: refused with the AES-GCM OperationError, the error a wrong passphrase gives", async () => {
    const row = await newRow(await rawKek());
    const err = await openStoredKeyWithKek(row, await rawKek(), USER).catch((e: unknown) => e);
    expect(isOperationError(err)).toBe(true);
    // The same as the passphrase opener's, which the screen reads (tab-key.ts keyErrorText).
    const pair = await createKeyPair();
    const passRow: StoredKey = { key_id: pair.keyId, public_key: toBase64(pair.publicKey), ...(await wrapPrivateKey(pair.pkcs8, "うちの猫は三毛で7歳", USER)) };
    const passErr = await openStoredKey(passRow, "うちの猫は三毛で8歳", USER).catch((e: unknown) => e);
    expect(isOperationError(passErr)).toBe(true);
    expect((err as Error).name).toBe((passErr as Error).name);
    expect(Object.getPrototypeOf(err)).toBe(Object.getPrototypeOf(passErr));
  });

  it("another user id in the AAD, a changed ciphertext or tag byte, another IV: refused", async () => {
    const kek = await rawKek();
    const row = await newRow(kek);
    for (const [what, attempt] of [
      ["another user", () => openStoredKeyWithKek(row, kek, OTHER)],
      ["a changed ciphertext byte", () => openStoredKeyWithKek({ ...row, wrapped_private_key: flip(row.wrapped_private_key, 3) }, kek, USER)],
      ["a changed tag byte", () => openStoredKeyWithKek({ ...row, wrapped_private_key: flip(row.wrapped_private_key, -1) }, kek, USER)],
      ["another IV", () => openStoredKeyWithKek({ ...row, wrap_iv: flip(row.wrap_iv, 0) }, kek, USER)],
    ] as const) {
      expect(isOperationError(await attempt().catch((e: unknown) => e)), what).toBe(true);
    }
    // Positive control: the same row, user and KEK open.
    await expect(openStoredKeyWithKek(row, kek, USER)).resolves.toMatchObject({ keyId: row.key_id });
  });

  it("refuses a stored public key that is not the pair of the wrapped key, a key id that is not the public key's, a bad IV", async () => {
    const kek = await rawKek();
    const row = await newRow(kek);
    const other = await createKeyPair();
    await expect(openStoredKeyWithKek({ ...row, key_id: other.keyId, public_key: toBase64(other.publicKey) }, kek, USER)).rejects.toThrow("does not match");
    await expect(openStoredKeyWithKek({ ...row, key_id: "0".repeat(32) }, kek, USER)).rejects.toThrow("key id");
    await expect(openStoredKeyWithKek({ ...row, wrap_iv: toBase64(randomBytes(16)) }, kek, USER)).rejects.toThrow("bad iv");
    await expect(openStoredKeyWithKek({ ...row, wrap_iv: "not base64!" }, kek, USER)).rejects.toThrow("base64");
  });
});

describe("key-wrap with a KEK: wrapping again (the password changed)", () => {
  it("gives another wrap, under the new kdf_salt and a new IV, of the same private key", async () => {
    const oldKek = await rawKek();
    const newKek = await rawKek();
    const row = await newRow(oldKek);
    const before = { ...row };
    const salt = newSalt();
    const w = await rewrapStoredKey(row, oldKek, newKek, salt, USER);

    expect(w.wrapped_private_key).not.toBe(row.wrapped_private_key);
    expect(w.wrap_iv).not.toBe(row.wrap_iv);
    expect(w.kdf_salt).toBe(salt);
    expect(w.kdf_iterations).toBe(KDF_ITERATIONS);
    // The same private key: the same bytes inside, the pair of the same public key.
    expect(equalBytes(await plaintextOf(w, newKek), await plaintextOf(row, oldKek))).toBe(true);
    const reopened = await openStoredKeyWithKek({ ...row, ...w }, newKek, USER);
    expect(reopened.keyId).toBe(row.key_id);
    expect(toBase64(reopened.publicKey)).toBe(row.public_key);
    // The new wrap does not open with the old KEK; the row given is left as it was, and still opens with the old one.
    expect(isOperationError(await openStoredKeyWithKek({ ...row, ...w }, oldKek, USER).catch((e: unknown) => e))).toBe(true);
    expect(row).toEqual(before);
    await expect(openStoredKeyWithKek(row, oldKek, USER)).resolves.toMatchObject({ keyId: row.key_id });
  });

  it("refuses: the wrong old KEK (OperationError), the old kdf_salt again, a key that is not the stored public key's pair", async () => {
    const oldKek = await rawKek();
    const row = await newRow(oldKek);
    expect(isOperationError(await rewrapStoredKey(row, await rawKek(), await rawKek(), newSalt(), USER).catch((e: unknown) => e))).toBe(true);
    await expect(rewrapStoredKey(row, oldKek, await rawKek(), row.kdf_salt, USER)).rejects.toThrow("new kdf_salt");
    const other = await createKeyPair();
    await expect(rewrapStoredKey({ ...row, key_id: other.keyId, public_key: toBase64(other.publicKey) }, oldKek, await rawKek(), newSalt(), USER)).rejects.toThrow("does not match");
    await expect(rewrapStoredKey({ ...row, key_id: "0".repeat(32) }, oldKek, await rawKek(), newSalt(), USER)).rejects.toThrow("key id");
    await expect(rewrapStoredKey(row, oldKek, await rawKek(), toBase64(randomBytes(12)), USER)).rejects.toThrow("bad salt");
    // Positive control: the right old KEK and a new salt.
    await expect(rewrapStoredKey(row, oldKek, await rawKek(), newSalt(), USER)).resolves.toMatchObject({ kdf_iterations: KDF_ITERATIONS });
  });
});

describe("key-wrap with a KEK: the inputs and the private key's bytes", () => {
  it("refuses a kdf_salt that is not 16 bytes in standard base64, and an IV that is not 12 bytes", async () => {
    const kek = await rawKek();
    const pair = await createKeyPair();
    await expect(wrapPrivateKeyWithKek(pair.pkcs8, kek, toBase64(randomBytes(12)), USER)).rejects.toThrow("bad salt");
    await expect(wrapPrivateKeyWithKek(pair.pkcs8, kek, "AAAAAAAAAAAAAAAAAAAAAA", USER)).rejects.toThrow("base64");
    await expect(createWrappedKey(kek, toBase64(randomBytes(32)), USER)).rejects.toThrow("bad salt");
    await expect(wrapPrivateKeyWithKek(pair.pkcs8, kek, newSalt(), USER, { iv: randomBytes(16) })).rejects.toThrow("bad iv");
  });

  it("a fixed IV is refused outside tests", async () => {
    const kek = await rawKek();
    const pair = await createKeyPair();
    const before = process.env.NODE_ENV;
    try {
      (process.env as Record<string, string>).NODE_ENV = "production";
      await expect(wrapPrivateKeyWithKek(pair.pkcs8, kek, newSalt(), USER, { iv: randomBytes(12) })).rejects.toThrow("tests only");
      // Positive control: without one, it wraps.
      await expect(wrapPrivateKeyWithKek(pair.pkcs8, kek, newSalt(), USER)).resolves.toMatchObject({ kdf_iterations: KDF_ITERATIONS });
    } finally {
      (process.env as Record<string, string>).NODE_ENV = before!;
    }
  });

  it("the private key's bytes are zeroed once used, and never returned: making, opening and wrapping again", async () => {
    const subtle = crypto.subtle;
    const realExport = subtle.exportKey.bind(subtle) as (...args: unknown[]) => Promise<unknown>;
    const realDecrypt = subtle.decrypt.bind(subtle) as (...args: unknown[]) => Promise<ArrayBuffer>;
    const exported: ArrayBuffer[] = [];
    const decrypted: ArrayBuffer[] = [];
    vi.spyOn(subtle, "exportKey").mockImplementation((async (...args: unknown[]) => {
      const out = await realExport(...args);
      if (args[0] === "pkcs8") exported.push(out as ArrayBuffer);
      return out;
    }) as never);
    vi.spyOn(subtle, "decrypt").mockImplementation((async (...args: unknown[]) => {
      const out = await realDecrypt(...args);
      decrypted.push(out);
      return out;
    }) as never);

    const oldKek = await rawKek();
    const created = await createWrappedKey(oldKek, newSalt(), USER);
    expect(Object.keys(created).sort()).toEqual(["keyId", "publicKey", "wrapped"]);
    const row: StoredKey = { key_id: created.keyId, public_key: toBase64(created.publicKey), ...created.wrapped };
    await openStoredKeyWithKek(row, oldKek, USER);
    await rewrapStoredKey(row, oldKek, await rawKek(), newSalt(), USER);
    // A check that throws after opening zeroes the bytes too.
    await expect(openStoredKeyWithKek({ ...row, key_id: "0".repeat(32) }, oldKek, USER)).rejects.toThrow("key id");
    vi.restoreAllMocks();

    expect(exported).toHaveLength(1);
    expect(decrypted).toHaveLength(3);
    for (const b of [...exported, ...decrypted]) {
      expect(b.byteLength).toBeGreaterThan(100);
      expect([...new Uint8Array(b)].every((x) => x === 0)).toBe(true);
    }
  });
});
