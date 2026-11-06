import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { hostName } from "@/lib/request-origin";

/** The site's own address: a host the Turnstile widget is registered for (the list is in src/lib/turnstile.ts). */
const SITE = "https://otodoke.app";
/** Vercel's production URL of the project: the same app, on a host the Turnstile widget is not registered for, where it would refuse the login. */
const VERCEL_PRODUCTION_HOST = "otodoke-app.vercel.app";

/**
 * Where a request for Vercel's production URL goes instead: the same path and query on
 * otodoke.app. Null when it stays where it is.
 *
 * - That host exactly. Previews (otodoke-app-git-*, the per-deployment URLs) stay.
 * - GET and HEAD only. A form or a Server Action posted from a page that was opened there before
 *   would reach otodoke.app as another site's post, without that host's session.
 * - Never /api/: Resend's webhook may be set to either host, and a webhook does not follow a
 *   redirect the way a browser does. (The matcher also skips the files it never runs for.)
 */
function siteRedirect(request: NextRequest): URL | null {
  if (hostName(request.headers.get("host")?.toLowerCase() ?? "") !== VERCEL_PRODUCTION_HOST) return null;
  if (request.method !== "GET" && request.method !== "HEAD") return null;
  const { pathname, search } = request.nextUrl;
  if (pathname === "/api" || pathname.startsWith("/api/")) return null;
  const url = new URL(SITE);
  // Assigned, not parsed: a path such as "//x.example" stays a path on otodoke.app.
  url.pathname = pathname;
  url.search = search;
  return url;
}

/**
 * Sends Vercel's production URL to otodoke.app, refreshes the Supabase session cookie on every
 * request, and sends signed-out visitors of app pages to /login. Public: landing, login, auth
 * callbacks, API.
 */
export async function proxy(request: NextRequest) {
  const moved = siteRedirect(request);
  if (moved) return NextResponse.redirect(moved, 308);

  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
        },
      },
    },
  );

  // getUser() validates the token with Supabase Auth; do not replace with getSession().
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { pathname } = request.nextUrl;
  const isProtected = pathname === "/app" || pathname.startsWith("/app/");
  if (isProtected && !user) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("next", pathname);
    return NextResponse.redirect(url);
  }

  return response;
}

export const config = {
  matcher: [
    // Everything except static assets and the inbound webhook (which has no user session).
    "/((?!_next/static|_next/image|favicon.ico|api/inbound|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|txt|xml)$).*)",
  ],
};
