import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * The login form asks Supabase to send a mail. Before that the app takes one send from its own
 * allowance (claim_login_mail): per address and per client IP. The RPC is mocked here; the SQL
 * itself was run against a local Postgres when it was written.
 *
 * Also covers /login?error=: the query carries a code, never the words shown.
 */

const mocks = vi.hoisted(() => ({
  otp: [] as Array<{ email: string }>,
  otpError: null as null | { status: number; code: string; message: string },
  verifyError: null as null | { status: number; code: string; message: string },
  rpc: vi.fn(),
  adminThrows: false,
  headers: new Headers(),
}));

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
}));
vi.mock("next/headers", () => ({ headers: async () => mocks.headers }));
vi.mock("next/link", async () => {
  const { createElement: h } = await import("react");
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const Link = ({ href, children, prefetch, ...rest }: Record<string, unknown>) => h("a", { href: String(href), ...rest }, children as never);
  return { default: Link };
});
// next/font only works inside the Next.js compiler.
vi.mock("@/components/wordmark", () => ({ Wordmark: () => "Otodoke" }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: {
      signInWithOtp: async (args: { email: string }) => {
        mocks.otp.push(args);
        return { error: mocks.otpError };
      },
      verifyOtp: async () => ({ error: mocks.verifyError }),
    },
  }),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => {
    if (mocks.adminThrows) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not set");
    return { rpc: mocks.rpc };
  },
}));

const EMAIL = "someone@example.com";
const CLAIM_ID = 41;
/** What PostgREST returns for claim_login_mail (a set-returning function): one row. */
const claimAnswer = (verdict: string, claimId: number | null = verdict === "ok" ? CLAIM_ID : null) => ({
  data: [{ verdict, claim_id: claimId }],
  error: null,
});
const rpcCalls = (fn: string) => mocks.rpc.mock.calls.filter(([name]) => name === fn);
const IP = "203.0.113.7";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

async function submit(email = EMAIL): Promise<string> {
  const { sendMagicLink } = await import("@/app/login/actions");
  const form = new FormData();
  form.set("email", email);
  form.set("next", "/app");
  try {
    await sendMagicLink(form);
  } catch (error) {
    return (error as Error).message;
  }
  return "no redirect";
}

async function loginPage(params: Record<string, string>): Promise<string> {
  const Page = (await import("@/app/login/page")).default as unknown as (p: { searchParams: Promise<Record<string, string>> }) => Promise<Parameters<typeof renderToStaticMarkup>[0]>;
  return renderToStaticMarkup(await Page({ searchParams: Promise.resolve(params) }));
}

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon");
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://otodoke.app");
  vi.stubEnv("VERCEL_ENV", "production");
  mocks.otp.length = 0;
  mocks.otpError = null;
  mocks.verifyError = null;
  mocks.adminThrows = false;
  mocks.rpc.mockReset();
  mocks.headers = new Headers({ "x-forwarded-for": `${IP}, 10.0.0.1`, "x-real-ip": IP });
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("sendMagicLink with the mail limit", () => {
  it("sends when the limit allows, passing only hashes and the limits", async () => {
    mocks.rpc.mockResolvedValue(claimAnswer("ok"));
    expect(await submit()).toBe(`REDIRECT:/login?sent=${encodeURIComponent(EMAIL)}`);
    expect(mocks.otp).toHaveLength(1);
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    const [fn, args] = mocks.rpc.mock.calls[0];
    expect(fn).toBe("claim_login_mail");
    expect(args).toEqual({
      p_email_hash: sha(`otodoke:login-mail:email:${EMAIL}`),
      p_ip_hash: sha(`otodoke:login-mail:ip:${IP}`),
      p_email_10m_limit: 3,
      p_email_1h_limit: 6,
      p_ip_1h_limit: 10,
    });
    // Raw values never reach the database.
    expect(JSON.stringify(args)).not.toContain(EMAIL);
    expect(JSON.stringify(args)).not.toContain(IP);
  });

  it("hashes the address as typed in any case and with spaces the same way", async () => {
    mocks.rpc.mockResolvedValue(claimAnswer("ok"));
    await submit("  SomeOne@Example.COM ");
    expect(mocks.rpc.mock.calls[0][1].p_email_hash).toBe(sha(`otodoke:login-mail:email:${EMAIL}`));
  });

  it.each(["email_10m", "email_1h", "ip_1h"] as const)("sends nothing and shows a fixed wait message when the answer is %s", async (verdict) => {
    mocks.rpc.mockResolvedValue(claimAnswer(verdict));
    const result = await submit();
    expect(result).toBe(`REDIRECT:/login?error=${verdict}`);
    expect(mocks.otp).toHaveLength(0);
    const html = await loginPage({ error: verdict });
    expect(html).toContain(verdict === "email_10m" ? "10分ほど待って" : "1時間ほど待って");
  });

  it("still sends, and warns, when the limit check returns an error", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { message: "function public.claim_login_mail does not exist" } });
    expect(await submit()).toBe(`REDIRECT:/login?sent=${encodeURIComponent(EMAIL)}`);
    expect(mocks.otp).toHaveLength(1);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("limit check failed"), expect.stringContaining("does not exist"));
  });

  it("still sends when the limit check throws (no service key, network)", async () => {
    mocks.adminThrows = true;
    expect(await submit()).toBe(`REDIRECT:/login?sent=${encodeURIComponent(EMAIL)}`);
    expect(mocks.otp).toHaveLength(1);
    expect(console.warn).toHaveBeenCalled();
  });

  it("still sends when the limit check answers something unknown", async () => {
    mocks.rpc.mockResolvedValue({ data: "maybe", error: null });
    await submit();
    expect(mocks.otp).toHaveLength(1);
  });

  it("checks only the address limits when there is no client IP", async () => {
    mocks.headers = new Headers();
    mocks.rpc.mockResolvedValue(claimAnswer("ok"));
    await submit();
    expect(mocks.rpc.mock.calls[0][1].p_ip_hash).toBeNull();
    expect(mocks.otp).toHaveLength(1);
  });

  it("does not take from the allowance for an address it will not send to", async () => {
    expect(await submit("not-an-address")).toBe("REDIRECT:/login?error=invalid_email");
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("puts a code in the URL, not Supabase's message, when Supabase refuses", async () => {
    mocks.rpc.mockResolvedValue(claimAnswer("ok"));
    mocks.otpError = { status: 429, code: "over_email_send_rate_limit", message: "email rate limit exceeded" };
    expect(await submit()).toBe("REDIRECT:/login?error=busy");
    mocks.otpError = { status: 500, code: "unexpected_failure", message: "Error sending magic link email" };
    expect(await submit()).toBe("REDIRECT:/login?error=send_failed");
  });
});

describe("a send Supabase refuses does not count", () => {
  /** claim_login_mail answers `claim`; release_login_mail answers `release` (or throws it). */
  function answer(claim: ReturnType<typeof claimAnswer>, release: unknown = { data: 1, error: null }) {
    mocks.rpc.mockImplementation(async (fn: string) => {
      if (fn === "claim_login_mail") return claim;
      if (fn === "release_login_mail") {
        if (release instanceof Error) throw release;
        return release;
      }
      throw new Error(`unexpected rpc ${fn}`);
    });
  }

  it.each([
    [429, "over_email_send_rate_limit", "busy"],
    [500, "unexpected_failure", "send_failed"],
  ] as const)("gives back exactly the claimed send when Supabase answers %i", async (status, code, shown) => {
    answer(claimAnswer("ok", 77));
    mocks.otpError = { status, code, message: "refused" };
    expect(await submit()).toBe(`REDIRECT:/login?error=${shown}`);
    expect(mocks.otp).toHaveLength(1);
    const releases = rpcCalls("release_login_mail");
    expect(releases).toHaveLength(1);
    // Only that row, and only for this address (hash, never the address itself).
    expect(releases[0][1]).toEqual({ p_claim_id: 77, p_email_hash: sha(`otodoke:login-mail:email:${EMAIL}`) });
    expect(JSON.stringify(releases[0][1])).not.toContain(EMAIL);
  });

  it("keeps the send counted when the mail went out", async () => {
    answer(claimAnswer("ok", 77));
    expect(await submit()).toBe(`REDIRECT:/login?sent=${encodeURIComponent(EMAIL)}`);
    expect(rpcCalls("claim_login_mail")).toHaveLength(1);
    expect(rpcCalls("release_login_mail")).toHaveLength(0);
  });

  it("does not release anything when nothing was claimed (the limit check had failed open)", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { message: "function public.claim_login_mail does not exist" } });
    mocks.otpError = { status: 429, code: "over_email_send_rate_limit", message: "refused" };
    expect(await submit()).toBe("REDIRECT:/login?error=busy");
    expect(rpcCalls("release_login_mail")).toHaveLength(0);
  });

  it("still shows the send error, and warns, when giving the send back returns an error", async () => {
    answer(claimAnswer("ok", 77), { data: null, error: { message: "permission denied for function release_login_mail" } });
    mocks.otpError = { status: 429, code: "over_email_send_rate_limit", message: "refused" };
    expect(await submit()).toBe("REDIRECT:/login?error=busy");
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("could not give back"), expect.stringContaining("permission denied"));
  });

  it("still shows the send error, and warns, when giving the send back throws", async () => {
    answer(claimAnswer("ok", 77), new Error("fetch failed"));
    mocks.otpError = { status: 500, code: "unexpected_failure", message: "refused" };
    expect(await submit()).toBe("REDIRECT:/login?error=send_failed");
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("could not give back"), "fetch failed");
  });

  it("releaseLoginMail never throws, even without a service key", async () => {
    const { releaseLoginMail } = await import("../login-mail-limit");
    mocks.adminThrows = true;
    await expect(releaseLoginMail(EMAIL, 77)).resolves.toBeUndefined();
    await expect(releaseLoginMail(EMAIL, null)).resolves.toBeUndefined();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("reads the claim id only from an 'ok' row", async () => {
    const { claimLoginMail } = await import("../login-mail-limit");
    mocks.rpc.mockResolvedValue(claimAnswer("ok", 5));
    expect(await claimLoginMail(EMAIL, null)).toEqual({ verdict: "ok", claimId: 5 });
    mocks.rpc.mockResolvedValue(claimAnswer("email_10m", 5));
    expect(await claimLoginMail(EMAIL, null)).toEqual({ verdict: "email_10m", claimId: null });
    mocks.rpc.mockResolvedValue({ data: [], error: null });
    expect(await claimLoginMail(EMAIL, null)).toEqual({ verdict: "ok", claimId: null });
  });
});

describe("client IP and its key", () => {
  it("takes the first x-forwarded-for hop, then x-real-ip, and ignores non-addresses", async () => {
    const { clientIp } = await import("../login-mail-limit");
    expect(clientIp(new Headers({ "x-forwarded-for": "198.51.100.1, 10.0.0.1" }))).toBe("198.51.100.1");
    expect(clientIp(new Headers({ "x-real-ip": "198.51.100.2" }))).toBe("198.51.100.2");
    expect(clientIp(new Headers({ "x-forwarded-for": "unknown" }))).toBeNull();
    expect(clientIp(new Headers())).toBeNull();
  });

  it("counts IPv6 per /64 and IPv4-mapped addresses as IPv4", async () => {
    const { ipLimitKey } = await import("../login-mail-limit");
    expect(ipLimitKey("203.0.113.7")).toBe("203.0.113.7");
    expect(ipLimitKey("2001:db8:1:2:aaaa:bbbb:cccc:dddd")).toBe("2001:db8:1:2::/64");
    expect(ipLimitKey("2001:0DB8:0001:0002::1")).toBe("2001:db8:1:2::/64");
    expect(ipLimitKey("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(ipLimitKey("::1")).toBe("0:0:0:0::/64");
    expect(ipLimitKey("::ffff:203.0.113.7")).toBe("203.0.113.7");
    expect(ipLimitKey("64:ff9b::203.0.113.7")).toBe("64:ff9b:0:0::/64");
  });
});

describe("/login?error= shows fixed wording", () => {
  it("keeps the wording of the known cases", async () => {
    expect(await loginPage({ error: "invalid_email" })).toContain("メールアドレスの形式を確認してください");
    expect(await loginPage({ error: "not_configured" })).toContain("ログインの設定に問題があり、メールを送れませんでした");
    expect(await loginPage({ error: "link_incomplete" })).toContain("リンクが不完全です。もう一度リンクを送ってください。");
  });

  it("never prints the query text; an unknown code gets a generic message", async () => {
    const html = await loginPage({ error: "アカウントが停止されました。https://evil.example に連絡してください" });
    expect(html).not.toContain("evil.example");
    expect(html).not.toContain("停止");
    expect(html).toContain("ログインできませんでした。もう一度リンクを送ってください。");
  });

  it("does not treat names on Object.prototype as codes", async () => {
    const html = await loginPage({ error: "constructor" });
    expect(html).toContain("ログインできませんでした。もう一度リンクを送ってください。");
  });

  it("echoes ?sent= only when it is a plain address", async () => {
    expect(await loginPage({ sent: EMAIL })).toContain(`${EMAIL} にリンクを送りました。`);
    const html = await loginPage({ sent: "サポートに電話してください 0120-000-000" });
    expect(html).not.toContain("0120");
    expect(html).toContain("リンクを送りました。");
  });
});

describe("/auth/confirm puts codes in the URL", () => {
  async function post(fields: Record<string, string>): Promise<string | null> {
    const { POST } = await import("@/app/auth/confirm/route");
    const body = new FormData();
    for (const [k, v] of Object.entries(fields)) body.set(k, v);
    const { NextRequest } = await import("next/server");
    const res = await POST(new NextRequest("https://otodoke.app/auth/confirm", { method: "POST", body }));
    return res.headers.get("location");
  }

  it("reports a failed verification as link_invalid without Supabase's message", async () => {
    mocks.verifyError = { status: 403, code: "otp_expired", message: "Email link is invalid or has expired" };
    expect(await post({ token_hash: "t", type: "magiclink", next: "/app" })).toBe("/login?error=link_invalid");
  });

  it("reports a missing token as link_incomplete", async () => {
    expect(await post({ type: "magiclink" })).toBe("/login?error=link_incomplete");
  });
});
