import { cookies, headers } from "next/headers";

/**
 * The address the login form last sent a mail to, or tried to, kept for this browser only.
 *
 * - After a send, the "sent" screen shows it, and the code typed there is checked with it:
 *   Supabase verifies a code together with the address it went to.
 * - After a refused send, the address field shows it again: Next.js draws the form anew after a
 *   Server Action redirects, so what the browser had in the field is gone.
 * - Removed when this browser signs in (the code, or the link at /auth/confirm), signs out
 *   (/auth/signout) or deletes its account (設定). A link opened on another device signs that
 *   device in: the cookie of the browser that sent then lasts its hour.
 *
 * Not in the URL: a URL stays in the browser's history and in request logs. A cookie instead:
 * - httpOnly: no script on the page can read it.
 * - Path=/login: sent only to the login page and its Server Actions (they post to /login).
 * - SameSite=Lax, one hour: the life of the mail's link and code (otp_expiry in config.toml).
 * - Secure, unless the request came over plain http (the local dev server, which a browser would
 *   not give a Secure cookie back to over http).
 *
 * Reading and writing never throw: without the cookie the login still works by the mail's link,
 * and the field is only empty.
 */
export const LOGIN_EMAIL_COOKIE = "otodoke_login";
export const LOGIN_EMAIL_MAX_AGE = 60 * 60;
export const LOGIN_EMAIL_COOKIE_PATH = "/login";
/** The longest address SMTP allows; anything longer is not kept. */
const MAX_ADDRESS = 254;

/**
 * `sentAt` (ms): when a mail last went to this address from this browser. Supabase sends to one
 * address at most once a minute (max_frequency in config.toml), so a refusal within that minute
 * can say how long to wait.
 */
export type RememberedLogin = { email: string; sentAt?: number };

/** The cookie's value, or null when it is not one this app wrote (missing, edited, too long). */
export function parseRememberedLogin(value: string | undefined): RememberedLogin | null {
  if (!value || value.length > 1024) return null;
  try {
    const data: unknown = JSON.parse(value);
    if (typeof data !== "object" || data === null) return null;
    const { e, t } = data as { e?: unknown; t?: unknown };
    if (typeof e !== "string" || !e || e.length > MAX_ADDRESS) return null;
    return typeof t === "number" && Number.isFinite(t) && t > 0 ? { email: e, sentAt: t } : { email: e };
  } catch {
    return null;
  }
}

/** Whether the request reached the app over plain http (only the local dev server does). */
function plainHttp(h: Headers): boolean {
  return h.get("x-forwarded-proto")?.split(",")[0].trim().toLowerCase() === "http";
}

/** What the login page and its actions remember about this browser's login, or null. */
export async function readRememberedLogin(): Promise<RememberedLogin | null> {
  try {
    return parseRememberedLogin((await cookies()).get(LOGIN_EMAIL_COOKIE)?.value);
  } catch {
    return null;
  }
}

/** Remembers the address as the form will send it (trimmed, lowercase). Server Actions only. */
export async function rememberLogin(login: RememberedLogin): Promise<void> {
  if (!login.email || login.email.length > MAX_ADDRESS) return;
  let secure = true;
  try {
    secure = !plainHttp(await headers());
  } catch {
    // No request headers: keep it Secure.
  }
  try {
    (await cookies()).set(LOGIN_EMAIL_COOKIE, JSON.stringify(login.sentAt ? { e: login.email, t: login.sentAt } : { e: login.email }), {
      httpOnly: true,
      secure,
      sameSite: "lax",
      path: LOGIN_EMAIL_COOKIE_PATH,
      maxAge: LOGIN_EMAIL_MAX_AGE,
    });
  } catch (error) {
    // Never the address itself.
    console.warn("[login] could not keep the address for this browser:", error instanceof Error ? error.message : String(error));
  }
}

/**
 * Forgets the address (after a sign-in, a sign-out or an account deletion). Server Actions and
 * Route Handlers only (Next.js adds the deletion to their response). The path must match the one set.
 */
export async function forgetLogin(): Promise<void> {
  try {
    (await cookies()).delete({ name: LOGIN_EMAIL_COOKIE, path: LOGIN_EMAIL_COOKIE_PATH });
  } catch (error) {
    console.warn("[login] could not forget the address for this browser:", error instanceof Error ? error.message : String(error));
  }
}
