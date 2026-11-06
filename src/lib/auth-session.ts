import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/db/database.types";
import { env } from "@/lib/env";
import { createClient } from "@/lib/supabase/server";

/**
 * How recently, and how, the user of a session proved who they are: read from the `amr` claim of
 * its access token, after Supabase Auth has accepted that very token (getUser(token)).
 *
 * Supabase Auth writes `amr` as [{ method, timestamp }] (auth-js JwtPayload, AMREntry: the
 * timestamp is when the method was used, in seconds). The entries belong to the session and are
 * carried over to every refreshed token unchanged, so the time is when the user signed in, not when
 * the token was made.
 *
 * - `password`: signInWithPassword (the login secret).
 * - The methods a mail's token gives (the reset link through verifyOtp): Supabase's verify endpoint
 *   records `otp` for a token_hash it accepts, whatever its type; `recovery` and `magiclink` are
 *   taken too, in case a version records the type. All of them prove the same thing: whoever holds
 *   the session read the account's mailbox at that time, which is what a reset needs. On the web a
 *   fresh such session only comes from a reset link: /auth/confirm verifies every other link in a
 *   client of its own and throws the session away.
 *
 * Decision 10: making or replacing a key needs a session that signed in with the password, or came
 * from a reset link, in the last 15 minutes.
 */
export const FRESH_AUTH_MS = 15 * 60 * 1000;

/** A token time this far ahead of this server's clock still counts (the two clocks are not one). */
const CLOCK_SKEW_MS = 5 * 60 * 1000;

const PASSWORD_METHODS = ["password"];
const MAILBOX_METHODS = ["recovery", "otp", "magiclink"];

/** One entry of `amr`; `at` in ms, null when the entry has no time (the RFC 8176 string form). */
export type AmrEntry = { method: string; at: number | null };

/** The claims of an access token, read without checking it. Null when it is not a JWT. */
export function tokenClaims(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[1]) return null;
  try {
    const claims: unknown = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return claims && typeof claims === "object" && !Array.isArray(claims) ? (claims as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The `amr` claim as entries; anything that is not one is left out. */
export function amrEntries(amr: unknown): AmrEntry[] {
  if (!Array.isArray(amr)) return [];
  const entries: AmrEntry[] = [];
  for (const item of amr) {
    if (typeof item === "string") entries.push({ method: item, at: null });
    else if (item && typeof item === "object" && typeof (item as { method?: unknown }).method === "string") {
      const ts = (item as { timestamp?: unknown }).timestamp;
      entries.push({ method: (item as { method: string }).method, at: typeof ts === "number" && Number.isFinite(ts) ? ts * 1000 : null });
    }
  }
  return entries;
}

/**
 * What a step needs:
 * - `key`: making, putting in use or rewrapping a key (password or reset link, 15 minutes).
 * - `reset`: setting a new password without the old one (a reset link, 15 minutes).
 */
export type Freshness = "key" | "reset";

/** Whether `amr` shows a sign-in of the kind `need` within FRESH_AUTH_MS of `now`. */
export function isFresh(amr: AmrEntry[], need: Freshness, now = Date.now()): boolean {
  const methods = need === "reset" ? MAILBOX_METHODS : [...PASSWORD_METHODS, ...MAILBOX_METHODS];
  return amr.some((e) => methods.includes(e.method) && e.at !== null && now - e.at <= FRESH_AUTH_MS && e.at - now <= CLOCK_SKEW_MS);
}

/** A session Supabase Auth accepted, with who it is and how they signed in. */
export type VerifiedSession = { userId: string; email: string | null; amr: AmrEntry[] };

/**
 * - `signed_in`: Supabase Auth accepted the token.
 * - `signed_out`: there is no session, or Supabase refused its token (an answer).
 * - `unknown`: Supabase could not be asked (no answer, 5xx): never read as signed out.
 */
export type SessionRead = { state: "signed_in"; session: VerifiedSession } | { state: "signed_out" } | { state: "unknown" };

type AuthLike = {
  getUser: (jwt?: string) => Promise<{ data: { user: { id: string; email?: string } | null }; error: { status?: number } | null }>;
};

/** getUser(token), then the claims of the same token. */
async function verify(auth: AuthLike, token: string): Promise<SessionRead> {
  let answer: Awaited<ReturnType<AuthLike["getUser"]>>;
  try {
    answer = await auth.getUser(token);
  } catch {
    return { state: "unknown" };
  }
  const { data, error } = answer;
  if (error) return !error.status || error.status >= 500 ? { state: "unknown" } : { state: "signed_out" };
  const claims = tokenClaims(token);
  if (!data.user || !claims || claims.sub !== data.user.id) return { state: "signed_out" };
  return { state: "signed_in", session: { userId: data.user.id, email: data.user.email ?? null, amr: amrEntries(claims.amr) } };
}

export type ServerClient = Awaited<ReturnType<typeof createClient>>;

/**
 * The session of this request's cookies: its access token (refreshed when it has run out), checked
 * by Supabase Auth, and the claims of that same token.
 */
export async function readCookieSession(supabase: ServerClient): Promise<SessionRead> {
  let token: string | undefined;
  try {
    const { data, error } = await supabase.auth.getSession();
    if (error) return !error.status || error.status >= 500 ? { state: "unknown" } : { state: "signed_out" };
    token = data.session?.access_token;
  } catch {
    return { state: "unknown" };
  }
  if (!token) return { state: "signed_out" };
  return verify(supabase.auth as unknown as AuthLike, token);
}

/** The longest Authorization header taken (a Supabase access token is well under 2 KB). */
const MAX_AUTHORIZATION = 8192;

/** The token of `Authorization: Bearer <token>`, or null. */
export function bearerToken(authorization: string | null): string | null {
  if (!authorization || authorization.length > MAX_AUTHORIZATION) return null;
  const match = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(authorization.trim());
  return match ? match[1] : null;
}

/** The session of an iOS request (Authorization: Bearer <Supabase access token>). */
export async function readBearerSession(authorization: string | null): Promise<SessionRead> {
  const token = bearerToken(authorization);
  if (!token) return { state: "signed_out" };
  return verify(throwawayAuthClient().auth as unknown as AuthLike, token);
}

/**
 * A Supabase client with the public key that keeps nothing: no cookies, no storage, no refresh.
 * For checking a token, and for the mails and links that must not touch this browser's session.
 */
export function throwawayAuthClient() {
  const { NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY } = env();
  return createSupabaseClient<Database>(NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

/**
 * - `ok`: signed in, and fresh enough for `need`.
 * - `signed_out`, `stale` (signed in, but not recently enough), `unknown` (Supabase could not be asked).
 */
export type FreshCheck = { ok: true; session: VerifiedSession } | { ok: false; reason: "signed_out" | "stale" | "unknown" };

export function checkFresh(read: SessionRead, need: Freshness, now = Date.now()): FreshCheck {
  if (read.state !== "signed_in") return { ok: false, reason: read.state };
  return isFresh(read.session.amr, need, now) ? { ok: true, session: read.session } : { ok: false, reason: "stale" };
}

/** The cookie session, if it is fresh enough for `need`. */
export async function freshCookieSession(need: Freshness): Promise<FreshCheck> {
  return checkFresh(await readCookieSession(await createClient()), need);
}
