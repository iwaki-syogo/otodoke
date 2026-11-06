import { NextResponse, type NextRequest } from "next/server";
import type { EmailOtpType } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { safeNextPath } from "@/lib/safe-next";
import { loginErrorPath, loginLinkErrorCode } from "@/lib/login-errors";
import { fromThisSite } from "@/lib/request-origin";

/** A relative Location keeps the visitor on the host they opened, whatever host the server thinks it has. */
function go(path: string, status: number) {
  return new NextResponse(null, { status, headers: { Location: path } });
}

/**
 * Magic-link landing. Opening the link only shows a button: mail security scanners fetch
 * links with GET, and would otherwise use up the one-time token before the person arrives.
 */
export async function GET(request: NextRequest) {
  return go(`/auth/continue${request.nextUrl.search}`, 307);
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
    if (!error) return go(safeNextPath(typeof next === "string" ? next : null), 303);
    // The reason goes to the log only: the login page shows fixed wording for the code. A limit
    // or an outage is told apart from a refused token (the same link works again later).
    console.warn("[auth] verifyOtp failed:", error.status, error.code, error.message);
    return go(loginErrorPath(loginLinkErrorCode(error)), 303);
  }
  return go(loginErrorPath("link_incomplete"), 303);
}
