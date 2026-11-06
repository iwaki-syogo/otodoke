/**
 * What the login forms accept: the address the link and code are sent to, and the code typed in.
 * Pure functions (no request, no Supabase), shared by the Server Actions and the login page.
 */

/** The address as it is sent and kept: trimmed and lowercase. */
export function normalizeLoginAddress(raw: unknown): string {
  return String(raw ?? "").trim().toLowerCase();
}

/** An address worth asking Supabase to send to (Supabase checks it again). */
export function isLoginAddress(address: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address);
}

/**
 * Supabase's otp_length can be set from 6 to 10 (8 in config.toml). Every length is accepted, so
 * a change in the dashboard does not lock the Web out.
 */
export const LOGIN_CODE_MIN_DIGITS = 6;
export const LOGIN_CODE_MAX_DIGITS = 10;

/**
 * Spaces and every dash a phone keyboard or a copy from a mail can put between the digits: ASCII
 * and full-width hyphen-minus, hyphen, non-breaking hyphen, figure dash, en and em dash, horizontal
 * bar, minus sign, and the long vowel mark ー that a Japanese keyboard types for "-".
 */
const SEPARATORS = /[\s\-‐‑‒–—―−ー－]/g;

/**
 * The code as Supabase checks it (ASCII digits only), or null when what was typed cannot be a
 * code. Full-width digits and spaces become ASCII (NFKC); spaces and dashes between the digits
 * are dropped. Anything else (a letter, a symbol) makes it not a code, rather than being dropped:
 * a mistyped character should say "check the code", not try a different one.
 */
export function normalizeLoginCode(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > 64) return null;
  const digits = raw.normalize("NFKC").replace(SEPARATORS, "");
  return new RegExp(`^[0-9]{${LOGIN_CODE_MIN_DIGITS},${LOGIN_CODE_MAX_DIGITS}}$`).test(digits) ? digits : null;
}
