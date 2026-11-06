/**
 * password v1 (docs/crypto/password-v1.md): from the one login password, two values that have
 * nothing to do with each other. Runs in the browser, WebCrypto only: the password, master and the
 * KEK never leave it. Only auth_secret is sent, as the account's password for Supabase Auth.
 *
 *   email_norm   the address with only U+0009 U+000A U+000C U+000D U+0020 taken off its ends, then A-Z made a-z
 *   master       PBKDF2-HMAC-SHA256(UTF-8(NFKC(password)), UTF-8("otodoke/pw/v1|" + email_norm), 600,000 rounds, 32 bytes)
 *   auth_secret  lowercase hex of HKDF-SHA256(master, salt = empty, info = "otodoke/auth/v1", 32 bytes)
 *   KEK          HKDF-SHA256(master, salt = the row's kdf_salt (16 bytes), info = "otodoke/kek/v1") as an AES-256-GCM key
 *
 * The KEK wraps and opens the private key with key-wrap.ts (wrapPrivateKeyWithKek, createWrappedKey,
 * openStoredKeyWithKek, rewrapStoredKey): the same wrap and stored form as the passphrase's.
 * The iOS app makes the same values: fixtures/crypto/password-v1.json, checked byte for byte.
 *
 * master and the KEK are CryptoKeys that cannot be exported; the bytes made on the way are zeroed
 * once used. Server code must not import this file (src/lib/__tests__/passphrase-stays-in-browser.test.ts).
 */
import { fromBase64, randomBytes, toBase64, toHex, utf8, type Bytes } from "./bytes";

/** PBKDF2 rounds of master. Fixed by this version: never read from the user_keys row (step 4). */
export const PASSWORD_V1_ITERATIONS = 600_000;
/** Bytes of a kdf_salt (the HKDF salt of the KEK). */
export const KDF_SALT_BYTES = 16;

const SALT_PW_PREFIX = "otodoke/pw/v1|";
const AUTH_INFO = "otodoke/auth/v1";
const KEK_INFO = "otodoke/kek/v1";
/** WHATWG "ASCII whitespace": the only code points taken off the ends of the address. */
const EMAIL_TRIM = new Set([0x09, 0x0a, 0x0c, 0x0d, 0x20]);

/**
 * The address as password v1 uses it (step 1). Not trim() or toLowerCase(): they change other
 * characters too, and not the same ones on every platform. Nothing is checked here.
 */
export function emailNorm(email: string): string {
  const points = [...email]; // code points, not UTF-16 code units
  let start = 0;
  let end = points.length;
  while (start < end && EMAIL_TRIM.has(points[start].codePointAt(0)!)) start++;
  while (end > start && EMAIL_TRIM.has(points[end - 1].codePointAt(0)!)) end--;
  let out = "";
  for (const p of points.slice(start, end)) {
    const cp = p.codePointAt(0)!;
    out += cp >= 0x41 && cp <= 0x5a ? String.fromCodePoint(cp + 0x20) : p;
  }
  return out;
}

/** NFKC, nothing trimmed, letter case kept (step 3). */
export function normalizePassword(password: string): string {
  return password.normalize("NFKC");
}

/**
 * master (step 4), as an HKDF key that cannot be exported. Takes the address and the password as
 * typed. 600,000 PBKDF2 rounds: make it once per sign-in and use it for both auth_secret and the KEK.
 */
export async function deriveMaster(email: string, password: string): Promise<CryptoKey> {
  const secret = utf8(normalizePassword(password));
  let bits: Bytes | null = null;
  try {
    const base = await crypto.subtle.importKey("raw", secret, "PBKDF2", false, ["deriveBits"]);
    secret.fill(0); // importKey has its own copy
    const salt = utf8(SALT_PW_PREFIX + emailNorm(email));
    bits = new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: PASSWORD_V1_ITERATIONS }, base, 256));
    return await crypto.subtle.importKey("raw", bits, "HKDF", false, ["deriveBits", "deriveKey"]);
  } finally {
    secret.fill(0);
    bits?.fill(0);
  }
}

/** auth_secret (step 5): the 64 lowercase hex characters given to Supabase Auth as the password. */
export async function authSecretHex(master: CryptoKey): Promise<string> {
  const bits = new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: utf8(AUTH_INFO) }, master, 256));
  try {
    return toHex(bits);
  } finally {
    bits.fill(0);
  }
}

/**
 * The KEK (step 6) for the row's kdf_salt (base64 of 16 bytes), as an AES-256-GCM key that cannot
 * be exported, for encrypt and decrypt like key-wrap.ts's. Opening: kekFor(master, row.kdf_salt).
 * A new wrap: a new salt from newKdfSalt(), and that same salt stored with the wrap.
 */
export async function kekFor(master: CryptoKey, kdfSaltBase64: string): Promise<CryptoKey> {
  const salt = fromBase64(kdfSaltBase64);
  if (salt.length !== KDF_SALT_BYTES) throw new Error("bad salt");
  return crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt, info: utf8(KEK_INFO) }, master, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

/** A new kdf_salt for a new wrap: base64 of 16 random bytes. Every wrap makes its own. */
export function newKdfSalt(): string {
  return toBase64(randomBytes(KDF_SALT_BYTES));
}

// ---- The rule for a new password -------------------------------------------------------------
//
// The same rule as the passphrase's (key-wrap.ts PASSPHRASE_RULE, isWeakPassphrase,
// passphraseProblem), in the words of a password. A copy while the passphrase screens remain; the
// passphrase's goes with them. src/lib/__tests__/password-v1.test.ts checks both give the same answers.

export const PASSWORD_MIN_LENGTH = 10;

/** The rule as the screen states it, next to the fields. */
export const PASSWORD_RULE = `${PASSWORD_MIN_LENGTH} 文字以上。同じ文字のくり返し、1234… や abcd… のような連番、password のようなよくある言葉と数字だけの組み合わせは使えません。`;

/**
 * Words people pick first. The wrapped key (and auth_secret) can be tried offline by anyone who
 * gets them, so a password that is only one of these (plus digits or symbols) is refused. Kept
 * short on purpose: the rule must stay simple enough to state in one line on the screen.
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

/** Too easy to guess, by the rule in PASSWORD_RULE. Input is the normalized password. */
export function isWeakPassword(normalized: string): boolean {
  const lower = normalized.toLowerCase();
  const chars = [...lower];
  if (chars.length < 2 || isRepetition(chars) || isSequence(chars)) return true;
  // A common word with only digits, spaces or symbols around it ("password1234", "qwerty!!!!").
  const letters = lower.replace(/[\d\s\p{P}\p{S}]/gu, "");
  return COMMON_WORDS.has(letters);
}

/** What is wrong with a new password, in words for the screen, or null when it is fine. */
export function passwordProblem(password: string, again: string): string | null {
  const p = normalizePassword(password);
  if ([...p].length < PASSWORD_MIN_LENGTH) return `${PASSWORD_MIN_LENGTH} 文字以上にしてください`;
  if (isWeakPassword(p)) return "推測されやすいパスワードです。同じ文字のくり返し・連番・よくある言葉は避けてください";
  if (p !== normalizePassword(again)) return "2 回の入力が違います";
  return null;
}
