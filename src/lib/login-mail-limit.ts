import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * App-side cap on login-link mails, checked before asking Supabase to send one.
 *
 * Supabase sees every request from Vercel's addresses, so its own per-IP limit is shared by all
 * visitors, and its project-wide hourly email allowance is small. Without this, one person could
 * use it up and nobody (judges included) could log in for the rest of the hour.
 *
 * Who must not be blocked, and how the numbers allow for them:
 * - Someone whose mail is slow or in spam and asks again: Supabase already refuses a second
 *   send to one address within a minute, so 3 per 10 minutes is two retries, 6 per hour plenty.
 * - Someone who mistyped the address: the typo is a different address with its own count.
 * - Several judges on one office or venue network (one shared IP): 10 per hour from one IP.
 *   A signed-in session lasts, so each person needs a link once; ten different people logging in
 *   from one network within the same hour is unlikely, while one IP alone can no longer take the
 *   whole project allowance.
 *
 * Fails open: if the check itself fails (DB down, function missing, no service key locally), the
 * mail is sent and a warning is logged. Locking everyone out is worse than a missing cap.
 */
export const LOGIN_MAIL_LIMITS = {
  emailPer10Minutes: 3,
  emailPerHour: 6,
  ipPerHour: 10,
} as const;

export type LoginMailVerdict = "ok" | "email_10m" | "email_1h" | "ip_1h";
const VERDICTS: readonly string[] = ["ok", "email_10m", "email_1h", "ip_1h"];

/**
 * The visitor's IP. On Vercel both headers carry the client address and Vercel overwrites any
 * value the client sent, so they cannot be spoofed there. Null when absent or not an IP.
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

/** SHA-256 hex. The table keeps only these, never the address or the IP itself. */
export function limitHash(kind: "email" | "ip", value: string): string {
  return createHash("sha256").update(`otodoke:login-mail:${kind}:${value}`).digest("hex");
}

/** Take one login mail from the allowance. `email` must already be trimmed and lowercased. */
export async function claimLoginMail(email: string, ip: string | null): Promise<LoginMailVerdict> {
  try {
    const { data, error } = await createAdminClient().rpc("claim_login_mail", {
      p_email_hash: limitHash("email", email),
      // The generated type says string, but the function accepts null (address limits only).
      p_ip_hash: (ip ? limitHash("ip", ipLimitKey(ip)) : null) as string,
      p_email_10m_limit: LOGIN_MAIL_LIMITS.emailPer10Minutes,
      p_email_1h_limit: LOGIN_MAIL_LIMITS.emailPerHour,
      p_ip_1h_limit: LOGIN_MAIL_LIMITS.ipPerHour,
    });
    if (error) {
      console.warn("[login] mail limit check failed; sending anyway:", error.message);
      return "ok";
    }
    if (typeof data !== "string" || !VERDICTS.includes(data)) {
      console.warn("[login] mail limit check returned an unexpected value; sending anyway:", data);
      return "ok";
    }
    return data as LoginMailVerdict;
  } catch (err) {
    console.warn("[login] mail limit check failed; sending anyway:", err instanceof Error ? err.message : err);
    return "ok";
  }
}
