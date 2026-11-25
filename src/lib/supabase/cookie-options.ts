import type { CookieOptionsWithName } from "@supabase/ssr";

/**
 * The attributes of Supabase's session cookie, for both server clients (src/lib/supabase/server.ts and src/proxy.ts).
 *
 * - HttpOnly: only the server reads the session. The browser has no Supabase client (no-browser-supabase.test.ts keeps
 *   it so), so no page script needs to see the cookie.
 * - Secure on Vercel, where every deployment (production and preview) is served over HTTPS. Not set locally, so
 *   `next dev` / `next start` over plain HTTP (localhost, or the phone over Tailscale) keep their login.
 * - SameSite=Lax and Path=/ as the SDK's own defaults; the SDK keeps its own max-age.
 */
export function sessionCookieOptions(): CookieOptionsWithName {
  return { path: "/", sameSite: "lax", httpOnly: true, secure: process.env.VERCEL === "1" };
}
