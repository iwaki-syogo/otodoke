import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { renderToStaticMarkup } from "react-dom/server";
import { LOGIN_ERROR_MESSAGES, verifyFailure } from "@/lib/login-errors";

/**
 * Review R2-7 / F-6: what the login page says when a mail's link does not sign the visitor in.
 *
 * - link_invalid no longer says the link was expired or used: /auth/confirm also answers it when
 *   it refuses a POST from another site, and then the token was not used at all. It points to the
 *   newest mail (a new send replaces the token of the mails before it).
 * - verifyOtp's 429 (Supabase's limit on verifications) and its outages (no answer, 5xx, an answer
 *   that is not Supabase's, a throw) are not link_invalid: the same link works again later, and
 *   the limit's message says how long to wait.
 */

const mocks = vi.hoisted(() => ({ verifyOtp: vi.fn() }));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { verifyOtp: mocks.verifyOtp } }),
}));
vi.mock("next/link", async () => {
  const { createElement: h } = await import("react");
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const Link = ({ href, children, prefetch, ...rest }: Record<string, unknown>) => h("a", { href: String(href), ...rest }, children as never);
  return { default: Link };
});
// next/font only works inside the Next.js compiler.
vi.mock("@/components/wordmark", () => ({ Wordmark: () => "Otodoke" }));

const { POST } = await import("@/app/auth/confirm/route");

const SAME_SITE = { host: "otodoke.app", origin: "https://otodoke.app", "sec-fetch-site": "same-origin" };

async function confirm(headers: Record<string, string> = SAME_SITE): Promise<string | null> {
  const body = new FormData();
  body.set("token_hash", "a-token-hash");
  body.set("type", "email");
  body.set("next", "/app");
  const res = await POST(new NextRequest("https://otodoke.app/auth/confirm", { method: "POST", body, headers }));
  expect(res.status).toBe(303);
  return res.headers.get("location");
}

async function loginPage(params: Record<string, string>): Promise<string> {
  const Page = (await import("@/app/login/page")).default as unknown as (p: { searchParams: Promise<Record<string, string>> }) => Promise<Parameters<typeof renderToStaticMarkup>[0]>;
  return renderToStaticMarkup(await Page({ searchParams: Promise.resolve(params) }));
}

/** What supabase-js returns for each kind of failure (auth-js lib/fetch.js handleError). */
const apiError = (status: number, code: string, message: string) => ({ data: { user: null, session: null }, error: { name: "AuthApiError", status, code, message } });
const retryable = (status: number, message: string) => ({ data: { user: null, session: null }, error: { name: "AuthRetryableFetchError", status, code: undefined, message } });
const unknown = (message: string) => ({ data: { user: null, session: null }, error: { name: "AuthUnknownError", status: undefined, code: undefined, message } });

beforeEach(() => {
  mocks.verifyOtp.mockReset();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("link_invalid fits every way a link can fail to verify", () => {
  it("does not claim the link was expired or used, and points to the newest mail", () => {
    const text = LOGIN_ERROR_MESSAGES.link_invalid;
    expect(text).not.toContain("期限切れ");
    expect(text).not.toContain("使われた");
    expect(text).not.toMatch(/[（(]/);
    expect(text).toContain("いちばん新しいメールのリンク");
    expect(text).toBe("リンクを確認できませんでした。いちばん新しいメールのリンクを開くか、もう一度リンクを送ってください。");
  });

  it("is what a POST from another site gets, with the token left unused", async () => {
    expect(await confirm({ host: "otodoke.app", origin: "https://evil.example", "sec-fetch-site": "cross-site" })).toBe("/login?error=link_invalid");
    expect(mocks.verifyOtp).not.toHaveBeenCalled();
  });

  it.each([
    ["a wrong, expired, used or replaced token (403 otp_expired)", apiError(403, "otp_expired", "Email link is invalid or has expired")],
    ["a value that cannot be a token (400)", apiError(400, "validation_failed", "Verify requires either a token or a token hash")],
    ["a refused account (403 user_banned)", apiError(403, "user_banned", "User is banned")],
  ])("is what %s gets", async (_label, answer) => {
    mocks.verifyOtp.mockResolvedValue(answer);
    expect(await confirm()).toBe("/login?error=link_invalid");
    expect(mocks.verifyOtp).toHaveBeenCalledWith({ type: "email", token_hash: "a-token-hash" });
  });
});

describe("a limit or an outage is not link_invalid", () => {
  it("tells Supabase's verification limit (429) apart, with the wait", async () => {
    mocks.verifyOtp.mockResolvedValue(apiError(429, "over_request_rate_limit", "Request rate limit reached"));
    expect(await confirm()).toBe("/login?error=link_limited");
    const html = await loginPage({ error: "link_limited" });
    expect(html).toContain("ただいま混み合っています。1分ほど待ってから、もう一度メールのリンクを開いてください。");
    expect(html).not.toContain("Request rate limit");
  });

  it.each([
    ["no answer (fetch failed)", retryable(0, "fetch failed")],
    ["500", retryable(500, "Internal Server Error")],
    ["502 from the gateway", retryable(502, "HTTP 502")],
    ["Cloudflare's 522", retryable(522, "HTTP 522")],
    ["an answer that is not Supabase's (no status)", unknown("Unexpected token < in JSON")],
  ])("says to try the link again later for %s", async (_label, answer) => {
    mocks.verifyOtp.mockResolvedValue(answer);
    expect(await confirm()).toBe("/login?error=link_failed");
  });

  it("says the same when verifyOtp throws instead of answering", async () => {
    mocks.verifyOtp.mockRejectedValue(new Error("An error occurred on token verification."));
    expect(await confirm()).toBe("/login?error=link_failed");
    const html = await loginPage({ error: "link_failed" });
    expect(html).toContain("いまはログインできませんでした。少し時間をおいて、もう一度メールのリンクを開いてください。");
    expect(html).not.toContain("token verification");
  });

  it("still signs in when Supabase accepts the token", async () => {
    mocks.verifyOtp.mockResolvedValue({ data: { user: {}, session: {} }, error: null });
    expect(await confirm()).toBe("/app");
  });
});

describe("verifyFailure decides by status, never by the English text", () => {
  it("reads 429 as the limit, no status or 5xx as an outage, any other answer as a refused token", () => {
    expect(verifyFailure({ status: 429, code: "over_request_rate_limit" })).toBe("limited");
    expect(verifyFailure({ status: 429 })).toBe("limited");
    expect(verifyFailure({ status: 400, code: "over_request_rate_limit" })).toBe("limited");
    for (const status of [0, undefined, 500, 503, 504, 522, 530]) expect(verifyFailure({ status }), String(status)).toBe("failed");
    for (const status of [400, 401, 403, 404, 422]) expect(verifyFailure({ status, code: "otp_expired" }), String(status)).toBe("invalid");
    // English that sounds like a limit does not make a 403 one.
    expect(verifyFailure({ status: 403, code: "otp_expired" })).toBe("invalid");
  });
});
