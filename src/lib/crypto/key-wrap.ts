/**
 * The user's private key, wrapped with a key made from their passphrase. Runs in the browser:
 * the passphrase and the unwrapped key never leave it. Only the wrapped form is sent to the server.
 *
 *   kek      PBKDF2-SHA256(NFKC(passphrase) as UTF-8, salt = 16 random bytes, >= 600,000 rounds) -> AES-256
 *   wrapped  AES-256-GCM(kek, iv = 12 random bytes, aad = "otodoke/key/v1|<user_id>", PKCS#8 of the private key)
 *
 * Server code must not import this file (src/lib/__tests__/passphrase-stays-in-browser.test.ts).
 */
import { fromBase64, randomBytes, toBase64, utf8, equalBytes, type Bytes } from "./bytes";
import { keyIdOf, publicKeyOf, type PrivateRecipient } from "./envelope";

export const PASSPHRASE_MIN_LENGTH = 10;
export const KDF_ITERATIONS = 600_000;
/** Far above what we write; a stored value above it would only make the browser hang. */
const KDF_ITERATIONS_MAX = 10_000_000;

const ECDH = { name: "ECDH", namedCurve: "P-256" } as const;

export function normalizePassphrase(passphrase: string): string {
  return passphrase.normalize("NFKC");
}

/** The rule as the screen states it, next to the fields. */
export const PASSPHRASE_RULE = `${PASSPHRASE_MIN_LENGTH} 文字以上。同じ文字のくり返し、1234… や abcd… のような連番、password のようなよくある言葉と数字だけの組み合わせは使えません。`;

/**
 * Words people pick first. The wrapped key can be tried offline by anyone who gets the database
 * row, so a passphrase that is only one of these (plus digits or symbols) is refused. Kept short
 * on purpose: the rule must stay simple enough to state in one line on the screen.
 */
const COMMON_WORDS = new Set([
  "password",
  "passwd",
  "passw0rd",
  "qwerty",
  "qwertyuiop",
  "asdfghjkl",
  "zxcvbnm",
  "qazwsx",
  "iloveyou",
  "letmein",
  "welcome",
  "admin",
  "administrator",
  "login",
  "otodoke",
  "monkey",
  "dragon",
  "sunshine",
  "princess",
  "football",
  "baseball",
  "secret",
  "pokemon",
  "aikotoba",
  "himitsu",
  "abc",
  "abcd",
  "abcde",
]);

/** Only one short unit repeated ("aaaa…", "1212…", "abcabc…"). */
function isRepetition(chars: string[]): boolean {
  for (let unit = 1; unit <= 3; unit++) {
    if (chars.length >= unit * 2 && chars.every((c, i) => c === chars[i % unit])) return true;
  }
  return false;
}

/** Each character one code point up (or down) from the one before ("1234…", "abcd…", "9876…"); 9 → 0 counts as up. */
function isSequence(chars: string[]): boolean {
  const step = (a: string, b: string) => {
    if (a === "9" && b === "0") return 1;
    if (a === "0" && b === "9") return -1;
    return (b.codePointAt(0) ?? 0) - (a.codePointAt(0) ?? 0);
  };
  const first = step(chars[0], chars[1]);
  if (first !== 1 && first !== -1) return false;
  for (let i = 1; i < chars.length; i++) if (step(chars[i - 1], chars[i]) !== first) return false;
  return true;
}

/** Too easy to guess, by the rule in PASSPHRASE_RULE. Input is the normalized passphrase. */
export function isWeakPassphrase(normalized: string): boolean {
  const lower = normalized.toLowerCase();
  const chars = [...lower];
  if (chars.length < 2 || isRepetition(chars) || isSequence(chars)) return true;
  // A common word with only digits, spaces or symbols around it ("password1234", "qwerty!!!!").
  const letters = lower.replace(/[\d\s\p{P}\p{S}]/gu, "");
  return COMMON_WORDS.has(letters);
}

/** What is wrong with a new passphrase, in words for the screen, or null when it is fine. */
export function passphraseProblem(passphrase: string, again: string): string | null {
  const p = normalizePassphrase(passphrase);
  if ([...p].length < PASSPHRASE_MIN_LENGTH) return `${PASSPHRASE_MIN_LENGTH} 文字以上にしてください`;
  if (isWeakPassphrase(p)) return "推測されやすい合言葉です。同じ文字のくり返し・連番・よくある言葉は避けてください";
  if (p !== normalizePassphrase(again)) return "2 回の入力が違います";
  return null;
}

export function keyWrapAad(userId: string): string {
  return `otodoke/key/v1|${userId}`;
}

/** The wrapped private key as stored in user_keys (all base64 but the count). */
export interface WrappedKey {
  wrapped_private_key: string;
  wrap_iv: string;
  kdf_salt: string;
  kdf_iterations: number;
}

async function keyFromPassphrase(passphrase: string, salt: Bytes, iterations: number): Promise<CryptoKey> {
  if (!Number.isInteger(iterations) || iterations < KDF_ITERATIONS || iterations > KDF_ITERATIONS_MAX) throw new Error("bad iteration count");
  if (salt.length !== 16) throw new Error("bad salt");
  const base = await crypto.subtle.importKey("raw", utf8(normalizePassphrase(passphrase)), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

/** Tests only: a fixed salt and IV, so a test vector comes out the same every time. */
export interface WrapInjection {
  salt: Bytes;
  iv: Bytes;
}

export async function wrapPrivateKey(pkcs8: Bytes, passphrase: string, userId: string, inject?: WrapInjection): Promise<WrappedKey> {
  if (inject && process.env.NODE_ENV !== "test") throw new Error("fixed salts are for tests only");
  const salt = inject?.salt ?? randomBytes(16);
  const iv = inject?.iv ?? randomBytes(12);
  const kek = await keyFromPassphrase(passphrase, salt, KDF_ITERATIONS);
  const wrapped = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: utf8(keyWrapAad(userId)), tagLength: 128 }, kek, pkcs8));
  return { wrapped_private_key: toBase64(wrapped), wrap_iv: toBase64(iv), kdf_salt: toBase64(salt), kdf_iterations: KDF_ITERATIONS };
}

/** The PKCS#8 bytes. A wrong passphrase (or a changed byte) throws. */
export async function unwrapPrivateKeyBytes(wrapped: WrappedKey, passphrase: string, userId: string): Promise<Bytes> {
  const iv = fromBase64(wrapped.wrap_iv);
  if (iv.length !== 12) throw new Error("bad iv");
  const kek = await keyFromPassphrase(passphrase, fromBase64(wrapped.kdf_salt), wrapped.kdf_iterations);
  return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: utf8(keyWrapAad(userId)), tagLength: 128 }, kek, fromBase64(wrapped.wrapped_private_key)));
}

export interface NewKeyPair {
  pkcs8: Bytes;
  publicKey: Bytes;
  keyId: string;
}

export async function createKeyPair(): Promise<NewKeyPair> {
  const pair = (await crypto.subtle.generateKey(ECDH, true, ["deriveBits"])) as CryptoKeyPair;
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  const publicKey = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  return { pkcs8, publicKey, keyId: await keyIdOf(publicKey) };
}

/** A stored key row as the browser reads it back (RLS: the owner only). */
export interface StoredKey extends WrappedKey {
  key_id: string;
  public_key: string;
}

/**
 * Open the stored key with the passphrase and prove it is the pair of the stored public key.
 * The private key kept for the tab cannot be exported again.
 */
export async function openStoredKey(stored: StoredKey, passphrase: string, userId: string): Promise<PrivateRecipient> {
  const pkcs8 = await unwrapPrivateKeyBytes(stored, passphrase, userId);
  const publicKey = fromBase64(stored.public_key);
  const check = await crypto.subtle.importKey("pkcs8", pkcs8, ECDH, true, ["deriveBits"]);
  if (!equalBytes(await publicKeyOf(check), publicKey)) throw new Error("the stored private key does not match the stored public key");
  if ((await keyIdOf(publicKey)) !== stored.key_id) throw new Error("the stored key id does not match the public key");
  const privateKey = await crypto.subtle.importKey("pkcs8", pkcs8, ECDH, false, ["deriveBits"]);
  pkcs8.fill(0);
  return { keyId: stored.key_id, publicKey, privateKey };
}

// ---- With a KEK made elsewhere: password v1 (docs/crypto/password-v1.md) ---------------------
//
// The same wrap and the same stored form as above (AES-256-GCM, a 12-byte IV, the AAD
// "otodoke/key/v1|<user_id>", ciphertext || tag in base64, kdf_iterations 600,000). Only the KEK
// comes from outside: password-v1.ts kekFor makes it from the login password and the row's
// kdf_salt. That salt cannot be read back out of the KEK, so a wrap is given the salt its KEK
// was made with, and stores it.

/** Tests only: a fixed IV, so a test vector comes out the same every time. */
export interface KekWrapInjection {
  iv: Bytes;
}

/**
 * Wrap the PKCS#8 bytes with a KEK. `kdfSalt` is the base64 of the 16 bytes the KEK was made with
 * (kekFor(master, kdfSalt)); it is stored as the row's kdf_salt, and opening makes the KEK again
 * from it. Use a new salt (newKdfSalt) for every wrap.
 */
export async function wrapPrivateKeyWithKek(pkcs8: Bytes, kek: CryptoKey, kdfSalt: string, userId: string, inject?: KekWrapInjection): Promise<WrappedKey> {
  if (inject && process.env.NODE_ENV !== "test") throw new Error("fixed IVs are for tests only");
  if (fromBase64(kdfSalt).length !== 16) throw new Error("bad salt");
  const iv = inject?.iv ?? randomBytes(12);
  if (iv.length !== 12) throw new Error("bad iv");
  const wrapped = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: utf8(keyWrapAad(userId)), tagLength: 128 }, kek, pkcs8));
  return { wrapped_private_key: toBase64(wrapped), wrap_iv: toBase64(iv), kdf_salt: kdfSalt, kdf_iterations: KDF_ITERATIONS };
}

/** The PKCS#8 bytes. A wrong KEK (or a changed byte, or another user id) throws the AES-GCM OperationError as it is. */
async function unwrapWithKek(wrapped: WrappedKey, kek: CryptoKey, userId: string): Promise<Bytes> {
  const iv = fromBase64(wrapped.wrap_iv);
  if (iv.length !== 12) throw new Error("bad iv");
  return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: utf8(keyWrapAad(userId)), tagLength: 128 }, kek, fromBase64(wrapped.wrapped_private_key)));
}

/** What openStoredKey checks once the key is open: it is the pair of the stored public key, and the key id is that key's. */
async function checkOpenedKey(stored: StoredKey, pkcs8: Bytes): Promise<Bytes> {
  const publicKey = fromBase64(stored.public_key);
  const check = await crypto.subtle.importKey("pkcs8", pkcs8, ECDH, true, ["deriveBits"]);
  if (!equalBytes(await publicKeyOf(check), publicKey)) throw new Error("the stored private key does not match the stored public key");
  if ((await keyIdOf(publicKey)) !== stored.key_id) throw new Error("the stored key id does not match the public key");
  return publicKey;
}

/** A new key pair, its private key wrapped with a KEK. The private key's bytes are zeroed here and never returned. */
export interface NewWrappedKey {
  publicKey: Bytes;
  keyId: string;
  wrapped: WrappedKey;
}

/** The KEK version of createKeyPair + wrapPrivateKey: a new key pair, wrapped with the KEK made with `kdfSalt`. */
export async function createWrappedKey(kek: CryptoKey, kdfSalt: string, userId: string): Promise<NewWrappedKey> {
  const pair = await createKeyPair();
  try {
    return { publicKey: pair.publicKey, keyId: pair.keyId, wrapped: await wrapPrivateKeyWithKek(pair.pkcs8, kek, kdfSalt, userId) };
  } finally {
    pair.pkcs8.fill(0);
  }
}

/**
 * openStoredKey with a KEK: open the stored key and prove it is the pair of the stored public key
 * (and the key id is that key's). The KEK is kekFor(master, stored.kdf_salt). The private key kept
 * for the tab cannot be exported again. A wrong KEK rejects with the AES-GCM OperationError, as a
 * wrong passphrase does.
 */
export async function openStoredKeyWithKek(stored: StoredKey, kek: CryptoKey, userId: string): Promise<PrivateRecipient> {
  const pkcs8 = await unwrapWithKek(stored, kek, userId);
  try {
    const publicKey = await checkOpenedKey(stored, pkcs8);
    const privateKey = await crypto.subtle.importKey("pkcs8", pkcs8, ECDH, false, ["deriveBits"]);
    return { keyId: stored.key_id, publicKey, privateKey };
  } finally {
    pkcs8.fill(0);
  }
}

/**
 * The same private key wrapped again (the password or the address changed): opened with the old
 * KEK and checked as openStoredKeyWithKek checks it, then wrapped with the new KEK, under the new
 * kdf_salt that KEK was made with and a new IV. Returns the new wrap; nothing is stored here
 * (the server stores it over the old one, rewrapMailKey).
 *
 * This cannot tell that `newKek` was made with `newKdfSalt`. Before sending, open the new wrap
 * with kekFor(newMaster, wrap.kdf_salt): that proves the stored salt makes the KEK again.
 */
export async function rewrapStoredKey(stored: StoredKey, oldKek: CryptoKey, newKek: CryptoKey, newKdfSalt: string, userId: string): Promise<WrappedKey> {
  if (equalBytes(fromBase64(newKdfSalt), fromBase64(stored.kdf_salt))) throw new Error("a new wrap needs a new kdf_salt");
  const pkcs8 = await unwrapWithKek(stored, oldKek, userId);
  try {
    await checkOpenedKey(stored, pkcs8);
    return await wrapPrivateKeyWithKek(pkcs8, newKek, newKdfSalt, userId);
  } finally {
    pkcs8.fill(0);
  }
}
