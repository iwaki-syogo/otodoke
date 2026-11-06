/**
 * Write the fixed test vectors for password v1 (fixtures/crypto/password-v1.json). Spec:
 * docs/crypto/password-v1.md. From the password, a client makes the login secret it sends to
 * Supabase Auth (auth_secret) and the key that wraps the private key (KEK). The web tests
 * (src/lib/__tests__/password-v1-vectors.test.ts) and the iOS app recompute every value byte for byte.
 *
 * Every input is fixed here (no randomness), so writing again gives the same file. The private
 * key, the salts and the IVs are made from fixed labels; they are made up and protect nothing.
 *
 *   npx tsx scripts/crypto-password-v1-vectors.ts           # write the file
 *   npx tsx scripts/crypto-password-v1-vectors.ts --check   # check the file is what this script writes
 */
import { createCipheriv, createECDH, createHash, createPrivateKey, hkdfSync, pbkdf2Sync } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { toBase64 } from "../src/lib/crypto/bytes";
import { keyWrapAad } from "../src/lib/crypto/key-wrap";

const FILE = path.join(process.cwd(), "fixtures", "crypto", "password-v1.json");

// ---- The constants of password v1 (docs/crypto/password-v1.md) -------------------------------

const SALT_PW_PREFIX = "otodoke/pw/v1|";
const PBKDF2_ITERATIONS = 600_000;
const AUTH_INFO = "otodoke/auth/v1";
const KEK_INFO = "otodoke/kek/v1";
/** WHATWG "ASCII whitespace": the only code points removed from the ends of the address. */
const EMAIL_TRIM = [0x09, 0x0a, 0x0c, 0x0d, 0x20];

/** Ends trimmed by EMAIL_TRIM, then A-Z to a-z. Every other code point is kept as it is. */
function emailNorm(email: string): string {
  const points = [...email];
  let start = 0;
  let end = points.length;
  while (start < end && EMAIL_TRIM.includes(points[start].codePointAt(0)!)) start++;
  while (end > start && EMAIL_TRIM.includes(points[end - 1].codePointAt(0)!)) end--;
  return points
    .slice(start, end)
    .map((p) => {
      const cp = p.codePointAt(0)!;
      return cp >= 0x41 && cp <= 0x5a ? String.fromCodePoint(cp + 0x20) : p;
    })
    .join("");
}

function hkdf(ikm: Buffer, salt: Buffer, info: string): Buffer {
  return Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from(info, "utf8"), 32));
}

// ---- Fixed inputs ---------------------------------------------------------------------------

const LABEL = "otodoke/pw/v1 vectors|";

/** The first n bytes of SHA-256(UTF-8(LABEL + label)). */
function fixedBytes(label: string, n: number): Buffer {
  return createHash("sha256").update(LABEL + label, "utf8").digest().subarray(0, n);
}

const P256_ORDER = BigInt("0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551");

/** One made-up P-256 key, wrapped in every case: d = SHA-256(UTF-8(LABEL + "private key")). */
function fixedKey() {
  const d = fixedBytes("private key", 32);
  const scalar = BigInt("0x" + d.toString("hex"));
  if (scalar === BigInt(0) || scalar >= P256_ORDER) throw new Error("the label does not give a P-256 private key");
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(d);
  const publicKey = ecdh.getPublicKey(); // 65 bytes, uncompressed
  const jwk = { kty: "EC", crv: "P-256", d: d.toString("base64url"), x: publicKey.subarray(1, 33).toString("base64url"), y: publicKey.subarray(33).toString("base64url") };
  const pkcs8 = createPrivateKey({ key: jwk, format: "jwk" }).export({ type: "pkcs8", format: "der" });
  const keyId = createHash("sha256").update(publicKey).digest().subarray(0, 16).toString("hex");
  return { d, publicKey, pkcs8, keyId };
}

type FixedKey = ReturnType<typeof fixedKey>;

interface CaseInput {
  name: string;
  note: string;
  email: string;
  password: string;
}

const EMAIL = "user@example.test";
const PASSWORD = "Tr0ub4dor&3";

const CASES: CaseInput[] = [
  { name: "ascii", note: "ASCII address and password. Nothing changes.", email: EMAIL, password: PASSWORD },
  {
    name: "password_halfwidth_katakana",
    note: "Half-width katakana with voiced sound marks. NFKC maps U+FF83 U+FF9E to U+30C6 U+3099 and then composes them into one code point, U+30C7. Foundation's precomposedStringWithCompatibilityMapping leaves U+30C6 U+3099 (see the spec).",
    email: EMAIL,
    password: "ﾃﾞｼﾞﾀﾙ",
  },
  { name: "password_fullwidth_alnum", note: "Full-width letters and digits become ASCII. Letter case is kept.", email: EMAIL, password: "Ｐａｓｓ１２３" },
  { name: "password_combining_mark", note: "e followed by U+0301 COMBINING ACUTE ACCENT is composed into U+00E9.", email: EMAIL, password: "café" },
  {
    name: "password_compatibility_chars",
    note: "U+2460 CIRCLED DIGIT ONE becomes 1. U+337B SQUARE ERA NAME HEISEI becomes two ideographs, U+5E73 U+6210.",
    email: EMAIL,
    password: "①㍻",
  },
  {
    name: "password_surrounding_spaces",
    note: "A space and U+3000 IDEOGRAPHIC SPACE before, a space after. NFKC turns U+3000 into U+0020. Nothing is trimmed: all three spaces stay.",
    email: EMAIL,
    password: " 　" + PASSWORD + " ",
  },
  { name: "email_uppercase", note: "A-Z in the address become a-z. Same email_norm and password as ascii, so the same master and auth_secret.", email: "User@Example.TEST", password: PASSWORD },
  {
    name: "email_surrounding_whitespace",
    note: "All five trimmed code points (U+0020 U+0009 U+000A U+000C U+000D) before the address, four after. All are removed. Same master and auth_secret as ascii.",
    email: " \t\n\f\r" + EMAIL + "\r\n\t ",
    password: PASSWORD,
  },
  {
    name: "email_non_ascii_whitespace",
    note: "U+3000 before and U+00A0 after the address are not in the trim set, so they stay and the result differs from ascii. String.prototype.trim() and Swift's trimmingCharacters(in: .whitespaces) would remove them.",
    email: "　" + EMAIL + " ",
    password: PASSWORD,
  },
  {
    name: "email_dotted_capital_i",
    note: "U+0130 LATIN CAPITAL LETTER I WITH DOT ABOVE stays as it is; only A-Z change, and ASCII I becomes i (not U+0131). toLowerCase() would give U+0069 U+0307; the Turkish locale would give i and U+0131.",
    email: "İSTANBUL.IZMIR@EXAMPLE.TEST",
    password: PASSWORD,
  },
];

function vectorCase(input: CaseInput, index: number, key: FixedKey) {
  const email_norm = emailNorm(input.email);
  const saltPw = Buffer.from(SALT_PW_PREFIX + email_norm, "utf8");
  const password_norm = input.password.normalize("NFKC");
  const passwordBytes = Buffer.from(password_norm, "utf8");
  const master = pbkdf2Sync(passwordBytes, saltPw, PBKDF2_ITERATIONS, 32, "sha256");
  const authSecret = hkdf(master, Buffer.alloc(0), AUTH_INFO).toString("hex");

  const user_id = `00000000-0000-4000-8000-0000000001${String(index + 1).padStart(2, "0")}`;
  const kdfSalt = fixedBytes(`${input.name}|kdf_salt`, 16);
  const kek = hkdf(master, kdfSalt, KEK_INFO);
  const aad = keyWrapAad(user_id);
  const iv = fixedBytes(`${input.name}|wrap_iv`, 12);
  const cipher = createCipheriv("aes-256-gcm", kek, iv, { authTagLength: 16 });
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(key.pkcs8), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    name: input.name,
    note: input.note,
    email: input.email,
    password: input.password,
    email_norm,
    salt_pw_hex: saltPw.toString("hex"),
    password_norm,
    password_norm_utf8_hex: passwordBytes.toString("hex"),
    master_hex: master.toString("hex"),
    auth_secret: authSecret,
    user_id,
    kdf_salt_hex: kdfSalt.toString("hex"),
    kek_hex: kek.toString("hex"),
    aad,
    wrap_iv_hex: iv.toString("hex"),
    wrap_ciphertext_hex: ciphertext.toString("hex"),
    wrap_tag_hex: tag.toString("hex"),
    user_keys_row: {
      user_id,
      key_id: key.keyId,
      public_key: toBase64(key.publicKey),
      wrapped_private_key: toBase64(Buffer.concat([ciphertext, tag])),
      wrap_iv: toBase64(iv),
      kdf_salt: toBase64(kdfSalt),
      kdf_iterations: PBKDF2_ITERATIONS,
    },
  };
}

function build() {
  const key = fixedKey();
  return {
    format: "otodoke password v1: the login secret (auth_secret) and the key-encryption key (KEK) made from the password, and the private key wrapped with that KEK. Made-up values for tests; they protect nothing.",
    spec: "docs/crypto/password-v1.md",
    written_by: "scripts/crypto-password-v1-vectors.ts",
    encoding:
      "Fields ending in _hex are bytes as lowercase hex. auth_secret is the 64-character text sent as the password. user_keys_row is the row exactly as stored: standard base64 with padding. In email, password, email_norm and password_norm every character outside U+0021-U+007E (spaces included) is written as a \\u escape.",
    constants: {
      email_trim_code_points: EMAIL_TRIM.map((cp) => `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`),
      salt_pw_prefix: SALT_PW_PREFIX,
      password_normalization: "NFKC",
      pbkdf2: { prf: "HMAC-SHA256", iterations: PBKDF2_ITERATIONS, length: 32 },
      hkdf_hash: "SHA-256",
      auth_salt_hex: "",
      auth_info: AUTH_INFO,
      auth_length: 32,
      kek_info: KEK_INFO,
      kek_length: 32,
      kdf_salt_length: 16,
      wrap: { cipher: "AES-256-GCM", iv_length: 12, tag_length: 16, aad_prefix: keyWrapAad(""), layout: "ciphertext || tag" },
    },
    private_key: {
      note: "One made-up P-256 key, wrapped in every case. d = SHA-256(UTF-8(\"otodoke/pw/v1 vectors|private key\")). pkcs8 is the plaintext that is wrapped.",
      d_hex: key.d.toString("hex"),
      pkcs8_hex: key.pkcs8.toString("hex"),
      public_key_hex: key.publicKey.toString("hex"),
      key_id: key.keyId,
    },
    cases: CASES.map((c, i) => vectorCase(c, i, key)),
  };
}

// ---- JSON with every confusing character escaped --------------------------------------------

/** Strings that are inputs or their normal forms: even spaces are escaped, so nothing is mistaken by eye. */
const STRICT_KEYS = new Set(["email", "password", "email_norm", "password_norm"]);

function quote(text: string, strict: boolean): string {
  let out = '"';
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if ((cp >= 0x21 && cp <= 0x7e) || (cp === 0x20 && !strict)) out += ch;
    else for (let i = 0; i < ch.length; i++) out += "\\u" + ch.charCodeAt(i).toString(16).toUpperCase().padStart(4, "0");
  }
  return out + '"';
}

function toJson(value: unknown, indent = "", key?: string): string {
  if (typeof value === "string") return quote(value, key !== undefined && STRICT_KEYS.has(key));
  if (typeof value === "number" || typeof value === "boolean" || value === null) return JSON.stringify(value);
  const inner = indent + "  ";
  if (Array.isArray(value)) return value.length ? `[\n${value.map((v) => inner + toJson(v, inner)).join(",\n")}\n${indent}]` : "[]";
  const entries = Object.entries(value as Record<string, unknown>);
  return entries.length ? `{\n${entries.map(([k, v]) => `${inner}${quote(k, false)}: ${toJson(v, inner, k)}`).join(",\n")}\n${indent}}` : "{}";
}

async function main() {
  const vectors = build();
  const text = toJson(vectors) + "\n";
  if (JSON.stringify(JSON.parse(text)) !== JSON.stringify(vectors)) throw new Error("the escaped JSON does not read back to the same values");
  if (process.argv.includes("--check")) {
    const saved = await readFile(FILE, "utf8");
    const same = saved === text;
    console.log(same ? `vectors reproduce (${vectors.cases.length} cases)` : "vectors DIFFER");
    if (!same) process.exit(1);
    return;
  }
  await mkdir(path.dirname(FILE), { recursive: true });
  await writeFile(FILE, text);
  console.log(`wrote ${path.relative(process.cwd(), FILE)} (${vectors.cases.length} cases)`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
