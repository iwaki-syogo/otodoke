import { NextResponse, type NextRequest } from "next/server";
import { throwawayAuthClient } from "@/lib/auth-session";
import { CONFIRMED_PATH, RESET_PATH, linkFailureCode, loginErrorPath, type AuthFailure, type LoginCode } from "@/lib/login-errors";
import { claimLoginLink, clientIp } from "@/lib/login-mail-limit";
import { SIGNUP_CONFIRMED_PATH } from "@/lib/onboarding";
import { fromThisSite } from "@/lib/request-origin";
import { createClient } from "@/lib/supabase/server";

/** A relative Location keeps the visitor on the host they opened, whatever host the server thinks it has. */
function go(path: string, status: number) {
  return new NextResponse(null, { status, headers: { Location: path } });
}

/** What the continue page takes from a mail's link: its token, the token's type, where it goes. */
const LINK_FIELDS = ["token_hash", "type", "next"];

/** The links that only confirm the address: verified, and the session they make is thrown away. */
const CONFIRM_TYPES = ["email", "signup", "magiclink"] as const;
type ConfirmType = (typeof CONFIRM_TYPES)[number];
const isConfirmType = (type: string): type is ConfirmType => (CONFIRM_TYPES as readonly string[]).includes(type);

/**
 * A mail's link lands here. Opening it only shows a button (/auth/continue): mail security scanners
 * fetch links with GET, and would otherwise use up the one-time token before the person arrives.
 * Only the link's own fields are carried over.
 */
export async function GET(request: NextRequest) {
  const carried = new URLSearchParams();
  for (const name of LINK_FIELDS) for (const value of request.nextUrl.searchParams.getAll(name)) carried.append(name, value);
  const query = carried.toString();
  return go(query ? `/auth/continue?${query}` : "/auth/continue", 307);
}

/**
 * The continue page's button posts the token here; it is verified server-side, so the link works
 * in another browser than the one that asked for the mail. By the link's type:
 *
 * - email, signup, magiclink (the confirmation of a new account; an old login link): verified in a
 *   client of its own that writes no cookie, and the session it makes is ended at once (decision 6:
 *   the key is made at the sign-in with the password). This browser's session, if any, is left as
 *   it was. The answer for a new account's confirmation (email, which confirmation.html sends, and
 *   signup) is SIGNUP_CONFIRMED_PATH: 「確認できました」, the tab that signed up goes on by itself,
 *   and 「この画面でログインする」 leads to the login here. An old login link (magiclink) still gets
 *   the login page, as before.
 * - recovery (the reset mail): verified on this browser's cookies, which then hold that session
 *   (any other one signed in here is replaced), and the answer is always RESET_PATH. The link's
 *   next is never read.
 * - anything else: refused.
 *
 * Before Supabase checks a token, the check is taken from the client IP's allowance
 * (src/lib/login-mail-limit.ts LOGIN_LINK_LIMITS): Supabase's own limit is per IP, and every
 * visitor's link is checked from this server's. Past it, /login?error=link_limited; the token is
 * not sent, so the link still works later.
 */
export async function POST(request: NextRequest) {
  // Only the button on /auth/continue may post here. Another site's form would otherwise sign this
  // browser in to the account whose reset link it holds; its token is left unused.
  if (!fromThisSite(request.headers)) {
    console.warn("[auth] refused a POST from another site:", request.headers.get("sec-fetch-site"), request.headers.get("origin")?.slice(0, 100));
    return go(loginErrorPath("link_invalid"), 303);
  }
  const form = await request.formData();
  const tokenHash = form.get("token_hash");
  const type = form.get("type");
  if (typeof tokenHash !== "string" || !tokenHash || typeof type !== "string" || !type) return go(loginErrorPath("link_incomplete"), 303);
  const verify = type === "recovery" ? () => recover(tokenHash) : isConfirmType(type) ? () => confirmOnly(tokenHash, type) : null;
  if (!verify) {
    console.warn("[auth] refused a link of an unknown type:", type.slice(0, 40));
    return go(loginErrorPath("link_invalid"), 303);
  }
  const limit = await claimLoginLink(clientIp(request.headers));
  if (limit !== "ok") {
    console.warn("[auth] link limited:", limit);
    return go(loginErrorPath("link_limited"), 303);
  }
  return verify();
}

/** The login page with the code for a token Supabase did not accept (its text only to the log). */
function refused(error: AuthFailure, kind: "confirm" | "reset"): NextResponse {
  const code: LoginCode = linkFailureCode(error, kind);
  return go(loginErrorPath(code), 303);
}

async function confirmOnly(tokenHash: string, type: ConfirmType): Promise<NextResponse> {
  const client = throwawayAuthClient();
  let answer: Awaited<ReturnType<typeof client.auth.verifyOtp>>;
  try {
    answer = await client.auth.verifyOtp({ type, token_hash: tokenHash });
  } catch (thrown) {
    // Not an AuthError (supabase-js returns those): nothing says the token was refused.
    console.warn("[auth] confirm: verifyOtp threw:", thrown instanceof Error ? thrown.name : typeof thrown);
    return refused(null, "confirm");
  }
  const { data, error } = answer;
  if (error) {
    console.warn("[auth] confirm: verifyOtp refused:", error.status ?? 0, error.code ?? "unknown");
    return refused(error, "confirm");
  }
  // The address is confirmed. The session the token made is nobody's: ended here (this one only).
  const token = data.session?.access_token;
  if (token) {
    try {
      const { error: endError } = await client.auth.admin.signOut(token, "local");
      if (endError) console.warn("[auth] confirm: the session could not be ended:", endError.status ?? 0, endError.code ?? "unknown");
    } catch (thrown) {
      console.warn("[auth] confirm: ending the session threw:", thrown instanceof Error ? thrown.name : typeof thrown);
    }
  }
  return go(type === "magiclink" ? CONFIRMED_PATH : SIGNUP_CONFIRMED_PATH, 303);
}

async function recover(tokenHash: string): Promise<NextResponse> {
  const supabase = await createClient();
  let error: { status?: number; code?: string } | null;
  try {
    ({ error } = await supabase.auth.verifyOtp({ type: "recovery", token_hash: tokenHash }));
  } catch (thrown) {
    console.warn("[auth] reset: verifyOtp threw:", thrown instanceof Error ? thrown.name : typeof thrown);
    return refused(null, "reset");
  }
  if (error) {
    console.warn("[auth] reset: verifyOtp refused:", error.status ?? 0, error.code ?? "unknown");
    return refused(error, "reset");
  }
  return go(RESET_PATH, 303);
}
