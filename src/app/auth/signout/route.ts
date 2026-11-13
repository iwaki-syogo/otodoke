import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { accountChangedPath, displayedUserMatches } from "@/lib/action-identity";
import { tokenClaims } from "@/lib/auth-session";

type ServerClient = Awaited<ReturnType<typeof createClient>>;

/**
 * Used when the current user could not be verified (Auth unreachable or refusing).
 * The cookie is read, not trusted: it is cleared only when its own subject is the
 * account the person was shown. Anything else is left alone.
 */
async function logoutUnverified(supabase: ServerClient, expectedUserId: unknown): Promise<"login" | "changed"> {
  let session: { access_token: string } | null;
  try {
    const { data, error } = await supabase.auth.getSession();
    if (!error && !data.session) return "login";
    if (error || !data.session) return "changed";
    session = data.session;
  } catch {
    return "changed";
  }
  const sub = tokenClaims(session.access_token)?.sub;
  if (typeof sub !== "string" || !sub || !displayedUserMatches({ id: sub }, expectedUserId)) return "changed";
  // The local session is removed even if the server call fails.
  await supabase.auth.signOut({ scope: "local" });
  return "login";
}

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  let user: { id: string } | null = null;
  try {
    ({ data: { user } } = await supabase.auth.getUser());
  } catch {
    user = null;
  }
  const formData = await request.formData();
  const expectedUserId = formData.get("expectedUserId");
  // Route redirects must use 303 too: the recovery page accepts GET, never the old POST body.
  if (!user) {
    const outcome = await logoutUnverified(supabase, expectedUserId);
    return NextResponse.redirect(new URL(outcome === "login" ? "/login" : accountChangedPath("/app/settings", "logout"), request.url), { status: 303 });
  }
  if (!displayedUserMatches(user, expectedUserId)) return NextResponse.redirect(new URL(accountChangedPath("/app/settings", "logout"), request.url), { status: 303 });
  await supabase.auth.signOut({ scope: "local" });
  return NextResponse.redirect(new URL("/", request.url), { status: 303 });
}
