import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { fromBase64, fromUtf8, toBase64, equalBytes, type Bytes } from "@/lib/crypto/bytes";
import { keyIdOf, mailAad, openBytes, openMail, parseEnvelope, sealMail, WrongKeyError, type EnvelopeV1, type PrivateRecipient } from "@/lib/crypto/envelope";
import { createKeyPair, openStoredKey, unwrapPrivateKeyBytes, wrapPrivateKey, KDF_ITERATIONS } from "@/lib/crypto/key-wrap";
import { passwordProblem } from "@/lib/crypto/password-v1";

/** Fixed vectors shared with the iOS app. Written once by scripts/crypto-vectors.ts. */
const V = JSON.parse(readFileSync(path.join(process.cwd(), "fixtures", "crypto", "envelope-v1.json"), "utf8"));
const E = V.envelope;
const W = V.key_wrap;
const ECDH = { name: "ECDH", namedCurve: "P-256" } as const;

async function recipientFrom(pkcs8: string, publicKey: string): Promise<PrivateRecipient> {
  const raw = fromBase64(publicKey);
  return { keyId: await keyIdOf(raw), publicKey: raw, privateKey: await crypto.subtle.importKey("pkcs8", fromBase64(pkcs8), ECDH, false, ["deriveBits"]) };
}

const vectorRecipient = () => recipientFrom(E.recipient.private_key_pkcs8, E.recipient.public_key);

function flip(b64: string, at: number): string {
  const bytes = fromBase64(b64);
  bytes[at] ^= 0x01;
  return toBase64(bytes);
}

describe("envelope v1: the fixed vector", () => {
  it("opens byte for byte to the stored plaintext", async () => {
    const r = await vectorRecipient();
    expect(r.keyId).toBe(E.recipient.key_id);
    const bytes = await openBytes(r, E.aad, E.envelope);
    expect(fromUtf8(bytes)).toBe(E.plaintext_json);
    expect(await openMail(r, E.user_id, E.email_id, E.envelope)).toEqual(E.plaintext_object);
  });

  it("seals to the same bytes with the same ephemeral key and IV", async () => {
    const env = await sealMail({ keyId: E.recipient.key_id, publicKey: fromBase64(E.recipient.public_key) }, E.user_id, E.email_id, E.plaintext_object, {
      ephemeralPrivateKeyPkcs8: fromBase64(E.ephemeral.private_key_pkcs8),
      ephemeralPublicKey: fromBase64(E.ephemeral.public_key),
      iv: fromBase64(E.iv),
    });
    expect(env).toEqual(E.envelope);
    expect(E.aad).toBe(mailAad(E.user_id, E.email_id));
  });

  it("has the documented shape", () => {
    const env = E.envelope as EnvelopeV1;
    expect(Object.keys(env).sort()).toEqual(["alg", "ct", "epk", "iv", "kid", "v"]);
    expect(env.v).toBe(1);
    expect(env.alg).toBe("P256-HKDF-SHA256-A256GCM");
    expect(fromBase64(env.epk)).toHaveLength(65);
    expect(fromBase64(env.iv)).toHaveLength(12);
    expect(fromBase64(env.ct).length).toBe(new TextEncoder().encode(E.plaintext_json).length + 16);
    expect(env.epk).toBe(E.ephemeral.public_key);
  });
});

describe("envelope v1: fails closed", () => {
  const cases: Array<[string, (e: EnvelopeV1) => unknown]> = [
    ["a changed ciphertext byte", (e) => ({ ...e, ct: flip(e.ct, 3) })],
    ["a changed tag byte", (e) => ({ ...e, ct: flip(e.ct, fromBase64(e.ct).length - 1) })],
    ["a changed IV", (e) => ({ ...e, iv: flip(e.iv, 0) })],
    ["a changed ephemeral key", (e) => ({ ...e, epk: flip(e.epk, 10) })],
    ["another version", (e) => ({ ...e, v: 2 })],
    ["another algorithm", (e) => ({ ...e, alg: "P256-HKDF-SHA256-A128GCM" })],
    ["an extra field", (e) => ({ ...e, note: "x" })],
    ["a missing field", (e) => ({ v: e.v, alg: e.alg, kid: e.kid, epk: e.epk, iv: e.iv })],
    ["url-safe base64", (e) => ({ ...e, ct: e.ct.replace(/\+/g, "-").replace(/\//g, "_") + (e.ct.includes("+") || e.ct.includes("/") ? "" : "-") })],
    ["base64 without padding", (e) => ({ ...e, epk: e.epk.replace(/=+$/, "") })],
    ["a short IV", (e) => ({ ...e, iv: toBase64(fromBase64(e.iv).subarray(0, 8)) })],
    ["not an object", () => "envelope"],
    ["null", () => null],
  ];
  for (const [name, change] of cases) {
    it(`refuses ${name}`, async () => {
      const r = await vectorRecipient();
      await expect(openBytes(r, E.aad, change(E.envelope))).rejects.toThrow();
    });
  }

  it("refuses another user's or another mail's AAD", async () => {
    const r = await vectorRecipient();
    await expect(openMail(r, "00000000-0000-4000-8000-0000000000ab", E.email_id, E.envelope)).rejects.toThrow();
    await expect(openMail(r, E.user_id, "00000000-0000-4000-8000-0000000000ef", E.envelope)).rejects.toThrow();
  });

  it("refuses another key, and says so when the key id differs", async () => {
    const other = await createKeyPair();
    const otherRecipient = await recipientFrom(toBase64(other.pkcs8), toBase64(other.publicKey));
    await expect(openBytes(otherRecipient, E.aad, E.envelope)).rejects.toBeInstanceOf(WrongKeyError);
    // Same key id claimed, another private key: the tag check still refuses it.
    await expect(openBytes({ ...otherRecipient, keyId: E.recipient.key_id }, E.aad, E.envelope)).rejects.toThrow();
  });

  it("refuses a public key that is not an uncompressed P-256 point", async () => {
    const bad = fromBase64(E.recipient.public_key);
    await expect(sealMail({ keyId: E.recipient.key_id, publicKey: bad.subarray(0, 33) as Bytes }, E.user_id, E.email_id, E.plaintext_object)).rejects.toThrow();
    const offCurve = new Uint8Array(bad);
    offCurve[64] ^= 0x01;
    await expect(sealMail({ keyId: E.recipient.key_id, publicKey: offCurve }, E.user_id, E.email_id, E.plaintext_object)).rejects.toThrow();
  });

  it("parseEnvelope accepts the vector", () => {
    expect(parseEnvelope(E.envelope).kid).toBe(E.recipient.key_id);
  });
});

describe("envelope v1: round trips", () => {
  it("a fresh key pair opens what it sealed, with a fresh ephemeral key each time", async () => {
    const k = await createKeyPair();
    const r = await recipientFrom(toBase64(k.pkcs8), toBase64(k.publicKey));
    const mail = { subject: "件名", from_name: null, from_address: "a@example.test", text: "本文".repeat(100_000), html: null };
    const a = await sealMail(r, "u", "e", mail);
    const b = await sealMail(r, "u", "e", mail);
    expect(a.epk).not.toBe(b.epk);
    expect(a.iv).not.toBe(b.iv);
    expect(await openMail(r, "u", "e", a)).toEqual(mail);
  });
});

describe("key wrap v1: the fixed vector", () => {
  it("unwraps to the stored PKCS#8 with the passphrase (NFKC applied)", async () => {
    expect(W.kdf_iterations).toBeGreaterThanOrEqual(600_000);
    const pkcs8 = await unwrapPrivateKeyBytes(W, W.passphrase, W.user_id);
    expect(equalBytes(pkcs8, fromBase64(W.private_key_pkcs8))).toBe(true);
    // The NFKC form is the same passphrase.
    const again = await unwrapPrivateKeyBytes(W, W.passphrase_nfkc, W.user_id);
    expect(equalBytes(again, pkcs8)).toBe(true);
  });

  it("wraps to the same bytes with the same salt and IV", async () => {
    const wrapped = await wrapPrivateKey(fromBase64(W.private_key_pkcs8), W.passphrase, W.user_id, { salt: fromBase64(W.kdf_salt), iv: fromBase64(W.wrap_iv) });
    expect(wrapped).toEqual({ wrapped_private_key: W.wrapped_private_key, wrap_iv: W.wrap_iv, kdf_salt: W.kdf_salt, kdf_iterations: W.kdf_iterations });
  });

  it("opens the stored key and proves it is the pair of the stored public key", async () => {
    const stored = { ...W, key_id: E.recipient.key_id, public_key: E.recipient.public_key };
    const r = await openStoredKey(stored, W.passphrase, W.user_id);
    expect(await openMail(r, E.user_id, E.email_id, E.envelope)).toEqual(E.plaintext_object);
    // The key kept for the tab cannot be exported.
    await expect(crypto.subtle.exportKey("pkcs8", r.privateKey)).rejects.toThrow();
  });
});

describe("key wrap v1: fails closed", () => {
  it("refuses a wrong passphrase, another user, a changed byte, a weakened count", async () => {
    await expect(unwrapPrivateKeyBytes(W, "まちがった合言葉です123", W.user_id)).rejects.toThrow();
    await expect(unwrapPrivateKeyBytes(W, W.passphrase, "00000000-0000-4000-8000-0000000000ab")).rejects.toThrow();
    await expect(unwrapPrivateKeyBytes({ ...W, wrapped_private_key: flip(W.wrapped_private_key, 5) }, W.passphrase, W.user_id)).rejects.toThrow();
    await expect(unwrapPrivateKeyBytes({ ...W, kdf_iterations: 1000 }, W.passphrase, W.user_id)).rejects.toThrow("bad iteration count");
    await expect(unwrapPrivateKeyBytes({ ...W, kdf_iterations: 600_001 }, W.passphrase, W.user_id)).rejects.toThrow();
  });

  it("refuses a stored public key that is not the pair of the wrapped private key", async () => {
    const other = await createKeyPair();
    const stored = { ...W, key_id: other.keyId, public_key: toBase64(other.publicKey) };
    await expect(openStoredKey(stored, W.passphrase, W.user_id)).rejects.toThrow("does not match");
  });

  it("refuses a key id that is not the public key's", async () => {
    const stored = { ...W, key_id: "0".repeat(32), public_key: E.recipient.public_key };
    await expect(openStoredKey(stored, W.passphrase, W.user_id)).rejects.toThrow("key id");
  });

  it("fixed salts and ephemeral keys are refused outside tests", async () => {
    const before = process.env.NODE_ENV;
    try {
      (process.env as Record<string, string>).NODE_ENV = "production";
      await expect(wrapPrivateKey(fromBase64(W.private_key_pkcs8), W.passphrase, W.user_id, { salt: fromBase64(W.kdf_salt), iv: fromBase64(W.wrap_iv) })).rejects.toThrow("tests only");
      await expect(
        sealMail({ keyId: E.recipient.key_id, publicKey: fromBase64(E.recipient.public_key) }, E.user_id, E.email_id, E.plaintext_object, {
          ephemeralPrivateKeyPkcs8: fromBase64(E.ephemeral.private_key_pkcs8),
          ephemeralPublicKey: fromBase64(E.ephemeral.public_key),
          iv: fromBase64(E.iv),
        }),
      ).rejects.toThrow("tests only");
    } finally {
      (process.env as Record<string, string>).NODE_ENV = before!;
    }
  });
});

describe("the rule for a new password (the passphrase's before password-v1)", () => {
  it("needs 10 characters after NFKC and the same twice", () => {
    expect(passwordProblem("短いパスワード", "短いパスワード")).toMatch("10 文字以上");
    expect(passwordProblem("ながいぱすわーどです", "ながいぱすわーどでず")).toMatch("違います");
    expect(passwordProblem("ながいぱすわーどです", "ながいぱすわーどです")).toBeNull();
    // Full-width and half-width digits are the same password.
    expect(passwordProblem("ぱすわーど１２３４５", "ぱすわーど12345")).toBeNull();
    expect(KDF_ITERATIONS).toBeGreaterThanOrEqual(600_000);
  });
});
