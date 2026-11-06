import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fromBase64, toBase64, toHex, utf8, type Bytes } from "@/lib/crypto/bytes";
import { challengeAad, openBytes, sealBytes } from "@/lib/crypto/envelope";
import {
  createWrappedKey,
  isWeakPassphrase,
  KDF_ITERATIONS,
  normalizePassphrase,
  openStoredKeyWithKek,
  PASSPHRASE_MIN_LENGTH,
  PASSPHRASE_RULE,
  passphraseProblem,
  rewrapStoredKey,
  wrapPrivateKeyWithKek,
  type StoredKey,
} from "@/lib/crypto/key-wrap";
import {
  authSecretHex,
  deriveMaster,
  emailNorm,
  isWeakPassword,
  KDF_SALT_BYTES,
  kekFor,
  newKdfSalt,
  normalizePassword,
  PASSWORD_MIN_LENGTH,
  PASSWORD_RULE,
  PASSWORD_V1_ITERATIONS,
  passwordProblem,
} from "@/lib/crypto/password-v1";

/**
 * src/lib/crypto/password-v1.ts against the fixed vectors shared with the iOS app
 * (fixtures/crypto/password-v1.json, docs/crypto/password-v1.md). For every case, the address and
 * the password as typed give the case's email_norm and auth_secret, and the KEK, which cannot be
 * exported, is checked by what it does: it wraps the vectors' private key into the case's bytes
 * exactly, and opens the case's stored row.
 */

interface Case {
  name: string;
  email: string;
  password: string;
  email_norm: string;
  password_norm_utf8_hex: string;
  auth_secret: string;
  user_id: string;
  wrap_ciphertext_hex: string;
  wrap_tag_hex: string;
  user_keys_row: StoredKey & { user_id: string };
}

const V = JSON.parse(readFileSync(path.join(process.cwd(), "fixtures", "crypto", "password-v1.json"), "utf8")) as {
  constants: { pbkdf2: { iterations: number }; kdf_salt_length: number };
  private_key: { pkcs8_hex: string; public_key_hex: string; key_id: string };
  cases: Case[];
};

const SLOW = 60_000;

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

/** The case's wrap made again with a KEK, with the case's IV. */
const wrapLikeTheCase = (c: Case, kek: CryptoKey) => wrapPrivateKeyWithKek(PKCS8, kek, c.user_keys_row.kdf_salt, c.user_id, { iv: fromBase64(c.user_keys_row.wrap_iv) });

afterEach(() => {
  vi.restoreAllMocks();
});

describe("password v1: every case of the vectors", () => {
  it("has the ten cases of the spec", () => {
    expect(V.cases).toHaveLength(10);
  });

  it("emailNorm gives each case's email_norm", () => {
    for (const c of V.cases) expect(emailNorm(c.email), c.name).toBe(c.email_norm);
  });

  for (const c of V.cases) {
    it(
      `${c.name}: auth_secret, and the KEK wraps the key into the case's bytes and opens the stored row`,
      async () => {
        const row = c.user_keys_row;
        const master = await deriveMaster(c.email, c.password);
        expect(await authSecretHex(master)).toBe(c.auth_secret);

        const kek = await kekFor(master, row.kdf_salt);
        const wrapped = await wrapLikeTheCase(c, kek);
        expect(toHex(fromBase64(wrapped.wrapped_private_key))).toBe(c.wrap_ciphertext_hex + c.wrap_tag_hex);
        expect(wrapped).toEqual({ wrapped_private_key: row.wrapped_private_key, wrap_iv: row.wrap_iv, kdf_salt: row.kdf_salt, kdf_iterations: row.kdf_iterations });

        const opened = await openStoredKeyWithKek(row, kek, row.user_id);
        expect(opened.keyId).toBe(V.private_key.key_id);
        expect(toHex(opened.publicKey)).toBe(V.private_key.public_key_hex);
        expect(opened.privateKey.extractable).toBe(false);
      },
      SLOW,
    );
  }

  it(
    "the key opened with the KEK is a working private key: it opens what was sealed to the stored public key",
    async () => {
      const c = pick("password_halfwidth_katakana");
      const kek = await kekFor(await deriveMaster(c.email, c.password), c.user_keys_row.kdf_salt);
      const recipient = await openStoredKeyWithKek(c.user_keys_row, kek, c.user_id);
      const challenge = utf8("a challenge for the vectors' key");
      const sealed = await sealBytes({ keyId: c.user_keys_row.key_id, publicKey: fromBase64(c.user_keys_row.public_key) }, challengeAad(c.user_id, c.user_keys_row.key_id), challenge);
      expect(toHex(await openBytes(recipient, challengeAad(c.user_id, c.user_keys_row.key_id), sealed))).toBe(toHex(challenge));
    },
    SLOW,
  );
});

describe("password v1: master and the KEK stay inside WebCrypto", () => {
  it(
    "master is an HKDF key and the KEK an AES-256-GCM key for encrypt and decrypt; neither can be exported",
    async () => {
      const c = pick("ascii");
      const master = await deriveMaster(c.email, c.password);
      expect({ type: master.type, extractable: master.extractable, algorithm: master.algorithm, usages: [...master.usages].sort() }).toEqual({
        type: "secret",
        extractable: false,
        algorithm: { name: "HKDF" },
        usages: ["deriveBits", "deriveKey"],
      });
      await expect(crypto.subtle.exportKey("raw", master)).rejects.toThrow();

      const kek = await kekFor(master, c.user_keys_row.kdf_salt);
      expect({ type: kek.type, extractable: kek.extractable, algorithm: kek.algorithm, usages: [...kek.usages].sort() }).toEqual({
        type: "secret",
        extractable: false,
        algorithm: { name: "AES-GCM", length: 256 },
        usages: ["decrypt", "encrypt"],
      });
      await expect(crypto.subtle.exportKey("raw", kek)).rejects.toThrow();
      await expect(crypto.subtle.exportKey("jwk", kek)).rejects.toThrow();
    },
    SLOW,
  );

  it(
    "the bytes made on the way are zeroed once used: the password's, master's and auth_secret's",
    async () => {
      const c = pick("ascii");
      const subtle = crypto.subtle;
      const realImport = subtle.importKey.bind(subtle) as (...args: unknown[]) => Promise<CryptoKey>;
      const realDeriveBits = subtle.deriveBits.bind(subtle) as (...args: unknown[]) => Promise<ArrayBuffer>;
      const imported: Uint8Array[] = [];
      const derived: ArrayBuffer[] = [];
      vi.spyOn(subtle, "importKey").mockImplementation(((...args: unknown[]) => {
        if (args[0] === "raw") imported.push(args[1] as Uint8Array);
        return realImport(...args);
      }) as never);
      vi.spyOn(subtle, "deriveBits").mockImplementation((async (...args: unknown[]) => {
        const out = await realDeriveBits(...args);
        derived.push(out);
        return out;
      }) as never);

      const master = await deriveMaster(c.email, c.password);
      const authSecret = await authSecretHex(master);
      vi.restoreAllMocks();

      // Zeroing after use did not change what was made.
      expect(authSecret).toBe(c.auth_secret);
      // PBKDF2's input (the password as UTF-8) and HKDF's (master), and the two outputs (master, auth_secret).
      expect(imported.map((b) => b.length)).toEqual([c.password_norm_utf8_hex.length / 2, 32]);
      for (const b of imported) expect([...b].every((x) => x === 0)).toBe(true);
      expect(derived.map((b) => b.byteLength)).toEqual([32, 32]);
      for (const b of derived) expect([...new Uint8Array(b)].every((x) => x === 0)).toBe(true);
    },
    SLOW,
  );
});

describe("password v1: negative controls", () => {
  it(
    "one changed password character, another letter case or a space around it changes auth_secret and the KEK",
    async () => {
      const c = pick("ascii");
      expect(c.password).toBe("Tr0ub4dor&3");
      for (const password of ["Tr0ub4dor&4", "tr0ub4dor&3", "Tr0ub4dor&3 ", " Tr0ub4dor&3"]) {
        const master = await deriveMaster(c.email, password);
        expect(await authSecretHex(master), password).not.toBe(c.auth_secret);
        const kek = await kekFor(master, c.user_keys_row.kdf_salt);
        expect((await wrapLikeTheCase(c, kek)).wrapped_private_key, password).not.toBe(c.user_keys_row.wrapped_private_key);
        await expect(openStoredKeyWithKek(c.user_keys_row, kek, c.user_id), password).rejects.toMatchObject({ name: "OperationError" });
      }
    },
    SLOW,
  );

  it(
    "another letter case in the address gives the same auth_secret and KEK",
    async () => {
      const c = pick("ascii");
      for (const email of ["USER@EXAMPLE.TEST", "User@example.Test", "  user@EXAMPLE.test\n"]) {
        const master = await deriveMaster(email, c.password);
        expect(await authSecretHex(master), email).toBe(c.auth_secret);
        const kek = await kekFor(master, c.user_keys_row.kdf_salt);
        expect((await wrapLikeTheCase(c, kek)).wrapped_private_key, email).toBe(c.user_keys_row.wrapped_private_key);
        await expect(openStoredKeyWithKek(c.user_keys_row, kek, c.user_id), email).resolves.toMatchObject({ keyId: c.user_keys_row.key_id });
      }
    },
    SLOW,
  );

  it(
    "positive control of NFKC: the password typed in full-width letters gives the ASCII one's values",
    async () => {
      const c = pick("ascii");
      const master = await deriveMaster(c.email, "Ｔｒ０ｕｂ４ｄｏｒ＆３");
      expect(await authSecretHex(master)).toBe(c.auth_secret);
    },
    SLOW,
  );

  it(
    "another kdf_salt gives another KEK, and the same auth_secret",
    async () => {
      const c = pick("ascii");
      const master = await deriveMaster(c.email, c.password);
      const salt = fromBase64(c.user_keys_row.kdf_salt);
      salt[0] ^= 0x01;
      const kek = await kekFor(master, toBase64(salt));
      expect(await authSecretHex(master)).toBe(c.auth_secret);
      await expect(openStoredKeyWithKek(c.user_keys_row, kek, c.user_id)).rejects.toMatchObject({ name: "OperationError" });
    },
    SLOW,
  );
});

describe("password v1 with key-wrap: a new key, then a change of password", () => {
  const USER = "00000000-0000-4000-8000-00000000000a";
  const EMAIL = "user@example.test";

  it(
    "made with the old password's KEK, wrapped again for the new one: opens with the new password only, the same key",
    async () => {
      const oldMaster = await deriveMaster(EMAIL, "うちの猫は三毛で7歳");
      const firstSalt = newKdfSalt();
      const created = await createWrappedKey(await kekFor(oldMaster, firstSalt), firstSalt, USER);
      const row: StoredKey = { key_id: created.keyId, public_key: toBase64(created.publicKey), ...created.wrapped };
      // What the browser does after reading the row back: the KEK made again from the stored salt.
      await expect(openStoredKeyWithKek(row, await kekFor(oldMaster, row.kdf_salt), USER)).resolves.toMatchObject({ keyId: created.keyId });

      const newMaster = await deriveMaster(EMAIL, "となりの犬は柴で3歳");
      expect(await authSecretHex(newMaster)).not.toBe(await authSecretHex(oldMaster));
      const salt = newKdfSalt();
      const w = await rewrapStoredKey(row, await kekFor(oldMaster, row.kdf_salt), await kekFor(newMaster, salt), salt, USER);
      const rewrapped = { ...row, ...w };
      // The check to make before sending the new wrap: the stored salt makes the new KEK again.
      const reopened = await openStoredKeyWithKek(rewrapped, await kekFor(newMaster, rewrapped.kdf_salt), USER);
      expect(reopened.keyId).toBe(created.keyId);
      expect(toBase64(reopened.publicKey)).toBe(row.public_key);
      await expect(openStoredKeyWithKek(rewrapped, await kekFor(oldMaster, rewrapped.kdf_salt), USER)).rejects.toMatchObject({ name: "OperationError" });
    },
    SLOW,
  );

  it(
    "negative control: a KEK made with another salt than the one stored is caught by that check, not by the rewrap",
    async () => {
      const master = await deriveMaster(EMAIL, "うちの猫は三毛で7歳");
      const firstSalt = newKdfSalt();
      const kek = await kekFor(master, firstSalt);
      const created = await createWrappedKey(kek, firstSalt, USER);
      const row: StoredKey = { key_id: created.keyId, public_key: toBase64(created.publicKey), ...created.wrapped };
      const newMaster = await deriveMaster(EMAIL, "となりの犬は柴で3歳");
      const [madeWith, stored] = [newKdfSalt(), newKdfSalt()];
      const w = await rewrapStoredKey(row, kek, await kekFor(newMaster, madeWith), stored, USER);
      expect(w.kdf_salt).toBe(stored);
      await expect(openStoredKeyWithKek({ ...row, ...w }, await kekFor(newMaster, w.kdf_salt), USER)).rejects.toMatchObject({ name: "OperationError" });
    },
    SLOW,
  );
});

describe("emailNorm", () => {
  it("takes only U+0009 U+000A U+000C U+000D U+0020 off the ends, and maps only A-Z", () => {
    expect(emailNorm("")).toBe("");
    expect(emailNorm(" \t\n\f\r")).toBe("");
    // Other whitespace is kept, and so is what follows it.
    expect(emailNorm("\u000b user@example.test")).toBe("\u000b user@example.test");
    expect(emailNorm("user@example.test\u0085")).toBe("user@example.test\u0085");
    expect(emailNorm("﻿user@example.test")).toBe("﻿user@example.test");
    expect(emailNorm(" User@Example.TEST　")).toBe(" user@example.test　");
    // Spaces inside stay.
    expect(emailNorm(" A B@C.TEST ")).toBe("a b@c.test");
    // Only A-Z: not À, the Kelvin sign or a mathematical A, which Unicode case mapping would change.
    expect(emailNorm("ÀÉ@ÄÖ.TEST")).toBe("ÀÉ@ÄÖ.test");
    expect(emailNorm("KELVINK@EXAMPLE.TEST")).toBe("kelvinK@example.test");
    expect(emailNorm("\u{1d400}A@example.test")).toBe("\u{1d400}a@example.test");
  });

  it("negative control: trim() and toLowerCase() give other results on the same inputs", () => {
    expect(" User@Example.TEST　".trim().toLowerCase()).not.toBe(emailNorm(" User@Example.TEST　"));
    expect("KELVINK@EXAMPLE.TEST".toLowerCase()).not.toBe(emailNorm("KELVINK@EXAMPLE.TEST"));
  });
});

describe("password v1: the constants and kekFor's input", () => {
  it("the round count is the spec's, and the count a stored row records", () => {
    expect(PASSWORD_V1_ITERATIONS).toBe(V.constants.pbkdf2.iterations);
    expect(PASSWORD_V1_ITERATIONS).toBe(KDF_ITERATIONS);
    expect(KDF_SALT_BYTES).toBe(V.constants.kdf_salt_length);
  });

  it(
    "kekFor takes only a 16-byte kdf_salt in standard base64; newKdfSalt makes a new one each time",
    async () => {
      const c = pick("ascii");
      const master = await deriveMaster(c.email, c.password);
      await expect(kekFor(master, toBase64(new Uint8Array(15)))).rejects.toThrow("bad salt");
      await expect(kekFor(master, toBase64(new Uint8Array(32)))).rejects.toThrow("bad salt");
      await expect(kekFor(master, "AAAAAAAAAAAAAAAAAAAAAA")).rejects.toThrow("base64"); // padding left out
      await expect(kekFor(master, "-AAAAAAAAAAAAAAAAAAAAA==")).rejects.toThrow("base64"); // base64url
      // Positive control: the row's salt.
      await expect(kekFor(master, c.user_keys_row.kdf_salt)).resolves.toBeTruthy();

      const salts = new Set(Array.from({ length: 20 }, () => newKdfSalt()));
      expect(salts.size).toBe(20);
      for (const s of salts) {
        expect(s).toHaveLength(24);
        expect(fromBase64(s)).toHaveLength(16);
      }
    },
    SLOW,
  );
});

describe("the rule for a new password is the passphrase's, in the words of a password", () => {
  // The inputs of passphrase-strength.test.ts, and more around the edges.
  const inputs = [
    "aaaaaaaaaa",
    "ああああああああああ",
    "1212121212",
    "abcabcabcabc",
    "ＡＡＡＡＡＡＡＡＡＡ",
    "1234567890",
    "0987654321",
    "abcdefghijk",
    "zyxwvutsrqp",
    "2345678901",
    "password1234",
    "Password!!!!",
    "qwerty123456",
    "iloveyou2026",
    "1234otodoke",
    "password 1234",
    "aikotoba2026!",
    "テスト用の合言葉です1234",
    "うちの猫は三毛で7歳",
    "correct horse battery",
    "ka9-Fm2!pq",
    "password と猫と 2026 年の春",
    "Tr0ub4dor&3",
    "Ｔｒ０ｕｂ４ｄｏｒ＆３ｘｘ",
    "ﾃﾞｼﾞﾀﾙﾃﾞｼﾞﾀﾙ",
    "123456789",
    "短い",
    "",
    "a",
    "ab",
    "  ",
  ];

  it("isWeakPassword answers as isWeakPassphrase on every input", () => {
    for (const p of inputs) expect(isWeakPassword(normalizePassword(p)), p).toBe(isWeakPassphrase(normalizePassphrase(p)));
    expect(normalizePassword("ﾃﾞｼﾞﾀﾙ")).toBe(normalizePassphrase("ﾃﾞｼﾞﾀﾙ"));
  });

  it("passwordProblem says what passphraseProblem says, パスワード for 合言葉", () => {
    for (const a of inputs) {
      for (const b of [a, `${a}x`, normalizePassword(a)]) expect(passwordProblem(a, b), `${a} / ${b}`).toBe(passphraseProblem(a, b)?.replaceAll("合言葉", "パスワード") ?? null);
    }
  });

  it("the words: the rule as the screen states it, and each problem", () => {
    expect(PASSWORD_RULE).toBe(PASSPHRASE_RULE);
    expect(PASSWORD_MIN_LENGTH).toBe(PASSPHRASE_MIN_LENGTH);
    expect(passwordProblem("123", "123")).toBe("10 文字以上にしてください");
    expect(passwordProblem("1234567890", "1234567890")).toBe("推測されやすいパスワードです。同じ文字のくり返し・連番・よくある言葉は避けてください");
    expect(passwordProblem("うちの猫は三毛で7歳", "うちの猫は三毛で8歳")).toBe("2 回の入力が違います");
    expect(passwordProblem("うちの猫は三毛で7歳", "うちの猫は三毛で7歳")).toBeNull();
    for (const text of [PASSWORD_RULE, passwordProblem("123", "123"), passwordProblem("1234567890", "1234567890"), passwordProblem("うちの猫は三毛で7歳", "x")]) expect(text).not.toContain("合言葉");
  });

  it("negative control: the weak ones are refused and ordinary ones pass", () => {
    for (const p of ["aaaaaaaaaa", "1234567890", "password1234", "ＡＡＡＡＡＡＡＡＡＡ"]) expect(isWeakPassword(normalizePassword(p)), p).toBe(true);
    for (const p of ["うちの猫は三毛で7歳", "correct horse battery", "Tr0ub4dor&3"]) expect(isWeakPassword(normalizePassword(p)), p).toBe(false);
  });
});
