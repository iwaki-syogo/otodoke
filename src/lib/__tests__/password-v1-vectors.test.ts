import { createCipheriv, createDecipheriv, hkdfSync, pbkdf2Sync } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { equalBytes, fromBase64, toBase64, toHex, utf8, type Bytes } from "@/lib/crypto/bytes";
import { keyIdOf, publicKeyOf } from "@/lib/crypto/envelope";
import { KDF_ITERATIONS, keyWrapAad, unwrapPrivateKeyBytes, wrapPrivateKey, type StoredKey, type WrappedKey } from "@/lib/crypto/key-wrap";

/**
 * password v1 (docs/crypto/password-v1.md): the fixed vectors shared with the iOS app, recomputed
 * by two implementations written here, one on Node's crypto and one on WebCrypto. Neither is the
 * script that wrote the file (scripts/crypto-password-v1-vectors.ts).
 */

interface UserKeysRow extends StoredKey {
  user_id: string;
}

interface Case {
  name: string;
  note: string;
  email: string;
  password: string;
  email_norm: string;
  salt_pw_hex: string;
  password_norm: string;
  password_norm_utf8_hex: string;
  master_hex: string;
  auth_secret: string;
  user_id: string;
  kdf_salt_hex: string;
  kek_hex: string;
  aad: string;
  wrap_iv_hex: string;
  wrap_ciphertext_hex: string;
  wrap_tag_hex: string;
  user_keys_row: UserKeysRow;
}

const FILE = path.join(process.cwd(), "fixtures", "crypto", "password-v1.json");
const RAW = readFileSync(FILE, "utf8");
const V = JSON.parse(RAW) as { constants: unknown; private_key: { d_hex: string; pkcs8_hex: string; public_key_hex: string; key_id: string }; cases: Case[] };

const SALT_PW_PREFIX = "otodoke/pw/v1|";
const ITERATIONS = 600_000;
const AUTH_INFO = "otodoke/auth/v1";
const KEK_INFO = "otodoke/kek/v1";
const SLOW = 60_000;

/** Only U+0009 U+000A U+000C U+000D U+0020 off the ends. */
const asciiTrim = (s: string) => s.replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, "");
/** Only A-Z to a-z (no Unicode case mapping, no locale). */
const asciiLower = (s: string) => s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x20));
const emailNorm = (email: string) => asciiLower(asciiTrim(email));

function fromHex(hex: string): Bytes {
  if (!/^(?:[0-9a-f]{2})*$/.test(hex)) throw new Error("not lowercase hex");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

const pick = (name: string): Case => {
  const c = V.cases.find((x) => x.name === name);
  if (!c) throw new Error(`no case ${name}`);
  return c;
};
const PKCS8 = fromHex(V.private_key.pkcs8_hex);
const OTHER_USER = "00000000-0000-4000-8000-0000000001ff";

interface Impl {
  name: string;
  master(passwordNorm: string, emailNorm: string): Promise<Bytes>;
  hkdf(ikm: Bytes, salt: Bytes, info: string): Promise<Bytes>;
  /** ciphertext || 16-byte tag */
  wrap(kek: Bytes, iv: Bytes, aad: string, plaintext: Bytes): Promise<Bytes>;
  unwrap(kek: Bytes, iv: Bytes, aad: string, wrapped: Bytes): Promise<Bytes>;
}

const nodeCrypto: Impl = {
  name: "Node crypto",
  async master(passwordNorm, email) {
    return new Uint8Array(pbkdf2Sync(utf8(passwordNorm), utf8(SALT_PW_PREFIX + email), ITERATIONS, 32, "sha256"));
  },
  async hkdf(ikm, salt, info) {
    return new Uint8Array(hkdfSync("sha256", ikm, salt, utf8(info), 32));
  },
  async wrap(kek, iv, aad, plaintext) {
    const cipher = createCipheriv("aes-256-gcm", kek, iv, { authTagLength: 16 });
    cipher.setAAD(utf8(aad));
    const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return new Uint8Array(Buffer.concat([body, cipher.getAuthTag()]));
  },
  async unwrap(kek, iv, aad, wrapped) {
    const decipher = createDecipheriv("aes-256-gcm", kek, iv, { authTagLength: 16 });
    decipher.setAAD(utf8(aad));
    decipher.setAuthTag(wrapped.subarray(wrapped.length - 16));
    return new Uint8Array(Buffer.concat([decipher.update(wrapped.subarray(0, wrapped.length - 16)), decipher.final()]));
  },
};

const subtle = globalThis.crypto.subtle;
const webCrypto: Impl = {
  name: "WebCrypto",
  async master(passwordNorm, email) {
    const base = await subtle.importKey("raw", utf8(passwordNorm), "PBKDF2", false, ["deriveBits"]);
    return new Uint8Array(await subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: utf8(SALT_PW_PREFIX + email), iterations: ITERATIONS }, base, 256));
  },
  async hkdf(ikm, salt, info) {
    const key = await subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
    return new Uint8Array(await subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info: utf8(info) }, key, 256));
  },
  async wrap(kek, iv, aad, plaintext) {
    const key = await subtle.importKey("raw", kek, "AES-GCM", false, ["encrypt"]);
    return new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv, additionalData: utf8(aad), tagLength: 128 }, key, plaintext));
  },
  async unwrap(kek, iv, aad, wrapped) {
    const key = await subtle.importKey("raw", kek, "AES-GCM", false, ["decrypt"]);
    return new Uint8Array(await subtle.decrypt({ name: "AES-GCM", iv, additionalData: utf8(aad), tagLength: 128 }, key, wrapped));
  },
};

/** master, auth_secret and KEK from what a client has: the typed address and password, and the row's kdf_salt. */
async function derive(impl: Impl, email: string, password: string, kdfSalt: Bytes) {
  const master = await impl.master(password.normalize("NFKC"), emailNorm(email));
  return {
    master: toHex(master),
    authSecret: toHex(await impl.hkdf(master, new Uint8Array(0), AUTH_INFO)),
    kek: await impl.hkdf(master, kdfSalt, KEK_INFO),
  };
}

describe("password v1 vectors: the file", () => {
  it("has the cases the spec lists, each with its own user, salt and IV", () => {
    expect(V.cases.map((c) => c.name)).toEqual([
      "ascii",
      "password_halfwidth_katakana",
      "password_fullwidth_alnum",
      "password_combining_mark",
      "password_compatibility_chars",
      "password_surrounding_spaces",
      "email_uppercase",
      "email_surrounding_whitespace",
      "email_non_ascii_whitespace",
      "email_dotted_capital_i",
    ]);
    for (const field of ["user_id", "kdf_salt_hex", "wrap_iv_hex"] as const) expect(new Set(V.cases.map((c) => c[field])).size).toBe(V.cases.length);
  });

  it("states the constants the tests use", () => {
    expect(V.constants).toEqual({
      email_trim_code_points: ["U+0009", "U+000A", "U+000C", "U+000D", "U+0020"],
      salt_pw_prefix: SALT_PW_PREFIX,
      password_normalization: "NFKC",
      pbkdf2: { prf: "HMAC-SHA256", iterations: ITERATIONS, length: 32 },
      hkdf_hash: "SHA-256",
      auth_salt_hex: "",
      auth_info: AUTH_INFO,
      auth_length: 32,
      kek_info: KEK_INFO,
      kek_length: 32,
      kdf_salt_length: 16,
      wrap: { cipher: "AES-256-GCM", iv_length: 12, tag_length: 16, aad_prefix: "otodoke/key/v1|", layout: "ciphertext || tag" },
    });
  });

  it("is ASCII only, and the input strings write every character outside U+0021-U+007E as a \\u escape", () => {
    expect(/[^\n\x20-\x7e]/.test(RAW)).toBe(false);
    const literals = [...RAW.matchAll(/"(?:email|password|email_norm|password_norm)": ("(?:[^"\\]|\\.)*")/g)].map((m) => m[1]);
    expect(literals).toHaveLength(V.cases.length * 4);
    for (const literal of literals) expect(literal).toMatch(/^"[\x21-\x7e]*"$/);
    // The escapes are there: the half-width katakana and the spaces around the password.
    expect(RAW).toContain('"password": "\\uFF83\\uFF9E\\uFF7C\\uFF9E\\uFF80\\uFF99"');
    expect(RAW).toContain('"password_norm": "\\u0020\\u0020Tr0ub4dor&3\\u0020"');
  });
});

describe("password v1 vectors: normalization", () => {
  it("email_norm, salt_pw and password_norm of every case", () => {
    for (const c of V.cases) {
      expect(emailNorm(c.email), c.name).toBe(c.email_norm);
      expect(toHex(utf8(SALT_PW_PREFIX + c.email_norm)), c.name).toBe(c.salt_pw_hex);
      expect(c.password.normalize("NFKC"), c.name).toBe(c.password_norm);
      expect(toHex(utf8(c.password_norm)), c.name).toBe(c.password_norm_utf8_hex);
    }
  });

  it("the tricky inputs come out as these code points", () => {
    const norm: Record<string, string> = {
      password_halfwidth_katakana: "デジタル",
      password_fullwidth_alnum: "Pass123",
      password_combining_mark: "café",
      password_compatibility_chars: "1平成",
      password_surrounding_spaces: "  Tr0ub4dor&3 ",
    };
    for (const [name, expected] of Object.entries(norm)) expect(pick(name).password_norm, name).toBe(expected);
    const email: Record<string, string> = {
      email_uppercase: "user@example.test",
      email_surrounding_whitespace: "user@example.test",
      email_non_ascii_whitespace: "　user@example.test ",
      email_dotted_capital_i: "İstanbul.izmir@example.test",
    };
    for (const [name, expected] of Object.entries(email)) expect(pick(name).email_norm, name).toBe(expected);
  });

  it("negative control: the usual mistakes each fail on some case", () => {
    const caughtBy = (mistake: (c: Case) => string, field: "email_norm" | "password_norm") =>
      V.cases.filter((c) => toHex(utf8(mistake(c))) !== toHex(utf8(c[field]))).map((c) => c.name);
    // A Unicode trim (String.prototype.trim, like Swift's trimmingCharacters(in:)) instead of the five code points.
    expect(caughtBy((c) => asciiLower(c.email.trim()), "email_norm")).toEqual(["email_non_ascii_whitespace"]);
    // Unicode or Turkish lower-casing instead of A-Z only.
    expect(caughtBy((c) => asciiTrim(c.email).toLowerCase(), "email_norm")).toEqual(["email_dotted_capital_i"]);
    expect(caughtBy((c) => asciiTrim(c.email).toLocaleLowerCase("tr"), "email_norm")).toEqual(["email_dotted_capital_i"]);
    expect(caughtBy((c) => c.password, "password_norm")).toEqual([
      "password_halfwidth_katakana",
      "password_fullwidth_alnum",
      "password_combining_mark",
      "password_compatibility_chars",
      "password_surrounding_spaces",
    ]);
    expect(caughtBy((c) => c.password.normalize("NFC"), "password_norm")).toEqual([
      "password_halfwidth_katakana",
      "password_fullwidth_alnum",
      "password_compatibility_chars",
      "password_surrounding_spaces",
    ]);
    // Decomposed but never composed: what Foundation's precomposedStringWithCompatibilityMapping does to the voiced marks.
    expect(caughtBy((c) => c.password.normalize("NFKD"), "password_norm")).toEqual(["password_halfwidth_katakana", "password_combining_mark"]);
    expect(caughtBy((c) => c.password.normalize("NFKC").trim(), "password_norm")).toEqual(["password_surrounding_spaces"]);
  });
});

for (const impl of [nodeCrypto, webCrypto]) {
  describe(`password v1 vectors: ${impl.name} recomputes every value`, () => {
    for (const c of V.cases) {
      it(
        c.name,
        async () => {
          const row = c.user_keys_row;
          // As a client does: the address and password as typed, the salt and IV from the stored row (base64).
          const d = await derive(impl, c.email, c.password, fromBase64(row.kdf_salt));
          expect(d.master).toBe(c.master_hex);
          expect(d.authSecret).toBe(c.auth_secret);
          expect(c.auth_secret).toMatch(/^[0-9a-f]{64}$/);
          expect(toHex(d.kek)).toBe(c.kek_hex);
          expect(toHex(fromBase64(row.kdf_salt))).toBe(c.kdf_salt_hex);
          expect(toHex(fromBase64(row.wrap_iv))).toBe(c.wrap_iv_hex);
          expect(row.user_id).toBe(c.user_id);
          expect(c.aad).toBe(keyWrapAad(c.user_id));

          const wrapped = await impl.wrap(d.kek, fromBase64(row.wrap_iv), keyWrapAad(row.user_id), PKCS8);
          expect(toHex(wrapped)).toBe(c.wrap_ciphertext_hex + c.wrap_tag_hex);
          expect(toBase64(wrapped)).toBe(row.wrapped_private_key);
          const opened = await impl.unwrap(d.kek, fromBase64(row.wrap_iv), keyWrapAad(row.user_id), fromBase64(row.wrapped_private_key));
          expect(toHex(opened)).toBe(V.private_key.pkcs8_hex);
        },
        SLOW,
      );
    }
  });
}

describe("password v1 vectors: the stored form is key-wrap.ts's", () => {
  it("the row has the columns key-wrap.ts reads, within the migration's checks", () => {
    const sql = readFileSync(path.join(process.cwd(), "supabase", "migrations", "20261106120000_mail_encryption_keys.sql"), "utf8");
    expect(sql).toMatch(/key_id\s+text not null check \(key_id ~ '\^\[0-9a-f\]\{32\}\$'\)/);
    expect(sql).toMatch(/public_key\s+text not null check \(length\(public_key\) = 88\)/);
    expect(sql).toMatch(/wrapped_private_key\s+text not null,/);
    expect(sql).toMatch(/wrap_iv\s+text not null check \(length\(wrap_iv\) = 16\)/);
    expect(sql).toMatch(/kdf_salt\s+text not null check \(length\(kdf_salt\) = 24\)/);
    expect(sql).toMatch(/kdf_iterations\s+integer not null check \(kdf_iterations >= 600000\)/);
    for (const c of V.cases) {
      const row = c.user_keys_row;
      const wrappedKey: WrappedKey = row;
      expect(Object.keys(row).sort()).toEqual(["kdf_iterations", "kdf_salt", "key_id", "public_key", "user_id", "wrap_iv", "wrapped_private_key"]);
      expect(row.key_id).toMatch(/^[0-9a-f]{32}$/);
      expect(row.public_key).toHaveLength(88);
      expect(row.wrap_iv).toHaveLength(16);
      expect(row.kdf_salt).toHaveLength(24);
      expect(wrappedKey.kdf_iterations).toBe(KDF_ITERATIONS);
      // Standard base64 with padding (fromBase64 refuses anything else), the 16-byte tag after the ciphertext.
      expect(fromBase64(row.wrap_iv)).toHaveLength(12);
      expect(fromBase64(row.kdf_salt)).toHaveLength(16);
      expect(fromBase64(row.wrapped_private_key)).toHaveLength(PKCS8.length + 16);
      expect(row.public_key).toBe(toBase64(fromHex(V.private_key.public_key_hex)));
      expect(row.key_id).toBe(V.private_key.key_id);
    }
  });

  it(
    "key-wrap.ts lays out its wrap the same way: given its own KEK, the wrap here gives its bytes, and its opener reads ours",
    async () => {
      const c = pick("ascii");
      const salt = fromHex(c.kdf_salt_hex);
      const iv = fromHex(c.wrap_iv_hex);
      const passphrase = "a passphrase for the layout check";
      const theirs = await wrapPrivateKey(PKCS8, passphrase, c.user_id, { salt, iv });
      // key-wrap.ts's KEK: PBKDF2-SHA256 of the NFKC passphrase with kdf_salt. Only this part differs in password v1.
      const theirKek = new Uint8Array(pbkdf2Sync(utf8(passphrase.normalize("NFKC")), salt, KDF_ITERATIONS, 32, "sha256"));
      const ours = await nodeCrypto.wrap(theirKek, iv, c.aad, PKCS8);
      expect(toBase64(ours)).toBe(theirs.wrapped_private_key);
      expect({ wrap_iv: theirs.wrap_iv, kdf_salt: theirs.kdf_salt, kdf_iterations: theirs.kdf_iterations }).toEqual({
        wrap_iv: c.user_keys_row.wrap_iv,
        kdf_salt: c.user_keys_row.kdf_salt,
        kdf_iterations: c.user_keys_row.kdf_iterations,
      });
      const ourRow: WrappedKey = { wrapped_private_key: toBase64(ours), wrap_iv: toBase64(iv), kdf_salt: toBase64(salt), kdf_iterations: KDF_ITERATIONS };
      expect(equalBytes(await unwrapPrivateKeyBytes(ourRow, passphrase, c.user_id), PKCS8)).toBe(true);
    },
    SLOW,
  );

  // key-wrap.ts has no opener that takes a KEK: unwrapPrivateKeyBytes and openStoredKey take the
  // passphrase and make the KEK inside. So the wrapped key is opened here with WebCrypto, and the
  // checks openStoredKey makes after opening are made here too.
  it("every wrapped key opens with its KEK alone and is the pair of the stored public key", async () => {
    for (const c of V.cases) {
      const row = c.user_keys_row;
      const pkcs8 = await webCrypto.unwrap(fromHex(c.kek_hex), fromBase64(row.wrap_iv), keyWrapAad(row.user_id), fromBase64(row.wrapped_private_key));
      expect(equalBytes(pkcs8, PKCS8), c.name).toBe(true);
      const key = await subtle.importKey("pkcs8", pkcs8, { name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
      expect(equalBytes(await publicKeyOf(key), fromBase64(row.public_key)), c.name).toBe(true);
      expect(await keyIdOf(fromBase64(row.public_key)), c.name).toBe(row.key_id);
    }
  });

  it("the private key is the one the file describes", async () => {
    const key = await subtle.importKey("pkcs8", PKCS8, { name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
    const jwk = await subtle.exportKey("jwk", key);
    expect(Buffer.from(jwk.d!, "base64url").toString("hex")).toBe(V.private_key.d_hex);
    expect(toHex(await publicKeyOf(key))).toBe(V.private_key.public_key_hex);
    expect(await keyIdOf(fromHex(V.private_key.public_key_hex))).toBe(V.private_key.key_id);
  });
});

describe("password v1 vectors: the spec's claims", () => {
  it(
    "the same email_norm and password give the same master and auth_secret; kdf_salt changes only the KEK",
    () => {
      const same = ["ascii", "email_uppercase", "email_surrounding_whitespace"].map(pick);
      expect(new Set(same.map((c) => c.master_hex)).size).toBe(1);
      expect(new Set(same.map((c) => c.auth_secret)).size).toBe(1);
      expect(new Set(same.map((c) => c.kek_hex)).size).toBe(3);
      expect(new Set(V.cases.map((c) => c.auth_secret)).size).toBe(V.cases.length - 2);
      for (const c of V.cases) expect(c.auth_secret, c.name).not.toBe(c.kek_hex);
    },
  );

  it(
    "HKDF with an empty salt is HKDF with 32 zero bytes (an API that needs a salt may be given either)",
    async () => {
      const c = pick("ascii");
      for (const impl of [nodeCrypto, webCrypto]) {
        expect(toHex(await impl.hkdf(fromHex(c.master_hex), new Uint8Array(0), AUTH_INFO)), impl.name).toBe(c.auth_secret);
        expect(toHex(await impl.hkdf(fromHex(c.master_hex), new Uint8Array(32), AUTH_INFO)), impl.name).toBe(c.auth_secret);
      }
    },
  );
});

describe("password v1 vectors: negative controls", () => {
  for (const impl of [nodeCrypto, webCrypto]) {
    it(
      `${impl.name}: one changed password character changes master, auth_secret and KEK`,
      async () => {
        const c = pick("ascii");
        expect(c.password).toBe("Tr0ub4dor&3");
        const d = await derive(impl, c.email, "Tr0ub4dor&4", fromHex(c.kdf_salt_hex));
        expect(d.master).not.toBe(c.master_hex);
        expect(d.authSecret).not.toBe(c.auth_secret);
        expect(toHex(d.kek)).not.toBe(c.kek_hex);
      },
      SLOW,
    );

    it(
      `${impl.name}: another letter case in the address gives the same values`,
      async () => {
        const c = pick("ascii");
        const d = await derive(impl, "USER@EXAMPLE.TEST", c.password, fromHex(c.kdf_salt_hex));
        expect(d.master).toBe(c.master_hex);
        expect(d.authSecret).toBe(c.auth_secret);
        expect(toHex(d.kek)).toBe(c.kek_hex);
      },
      SLOW,
    );

    it(
      `${impl.name}: another kdf_salt gives another KEK and the same auth_secret`,
      async () => {
        const c = pick("ascii");
        const salt = fromHex(c.kdf_salt_hex);
        salt[0] ^= 0x01;
        const d = await derive(impl, c.email, c.password, salt);
        expect(d.authSecret).toBe(c.auth_secret);
        expect(toHex(d.kek)).not.toBe(c.kek_hex);
        await expect(impl.unwrap(d.kek, fromHex(c.wrap_iv_hex), c.aad, fromBase64(c.user_keys_row.wrapped_private_key))).rejects.toThrow();
      },
      SLOW,
    );

    it(
      `${impl.name}: trimming the password, or trimming non-ASCII spaces off the address, gives another result`,
      async () => {
        const spaced = pick("password_surrounding_spaces");
        const ascii = pick("ascii");
        const trimmed = toHex(await impl.master(spaced.password_norm.trim(), spaced.email_norm));
        expect(trimmed).not.toBe(spaced.master_hex);
        expect(trimmed).toBe(ascii.master_hex);
        const nbsp = pick("email_non_ascii_whitespace");
        expect(nbsp.master_hex).not.toBe(ascii.master_hex);
        expect(toHex(await impl.master(nbsp.password_norm, nbsp.email.trim()))).toBe(ascii.master_hex);
      },
      SLOW,
    );

    it(`${impl.name}: another user_id in the AAD, or a changed tag byte, does not open`, async () => {
      for (const c of V.cases) {
        const row = c.user_keys_row;
        const kek = fromHex(c.kek_hex);
        const iv = fromBase64(row.wrap_iv);
        const wrapped = fromBase64(row.wrapped_private_key);
        await expect(impl.unwrap(kek, iv, keyWrapAad(OTHER_USER), wrapped), c.name).rejects.toThrow();
        const changed = new Uint8Array(wrapped);
        changed[changed.length - 1] ^= 0x01;
        await expect(impl.unwrap(kek, iv, c.aad, changed), c.name).rejects.toThrow();
        // Positive control: the same call with the right AAD and bytes opens.
        expect(toHex(await impl.unwrap(kek, iv, c.aad, wrapped)), c.name).toBe(V.private_key.pkcs8_hex);
      }
    });
  }
});
