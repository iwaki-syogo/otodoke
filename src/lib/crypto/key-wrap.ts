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

/** What is wrong with a new passphrase, in words for the screen, or null when it is fine. */
export function passphraseProblem(passphrase: string, again: string): string | null {
  const p = normalizePassphrase(passphrase);
  if ([...p].length < PASSPHRASE_MIN_LENGTH) return `${PASSPHRASE_MIN_LENGTH} 文字以上にしてください`;
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
