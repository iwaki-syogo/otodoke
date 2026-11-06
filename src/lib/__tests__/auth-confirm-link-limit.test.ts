import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Review R3-PW-4: Supabase checks a mail's token at most 30 times per 5 minutes per IP, and every
 * visitor's link is checked from this server's IP. Without a limit of the app's own, one visitor
 * posting made-up tokens to /auth/confirm could use that up, and meanwhile every confirmation and
 * reset link would fail for everyone. The POST now takes one check from the client IP's allowance
 * first (claim_login_mail under a namespace of its own, like the sign-in tries; the SQL is not
 * changed) and answers /login?error=link_limited past it, before Supabase is asked.
 *
 * claim_login_mail is played here by the same counting as its SQL (supabase/migrations/20261106100000).
 */

const MINUTE = 60_000;
const NOW = Date.UTC(2026, 10, 7, 1, 0, 0);
const IP = "203.0.113.7";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** login_mail_sends and claim_login_mail, as the migration has them (prune > 1 h, then the three counts, then the row). */
const table = vi.hoisted(() => ({ rows: [] as Array<{ id: number; email_hash: string; ip_hash: string | null; sent_at: number }>, seq: 0, failing: false }));
const mocks = vi.hoisted(() => ({ cookieVerify: vi.fn(), throwawayVerify: vi.fn(), endSession: vi.fn(), rpc: vi.fn() }));

function claimLoginMail(args: { p_email_hash: string; p_ip_hash: string | null; p_email_10m_limit: number; p_email_1h_limit: number; p_ip_1h_limit: number }) {
  const now = Date.now();
  table.rows = table.rows.filter((r) => r.sent_at >= now - 60 * MINUTE);
  const since = (ms: number, match: (r: (typeof table.rows)[number]) => boolean) => table.rows.filter((r) => match(r) && r.sent_at > now - ms).length;
  if (since(10 * MINUTE, (r) => r.email_hash === args.p_email_hash) >= args.p_email_10m_limit) return [{ verdict: "email_10m", claim_id: null }];
  if (since(60 * MINUTE, (r) => r.email_hash === args.p_email_hash) >= args.p_email_1h_limit) return [{ verdict: "email_1h", claim_id: null }];
  if (args.p_ip_hash && since(60 * MINUTE, (r) => r.ip_hash === args.p_ip_hash) >= args.p_ip_1h_limit) return [{ verdict: "ip_1h", claim_id: null }];
  table.rows.push({ id: ++table.seq, email_hash: args.p_email_hash, ip_hash: args.p_ip_hash, sent_at: now });
  return [{ verdict: "ok", claim_id: table.seq }];
}

vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ auth: { verifyOtp: mocks.cookieVerify } }) }));
vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({ auth: { verifyOtp: mocks.throwawayVerify, admin: { signOut: mocks.endSession } } }) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ rpc: mocks.rpc }) }));

const { POST } = await import("@/app/auth/confirm/route");
const limits = await import("@/lib/login-mail-limit");

const SAME_SITE = { host: "otodoke.app", origin: "https://otodoke.app", "sec-fetch-site": "same-origin" };

async function post(fields: Record<string, string>, { ip = IP as string | null, headers = SAME_SITE as Record<string, string> } = {}) {
  const body = new FormData();
  for (const [k, v] of Object.entries(fields)) body.set(k, v);
  const all: Record<string, string> = { ...headers, ...(ip ? { "x-forwarded-for": `${ip}, 10.0.0.1` } : {}) };
  const res = await POST(new NextRequest("https://otodoke.app/auth/confirm", { method: "POST", body, headers: all }));
  return { status: res.status, location: res.headers.get("location") };
}

const confirmLink = (token = "token-of-the-confirmation-mail") => ({ token_hash: token, type: "signup" });
const resetLink = (token = "token-of-the-reset-mail") => ({ token_hash: token, type: "recovery" });
const verified = () => mocks.cookieVerify.mock.calls.length + mocks.throwawayVerify.mock.calls.length;
const LIMITED = { status: 303, location: "/login?error=link_limited" };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon");
  table.rows = [];
  table.seq = 0;
  for (const fn of Object.values(mocks)) fn.mockReset();
  mocks.rpc.mockImplementation(async (fn: string, args: Parameters<typeof claimLoginMail>[0]) =>
    fn === "claim_login_mail" ? { data: claimLoginMail(args), error: null } : { data: null, error: { message: `unexpected ${fn}` } },
  );
  mocks.cookieVerify.mockResolvedValue({ data: { session: { access_token: "a.b.c" } }, error: null });
  mocks.throwawayVerify.mockResolvedValue({ data: { session: { access_token: "a.b.c" } }, error: null });
  mocks.endSession.mockResolvedValue({ data: null, error: null });
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("POST /auth/confirm takes from the client IP's allowance before Supabase checks the token", () => {
  it("counts the IP as a hash under its own namespace, never the IP itself, and only then verifies", async () => {
    mocks.rpc.mockImplementation(async (_fn: string, args: Parameters<typeof claimLoginMail>[0]) => {
      expect(verified()).toBe(0);
      return { data: claimLoginMail(args), error: null };
    });
    expect(await post(confirmLink())).toEqual({ status: 303, location: "/auth/confirmed" });
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    const [fn, args] = mocks.rpc.mock.calls[0] as [string, Record<string, unknown>];
    expect(fn).toBe("claim_login_mail");
    expect(args).toEqual({ p_email_hash: sha(`otodoke:login-link:email:${IP}`), p_ip_hash: null, p_email_10m_limit: 10, p_email_1h_limit: 60, p_ip_1h_limit: 60 });
    expect(JSON.stringify(args)).not.toContain(IP);
    expect(verified()).toBe(1);
  });

  it("a person who opens the confirmation and the reset links a few times, and presses again, is never held back", async () => {
    mocks.throwawayVerify.mockResolvedValueOnce({ data: { session: { access_token: "a.b.c" } }, error: null });
    // Pressed again after it went through: Supabase answers that the token is used.
    mocks.throwawayVerify.mockResolvedValue({ data: { session: null }, error: { status: 403, code: "otp_expired" } });
    for (let i = 0; i < 3; i++) await post(confirmLink());
    for (let i = 0; i < 3; i++) {
      vi.setSystemTime(Date.now() + MINUTE);
      expect(await post(resetLink(`reset-${i}`))).toEqual({ status: 303, location: "/reset-password" });
    }
    expect(verified()).toBe(6);
    expect(console.warn).not.toHaveBeenCalledWith("[auth] link limited:", expect.anything());
  });

  it("one visitor posting made-up tokens is stopped at the 11th in 10 minutes, without Supabase being asked, and the link works again later", async () => {
    mocks.throwawayVerify.mockResolvedValue({ data: { session: null }, error: { status: 403, code: "otp_expired" } });
    for (let i = 0; i < 10; i++) expect(await post(confirmLink(`made-up-${i}`))).toEqual({ status: 303, location: "/login?error=link_invalid" });
    expect(verified()).toBe(10);

    expect(await post(confirmLink("made-up-10"))).toEqual(LIMITED);
    expect(await post(resetLink())).toEqual(LIMITED);
    expect(verified()).toBe(10);

    // Another visitor is not held back by it.
    mocks.throwawayVerify.mockResolvedValue({ data: { session: { access_token: "a.b.c" } }, error: null });
    expect(await post(confirmLink(), { ip: "198.51.100.23" })).toEqual({ status: 303, location: "/auth/confirmed" });

    // Ten minutes after the first: the same visitor's link is checked again (its token was never sent).
    vi.setSystemTime(NOW + 10 * MINUTE + 1000);
    expect(await post(resetLink())).toEqual({ status: 303, location: "/reset-password" });
    expect(mocks.cookieVerify).toHaveBeenCalledWith({ type: "recovery", token_hash: "token-of-the-reset-mail" });
  });

  it("keeps one IP under Supabase's 30 checks per 5 minutes", () => {
    expect(limits.LOGIN_LINK_LIMITS.ipPer10Minutes).toBeLessThan(30);
    expect(limits.LOGIN_LINK_LIMITS.ipPer10Minutes).toBeGreaterThanOrEqual(10);
  });
});

describe("what is not counted", () => {
  it("a post that never reaches Supabase: from another site, incomplete, of an unknown type", async () => {
    expect(await post(confirmLink(), { headers: { host: "otodoke.app", origin: "https://evil.example", "sec-fetch-site": "cross-site" } })).toEqual({ status: 303, location: "/login?error=link_invalid" });
    expect(await post({ type: "signup" })).toEqual({ status: 303, location: "/login?error=link_incomplete" });
    expect(await post({ token_hash: "t", type: "invite" })).toEqual({ status: 303, location: "/login?error=link_invalid" });
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(verified()).toBe(0);
  });

  it("without a client IP there is nothing to count by: the link is checked", async () => {
    expect(await post(confirmLink(), { ip: null })).toEqual({ status: 303, location: "/auth/confirmed" });
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(verified()).toBe(1);
  });

  it("a check that fails lets the link through (a broken limit must not stop every link), and says so in the log", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { message: "function claim_login_mail does not exist" } });
    expect(await post(resetLink())).toEqual({ status: 303, location: "/reset-password" });
    expect(verified()).toBe(1);
    expect(console.warn).toHaveBeenCalledWith("[login] link limit check failed; going ahead:", "function claim_login_mail does not exist");
  });
});

describe("README says the same", () => {
  it("the links are limited per connection, like the mails and the sign-ins", () => {
    const readme = readFileSync(path.join(process.cwd(), "README.md"), "utf8");
    const line = readme.split("\n").find((l) => l.startsWith("- **確認と再設定のメール、ログイン**"));
    expect(line).toContain("メールアドレスごと・接続ごとに回数の上限を置きます");
    expect(line).toContain("メールのリンクの確認にも、接続ごとの上限を置きます");
  });
});
