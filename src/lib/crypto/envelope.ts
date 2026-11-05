/**
 * Envelope v1: seal bytes to a user's public key so that only their private key opens them.
 * WebCrypto only, so the same code runs in the browser and on the server (globalThis.crypto).
 *
 *   epk   fresh P-256 key pair per envelope (public half sent, 65-byte uncompressed point)
 *   Z     ECDH(epk private, recipient public): the 32-byte x coordinate
 *   key   HKDF-SHA256(ikm = Z, salt = "otodoke/mail/v1", info = epk || recipient public) -> AES-256
 *   ct    AES-256-GCM(key, iv = 12 random bytes, aad), the 16-byte tag appended
 *
 * Every field is checked before anything is decrypted; any doubt throws (fail closed).
 * The format is shared with the iOS app: see fixtures/crypto/envelope-v1.json.
 */
import { concat, fromBase64, fromUtf8, randomBytes, sha256, toBase64, toHex, utf8, type Bytes } from "./bytes";

export const ENVELOPE_VERSION = 1;
export const ENVELOPE_ALG = "P256-HKDF-SHA256-A256GCM";
export const HKDF_SALT = "otodoke/mail/v1";

export interface EnvelopeV1 {
  v: 1;
  alg: typeof ENVELOPE_ALG;
  /** key_id of the recipient key */
  kid: string;
  /** ephemeral public key, 65 bytes, base64 */
  epk: string;
  /** 12 bytes, base64 */
  iv: string;
  /** ciphertext with the 16-byte GCM tag at the end, base64 */
  ct: string;
}

/** The recipient as the sealing side knows it. */
export interface PublicRecipient {
  keyId: string;
  publicKey: Bytes;
}

/** The recipient as the opening side knows it. */
export interface PrivateRecipient extends PublicRecipient {
  privateKey: CryptoKey;
}

/** The envelope was sealed to another key (an older one): it cannot be opened with this one. */
export class WrongKeyError extends Error {
  constructor() {
    super("envelope was sealed to another key");
    this.name = "WrongKeyError";
  }
}

const ECDH = { name: "ECDH", namedCurve: "P-256" } as const;
const KID = /^[0-9a-f]{32}$/;

/** A 65-byte uncompressed P-256 point, checked by importing it. */
export async function importPublicKey(raw: Bytes): Promise<CryptoKey> {
  if (raw.length !== 65 || raw[0] !== 0x04) throw new Error("public key must be a 65-byte uncompressed P-256 point");
  return crypto.subtle.importKey("raw", raw, ECDH, true, []);
}

/** key_id = the first 16 bytes of SHA-256(public key), as lowercase hex. */
export async function keyIdOf(publicKey: Bytes): Promise<string> {
  return toHex((await sha256(publicKey)).subarray(0, 16));
}

/** The uncompressed public point of a private key (it must be extractable). */
export async function publicKeyOf(privateKey: CryptoKey): Promise<Bytes> {
  const jwk = await crypto.subtle.exportKey("jwk", privateKey);
  if (jwk.crv !== "P-256" || !jwk.x || !jwk.y) throw new Error("not a P-256 key");
  return concat(new Uint8Array([4]), fromBase64Url(jwk.x), fromBase64Url(jwk.y));
}

function fromBase64Url(text: string): Bytes {
  const b64 = text.replace(/-/g, "+").replace(/_/g, "/");
  return fromBase64(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
}

async function aesKey(ownPrivate: CryptoKey, peerPublic: CryptoKey, epk: Bytes, recipientPublic: Bytes, usage: "encrypt" | "decrypt"): Promise<CryptoKey> {
  const z = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: peerPublic }, ownPrivate, 256));
  const ikm = await crypto.subtle.importKey("raw", z, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: utf8(HKDF_SALT), info: concat(epk, recipientPublic) },
    ikm,
    { name: "AES-GCM", length: 256 },
    false,
    [usage],
  );
}

/** Tests only: a fixed ephemeral key and IV, so a test vector comes out the same every time. */
export interface SealInjection {
  ephemeralPrivateKeyPkcs8: Bytes;
  ephemeralPublicKey: Bytes;
  iv: Bytes;
}

export async function sealBytes(recipient: PublicRecipient, aad: string, plaintext: Bytes, inject?: SealInjection): Promise<EnvelopeV1> {
  if (!KID.test(recipient.keyId)) throw new Error("bad key id");
  if (inject && process.env.NODE_ENV !== "test") throw new Error("fixed ephemeral keys are for tests only");
  const peer = await importPublicKey(recipient.publicKey);
  let ephemeralPrivate: CryptoKey;
  let epk: Bytes;
  if (inject) {
    ephemeralPrivate = await crypto.subtle.importKey("pkcs8", inject.ephemeralPrivateKeyPkcs8, ECDH, false, ["deriveBits"]);
    epk = inject.ephemeralPublicKey;
  } else {
    const pair = (await crypto.subtle.generateKey(ECDH, true, ["deriveBits"])) as CryptoKeyPair;
    ephemeralPrivate = pair.privateKey;
    epk = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  }
  const iv = inject?.iv ?? randomBytes(12);
  const key = await aesKey(ephemeralPrivate, peer, epk, recipient.publicKey, "encrypt");
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: utf8(aad), tagLength: 128 }, key, plaintext));
  return { v: 1, alg: ENVELOPE_ALG, kid: recipient.keyId, epk: toBase64(epk), iv: toBase64(iv), ct: toBase64(ct) };
}

/** Check every field of a stored envelope. Throws on anything unexpected. */
export function parseEnvelope(value: unknown): { kid: string; epk: Bytes; iv: Bytes; ct: Bytes } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("envelope is not an object");
  const e = value as Record<string, unknown>;
  const keys = Object.keys(e).sort().join(",");
  if (keys !== "alg,ct,epk,iv,kid,v") throw new Error("envelope has unexpected fields");
  if (e.v !== ENVELOPE_VERSION) throw new Error("unknown envelope version");
  if (e.alg !== ENVELOPE_ALG) throw new Error("unknown envelope algorithm");
  if (typeof e.kid !== "string" || !KID.test(e.kid)) throw new Error("bad key id");
  const epk = fromBase64(e.epk as string);
  const iv = fromBase64(e.iv as string);
  const ct = fromBase64(e.ct as string);
  if (epk.length !== 65 || epk[0] !== 0x04) throw new Error("bad ephemeral key");
  if (iv.length !== 12) throw new Error("bad iv");
  if (ct.length < 16) throw new Error("ciphertext too short");
  return { kid: e.kid, epk, iv, ct };
}

export async function openBytes(recipient: PrivateRecipient, aad: string, envelope: unknown): Promise<Bytes> {
  const { kid, epk, iv, ct } = parseEnvelope(envelope);
  if (kid !== recipient.keyId) throw new WrongKeyError();
  const peer = await importPublicKey(epk);
  const key = await aesKey(recipient.privateKey, peer, epk, recipient.publicKey, "decrypt");
  // A wrong key, a changed byte or another AAD all end here as an OperationError.
  return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: utf8(aad), tagLength: 128 }, key, ct));
}

// ---- Mail ----------------------------------------------------------------------------------

/** What is sealed of one stored mail. Everything else on the row stays plaintext. */
export interface MailPlaintext {
  subject: string | null;
  from_name: string | null;
  from_address: string | null;
  text: string | null;
  html: string | null;
}

export function mailAad(userId: string, emailId: string): string {
  return `otodoke/mail/v1|${userId}|${emailId}`;
}

function mailJson(mail: MailPlaintext): string {
  // Fixed key order, so the bytes (and the test vectors) are the same everywhere.
  return JSON.stringify({ v: 1, subject: mail.subject, from_name: mail.from_name, from_address: mail.from_address, text: mail.text, html: mail.html });
}

export function sealMail(recipient: PublicRecipient, userId: string, emailId: string, mail: MailPlaintext, inject?: SealInjection): Promise<EnvelopeV1> {
  return sealBytes(recipient, mailAad(userId, emailId), utf8(mailJson(mail)), inject);
}

const nullableString = (v: unknown): v is string | null => v === null || typeof v === "string";

export async function openMail(recipient: PrivateRecipient, userId: string, emailId: string, envelope: unknown): Promise<MailPlaintext> {
  const parsed: unknown = JSON.parse(fromUtf8(await openBytes(recipient, mailAad(userId, emailId), envelope)));
  if (!parsed || typeof parsed !== "object") throw new Error("sealed mail is not an object");
  const m = parsed as Record<string, unknown>;
  if (m.v !== 1) throw new Error("unknown sealed mail version");
  const fields = ["subject", "from_name", "from_address", "text", "html"] as const;
  for (const f of fields) if (!nullableString(m[f])) throw new Error(`sealed mail: bad ${f}`);
  return { subject: m.subject as string | null, from_name: m.from_name as string | null, from_address: m.from_address as string | null, text: m.text as string | null, html: m.html as string | null };
}

// ---- Key registration challenge --------------------------------------------------------------

export function challengeAad(userId: string, keyId: string): string {
  return `otodoke/key-challenge/v1|${userId}|${keyId}`;
}
