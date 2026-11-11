import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * App-side cap on the mails this website asks Supabase to send (the confirmation of a new account,
 * sending it again, the reset mail), checked before asking Supabase to send one. Further down, the
 * same table caps failed sign-ins (LOGIN_ATTEMPT_LIMITS), every sign-in per IP (LOGIN_TRY_LIMITS)
 * and every mail's link checked per IP (LOGIN_LINK_LIMITS).
 *
 * Supabase sees every request from Vercel's addresses, so its own per-IP limit is shared by all
 * visitors of the website. This keeps one visitor of the form from using up the project's mail
 * allowance through the form.
 *
 * What it does not do: the limit covers only this website's three entrances (the confirmation of a
 * new account, sending it again, the reset mail). Supabase's own endpoints behind them,
 * /auth/v1/signup, /auth/v1/resend and /auth/v1/recover, can be called directly with the public
 * anon key, and so can /auth/v1/otp (the iOS app does exactly that). Those requests never pass
 * through here, so this cannot stop someone from exhausting Supabase's project-wide mail cap. Only
 * a CAPTCHA on the Supabase side or Supabase's own rate-limit settings can.
 *
 * Who must not be blocked, and how the numbers allow for them. The three mails share every count
 * here; signing in with the password sends none.
 * - Someone whose mail is slow or in spam and asks again: Supabase already refuses a second
 *   send to one address within a minute, so 3 per 10 minutes is two retries, 6 per hour plenty.
 *   A refused resend/reset is given back (releaseLoginMail). Sign-up outcomes hidden as a sent
 *   mail keep their claims equally for new, pending and registered addresses, including a refusal
 *   within that minute; other failures give the claim back.
 * - Someone who mistyped the address: the typo is a different address with its own count.
 * - Several judges on one office or venue network (one shared IP): 20 per hour from one IP for
 *   the three mails together. Twenty people can make their accounts within one hour, or ten if
 *   each has the mail sent again, and a reset for a forgotten password takes from the same twenty.
 *   One more is told to try again later and can once the oldest of those sends is an hour old.
 *   The 20 has two upper bounds, both checked by login-actions.test.ts:
 *   1. It stays below Supabase's project-wide mail limit (30 mails per hour, `email_sent` in
 *      supabase/config.toml), so one IP can no longer take the whole mail allowance through the
 *      forms and leave nobody else a mail.
 *   2. Together with LOGIN_TRY_LIMITS (sign-in tries per IP), the mails per IP stay below
 *      Supabase's 100 sign-ins and sign-ups per 5 minutes (Authentication > Rate Limits), which
 *      every visitor shares.
 *
 * Fails open: if the check itself fails (DB down, function missing, no service key locally), the
 * mail is sent and a warning is logged. Locking everyone out is worse than a missing cap.
 */
export const LOGIN_MAIL_LIMITS = {
  emailPer10Minutes: 3,
  emailPerHour: 6,
  ipPerHour: 20,
} as const;

export type LoginMailVerdict = "ok" | "email_10m" | "email_1h" | "ip_1h";
const VERDICTS: readonly string[] = ["ok", "email_10m", "email_1h", "ip_1h"];

/**
 * The visitor's IP, from x-forwarded-for (then x-real-ip). On Vercel these carry the client
 * address and Vercel overwrites any value the client sent, so they cannot be spoofed there. On
 * another host (or behind a proxy that passes the header through) a client can send its own
 * x-forwarded-for and pick a fresh "IP" for every request; then only the address limits hold.
 * Null when absent or not an IP.
 */
export function clientIp(headers: Pick<Headers, "get">): string | null {
  const forwarded = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const candidate = forwarded || headers.get("x-real-ip")?.trim() || "";
  return isIP(candidate) ? candidate : null;
}

/**
 * What the IP limit counts. IPv6 is cut to its /64: one device or home network usually owns a
 * whole /64 and could otherwise pick a fresh address for every request.
 */
export function ipLimitKey(ip: string): string {
  const mapped = ip.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i);
  if (mapped) return mapped[1];
  if (isIP(ip) !== 6) return ip;

  let s = ip.toLowerCase().split("%")[0];
  const v4Tail = s.match(/^(.*:)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4Tail) {
    const [a, b, c, d] = v4Tail.slice(2).map(Number);
    s = `${v4Tail[1]}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail] = s.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const groups = tail === undefined ? left : [...left, ...Array<string>(8 - left.length - right.length).fill("0"), ...right];
  return `${groups
    .slice(0, 4)
    .map((g) => parseInt(g, 16).toString(16))
    .join(":")}::/64`;
}

/**
 * App-side cap on sign-in attempts with the login secret through this website (the login, and the
 * check of the current password before a change), counted in the same table under a namespace of
 * its own ("login-attempt"), so attempts and mails never count against each other.
 *
 * Only failures count: an attempt is claimed before Supabase is asked and kept for either wrong
 * credentials or pending confirmation (the same app response), given back for other outcomes.
 * Supabase's own per-IP
 * limit cannot tell visitors apart either (every request comes from this server), and a guesser
 * through the form would use it up for everyone.
 *
 * Who must not be blocked: someone who mistypes a few times (10 per 10 minutes, 20 per hour for one
 * address), and many people behind one venue network (50 failures per hour from one IP). Fails
 * open like the mail limit: a broken check must not lock everyone out (Supabase still limits).
 */
export const LOGIN_ATTEMPT_LIMITS = {
  emailPer10Minutes: 10,
  emailPerHour: 20,
  ipPerHour: 50,
} as const;

/**
 * Every sign-in this website asks Supabase for, failed or not, per client IP. Supabase allows 100
 * sign-ins and sign-ups per 5 minutes per IP (dashboard setting), and every visitor of the website
 * comes from this server's IP: one visitor must not be able to use that up for everyone
 * (successes included, which the attempt limit gives back). Counted under its own namespace with
 * the IP in the address column,
 * so the function's 10-minute window applies to the IP: at most 15 in any 10 minutes (so never 100
 * in 5), 60 in an hour. Never given back.
 */
export const LOGIN_TRY_LIMITS = {
  ipPer10Minutes: 15,
  ipPerHour: 60,
} as const;

/**
 * Every mail's link this website asks Supabase to check (the POST of /auth/confirm: a confirmation
 * or a reset), per client IP. Supabase checks at most 30 tokens per 5 minutes per IP, and every
 * visitor's link is checked from this server's IP: one visitor posting made-up tokens must not use
 * that up, or every confirmation and reset link fails for everyone meanwhile (review R3-PW-4).
 * Counted like LOGIN_TRY_LIMITS, under its own namespace: at most 10 in any 10 minutes (so never 30
 * in 5); the hour adds nothing to that (6 × 10). Never given back: a check Supabase made uses its
 * allowance whatever it answered.
 *
 * Who must not be blocked: someone who opens the mail's link again and presses again a few times,
 * and a few people behind one network at once. A link held back still works later: its token was
 * not sent to Supabase. Many IPs at once are not stopped by this.
 */
export const LOGIN_LINK_LIMITS = {
  ipPer10Minutes: 10,
  ipPerHour: 60,
} as const;

/** What a limit counts in login_mail_sends: mails sent from the form, failed sign-ins, every sign-in per IP, or every link checked per IP. */
export type LimitScope = "login-mail" | "login-attempt" | "login-try" | "login-link";

/** The word for a scope in the log. */
const WHAT: Record<LimitScope, string> = { "login-mail": "mail", "login-attempt": "attempt", "login-try": "attempt", "login-link": "link" };

/** SHA-256 hex. The table keeps only these, never the address or the IP itself. */
export function limitHash(kind: "email" | "ip", value: string, scope: LimitScope = "login-mail"): string {
  return createHash("sha256").update(`otodoke:${scope}:${kind}:${value}`).digest("hex");
}

/** The answer to a claim. `claimId` is the recorded send (only when the verdict is "ok"). */
export interface LoginMailClaim {
  verdict: LoginMailVerdict;
  claimId: number | null;
}

const OPEN: LoginMailClaim = { verdict: "ok", claimId: null };

type Limits = { emailPer10Minutes: number; emailPerHour: number; ipPerHour: number };

async function claim(scope: LimitScope, limits: Limits, email: string, ip: string | null): Promise<LoginMailClaim> {
  const what = WHAT[scope];
  try {
    const { data, error } = await createAdminClient().rpc("claim_login_mail", {
      p_email_hash: limitHash("email", email, scope),
      // The generated type says string, but the function accepts null (address limits only).
      p_ip_hash: (ip ? limitHash("ip", ipLimitKey(ip), scope) : null) as string,
      p_email_10m_limit: limits.emailPer10Minutes,
      p_email_1h_limit: limits.emailPerHour,
      p_ip_1h_limit: limits.ipPerHour,
    });
    if (error) {
      console.warn(`[login] ${what} limit check failed; going ahead:`, error.message);
      return OPEN;
    }
    // A set-returning function: PostgREST answers with an array of one row.
    const row: unknown = Array.isArray(data) ? data[0] : data;
    const verdict = row && typeof row === "object" ? (row as { verdict?: unknown }).verdict : undefined;
    if (typeof verdict !== "string" || !VERDICTS.includes(verdict)) {
      console.warn(`[login] ${what} limit check returned an unexpected value; going ahead:`, data);
      return OPEN;
    }
    const id = (row as { claim_id?: unknown }).claim_id;
    return { verdict: verdict as LoginMailVerdict, claimId: verdict === "ok" && typeof id === "number" ? id : null };
  } catch (err) {
    console.warn(`[login] ${what} limit check failed; going ahead:`, err instanceof Error ? err.message : err);
    return OPEN;
  }
}

async function release(scope: LimitScope, email: string, claimId: number | null): Promise<void> {
  if (claimId === null) return;
  const what = scope === "login-mail" ? "the unsent login mail" : "the sign-in attempt";
  try {
    const { error } = await createAdminClient().rpc("release_login_mail", {
      p_claim_id: claimId,
      p_email_hash: limitHash("email", email, scope),
    });
    if (error) console.warn(`[login] could not give back ${what}:`, error.message);
  } catch (err) {
    console.warn(`[login] could not give back ${what}:`, err instanceof Error ? err.message : err);
  }
}

/** Take one login mail from the allowance. `email` must already be normalized (normalizeLoginAddress). */
export async function claimLoginMail(email: string, ip: string | null): Promise<LoginMailClaim> {
  return claim("login-mail", LOGIN_MAIL_LIMITS, email, ip);
}

/**
 * Give back a claimed send whose mail was not sent (Supabase refused it), so a refused press
 * does not count. Never throws: when this fails the send stays counted and a warning is logged.
 */
export async function releaseLoginMail(email: string, claimId: number | null): Promise<void> {
  return release("login-mail", email, claimId);
}

/** Take one sign-in attempt from the allowance (LOGIN_ATTEMPT_LIMITS). `email` normalized. */
export async function claimLoginAttempt(email: string, ip: string | null): Promise<LoginMailClaim> {
  return claim("login-attempt", LOGIN_ATTEMPT_LIMITS, email, ip);
}

/** Give back an attempt that did not fail on the address or the secret. Never throws. */
export async function releaseLoginAttempt(email: string, claimId: number | null): Promise<void> {
  return release("login-attempt", email, claimId);
}

/**
 * Take one sign-in from this IP's allowance (LOGIN_TRY_LIMITS). Without a client IP there is
 * nothing to count it by: "ok". The IP's key goes where claim_login_mail keeps the address.
 */
export async function claimLoginTry(ip: string | null): Promise<LoginMailVerdict> {
  if (!ip) return "ok";
  const { verdict } = await claim("login-try", { emailPer10Minutes: LOGIN_TRY_LIMITS.ipPer10Minutes, emailPerHour: LOGIN_TRY_LIMITS.ipPerHour, ipPerHour: LOGIN_TRY_LIMITS.ipPerHour }, ipLimitKey(ip), null);
  return verdict;
}

/**
 * Take one link check from this IP's allowance (LOGIN_LINK_LIMITS), the same way as claimLoginTry:
 * the IP's key where claim_login_mail keeps the address. Without a client IP: "ok".
 */
export async function claimLoginLink(ip: string | null): Promise<LoginMailVerdict> {
  if (!ip) return "ok";
  const { verdict } = await claim("login-link", { emailPer10Minutes: LOGIN_LINK_LIMITS.ipPer10Minutes, emailPerHour: LOGIN_LINK_LIMITS.ipPerHour, ipPerHour: LOGIN_LINK_LIMITS.ipPerHour }, ipLimitKey(ip), null);
  return verdict;
}
