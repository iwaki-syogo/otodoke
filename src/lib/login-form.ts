/**
 * What the login forms accept: the address and the login secret. Pure functions (no request, no
 * Supabase), so the login screens can use them as well as the server.
 *
 * The browser never sends the password. It derives the login secret from it (password-v1: 64
 * lowercase hex characters, docs/crypto/password-v1.md) and sends only that; the server refuses
 * anything else in its place.
 */

/** The login secret of password-v1: lowercase hex of 32 bytes. Nothing else is accepted. */
export const AUTH_SECRET_PATTERN = /^[0-9a-f]{64}$/;

export function isAuthSecret(value: unknown): value is string {
  return typeof value === "string" && AUTH_SECRET_PATTERN.test(value);
}

/** The longest address SMTP allows. */
export const MAX_LOGIN_ADDRESS = 254;

/** The five code points of WHATWG "ASCII whitespace" (password-v1, step 1). */
const ASCII_WHITESPACE = new Set([0x09, 0x0a, 0x0c, 0x0d, 0x20]);

/**
 * The address as password-v1 reads it (email_norm, docs/crypto/password-v1.md step 1): ASCII
 * whitespace taken off both ends, A-Z made a-z, nothing else changed. The browser salts the login
 * secret with this same text, so the server sends Supabase this form too.
 *
 * Written out rather than `trim()` and `toLowerCase()`: those take off and change other characters
 * (U+00A0, U+3000, U+0130), and not the same ones on every platform.
 */
export function normalizeLoginAddress(raw: unknown): string {
  const points = Array.from(typeof raw === "string" ? raw : "");
  let start = 0;
  let end = points.length;
  while (start < end && ASCII_WHITESPACE.has(points[start].codePointAt(0)!)) start++;
  while (end > start && ASCII_WHITESPACE.has(points[end - 1].codePointAt(0)!)) end--;
  return points
    .slice(start, end)
    .map((c) => {
      const code = c.codePointAt(0)!;
      return code >= 0x41 && code <= 0x5a ? String.fromCharCode(code + 0x20) : c;
    })
    .join("");
}

/** An address worth asking Supabase about (Supabase checks it again). */
export function isLoginAddress(address: string): boolean {
  return address.length <= MAX_LOGIN_ADDRESS && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address);
}

/**
 * Only printable ASCII. A new account must have such an address: Supabase lowercases an address
 * with Unicode rules and the browser with ASCII rules only (email_norm), so for any other letter the
 * two would disagree on the salt of the login secret, on the web and on iOS alike.
 */
export function isAsciiAddress(address: string): boolean {
  return /^[\x21-\x7e]+$/.test(address);
}
