import { NextResponse, type NextRequest } from "next/server";
import type { EmailOtpType } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { safeNextPath } from "@/lib/safe-next";
import { loginErrorPath, loginLinkErrorCode } from "@/lib/login-errors";
import { fromThisSite } from "@/lib/request-origin";
import { forgetLogin } from "@/lib/login-email-cookie";

/** A relative Location keeps the visitor on the host they opened, whatever host the server thinks it has. */
function go(path: string, status: number) {
  return new NextResponse(null, { status, headers: { Location: path } });
}

/** Whether this browser has a signed-in user (Supabase checks the token). False when that cannot be read. */
async function signedIn(supabase: Awaited<ReturnType<typeof createClient>>): Promise<boolean> {
  try {
    const { data } = await supabase.auth.getUser();
    return !!data.user;
  } catch {
    return false;
  }
}

/** What the continue page takes from a mail's link: its token, the token's type, where it goes. */
const LINK_FIELDS = ["token_hash", "type", "next"];

/**
 * Magic-link landing. Opening the link only shows a button: mail security scanners fetch
 * links with GET, and would otherwise use up the one-time token before the person arrives.
 * Only the link's own fields are carried over. The continue page's link=refused is this site's
 * answer to a refused switch (set by the POST below) and is never taken from a link: a URL made
 * with someone's own token and that mark would show 「このリンクは使えませんでした。」 next to a
 * switch button that signs in to their account.
 */
export async function GET(request: NextRequest) {
  const carried = new URLSearchParams();
  for (const name of LINK_FIELDS) for (const value of request.nextUrl.searchParams.getAll(name)) carried.append(name, value);
  const query = carried.toString();
  return go(query ? `/auth/continue?${query}` : "/auth/continue", 307);
}

/** Verifies the token_hash server-side, so the link works in a different browser than the one that asked. */
export async function POST(request: NextRequest) {
  // Only the button on /auth/continue may post here. Another site's form would sign this browser
  // in to the account whose link it holds (login CSRF); its token is left unused.
  if (!fromThisSite(request.headers)) {
    console.warn("[auth] refused a login POST from another site:", request.headers.get("sec-fetch-site"), request.headers.get("origin")?.slice(0, 100));
    return go(loginErrorPath("link_invalid"), 303);
  }
  const form = await request.formData();
  const tokenHash = form.get("token_hash");
  const type = form.get("type");
  const next = form.get("next");

  if (typeof tokenHash === "string" && tokenHash && typeof type === "string" && type) {
    const supabase = await createClient();
    let error: { status?: number; code?: string; message?: string } | null;
    try {
      ({ error } = await supabase.auth.verifyOtp({ type: type as EmailOtpType, token_hash: tokenHash }));
    } catch (thrown) {
      // Not an AuthError (supabase-js returns those): nothing says the token was refused.
      console.warn("[auth] verifyOtp threw:", thrown instanceof Error ? thrown.message : String(thrown));
      return go(loginErrorPath(loginLinkErrorCode(null)), 303);
    }
    if (!error) {
      // Signed in: the address the login form kept for this browser (if it sent from here) is done.
      await forgetLogin();
      return go(safeNextPath(typeof next === "string" ? next : null), 303);
    }
    // The reason goes to the log only: the login page shows fixed wording for the code. A limit
    // or an outage is told apart from a refused token (the same link works again later).
    console.warn("[auth] verifyOtp failed:", error.status, error.code, error.message);
    const code = loginLinkErrorCode(error);
    // A refused link in a browser that is signed in already (an old link pressed in another tab,
    // or one used up by this very sign-in): the continue page says who is signed in and leads to
    // the parcels, instead of a red error on the login page, and without a word: the person is
    // signed in, as they meant to be. Only 「別のアカウントでログインする」 posts intent: then the
    // switch they asked for did not happen, and link=refused has the page say so. The mark is
    // only shown there; where the page leads is the next, either way.
    if (code === "link_invalid" && (await signedIn(supabase))) {
      const target = safeNextPath(typeof next === "string" ? next : null);
      const query = [target === "/app" ? null : `next=${encodeURIComponent(target)}`, form.get("intent") === "switch_account" ? "link=refused" : null].filter(Boolean);
      return go(query.length ? `/auth/continue?${query.join("&")}` : "/auth/continue", 303);
    }
    return go(loginErrorPath(code), 303);
  }
  return go(loginErrorPath("link_incomplete"), 303);
}
