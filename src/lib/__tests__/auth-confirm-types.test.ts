import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LOGIN_MESSAGES, loginErrorMessage, verifyFailure } from "@/lib/login-errors";

/**
 * POST /auth/confirm by the link's type (password-v1):
 * - email, signup, magiclink: verified in a client that writes no cookie, its session ended at
 *   once, then /login?confirmed=1. This browser's session is not touched.
 * - recovery: verified on this browser's cookies, then always /reset-password (RESET_PATH); the
 *   link's next is never read.
 * - anything else: refused, the token unused.
 */

type VerifyAnswer = { data: { session: { access_token: string } | null }; error: { status?: number; code?: string; message?: string } | null };

const mocks = vi.hoisted(() => ({
  cookieVerify: vi.fn(),
  throwawayVerify: vi.fn(),
  endSession: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ auth: { verifyOtp: mocks.cookieVerify } }) }));
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({ auth: { verifyOtp: mocks.throwawayVerify, admin: { signOut: mocks.endSession } } }),
}));

const { GET, POST } = await import("@/app/auth/confirm/route");

const TOKEN = "token-hash-from-the-mail";
const SAME_SITE = { host: "otodoke.app", origin: "https://otodoke.app", "sec-fetch-site": "same-origin" };

async function post(fields: Record<string, string>, headers: Record<string, string> = SAME_SITE) {
  const body = new FormData();
  for (const [k, v] of Object.entries(fields)) body.set(k, v);
  const res = await POST(new NextRequest("https://otodoke.app/auth/confirm", { method: "POST", body, headers }));
  return { status: res.status, location: res.headers.get("location") };
}

const ok = (token = "made.session.token"): VerifyAnswer => ({ data: { session: { access_token: token } }, error: null });
const refusedWith = (error: VerifyAnswer["error"]): VerifyAnswer => ({ data: { session: null }, error });

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon");
  for (const fn of [mocks.cookieVerify, mocks.throwawayVerify, mocks.endSession]) fn.mockReset();
  mocks.cookieVerify.mockResolvedValue(ok());
  mocks.throwawayVerify.mockResolvedValue(ok());
  mocks.endSession.mockResolvedValue({ data: null, error: null });
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("a confirmation link (email, signup, magiclink)", () => {
  it.each(["email", "signup", "magiclink"])("type=%s: verified apart from this browser, the session ended, then the login", async (type) => {
    expect(await post({ token_hash: TOKEN, type, next: "/app/settings" })).toEqual({ status: 303, location: "/login?confirmed=1" });
    expect(mocks.throwawayVerify).toHaveBeenCalledWith({ type, token_hash: TOKEN });
    // This browser's cookies are never asked to hold it.
    expect(mocks.cookieVerify).not.toHaveBeenCalled();
    // That session only (local), never every session of the user (global, the default).
    expect(mocks.endSession).toHaveBeenCalledWith("made.session.token", "local");
  });

  it("still leads to the login when the session cannot be ended (the address is confirmed)", async () => {
    mocks.endSession.mockResolvedValue({ data: null, error: { status: 500, code: "unexpected_failure" } });
    expect(await post({ token_hash: TOKEN, type: "email" })).toEqual({ status: 303, location: "/login?confirmed=1" });
    mocks.endSession.mockRejectedValue(new TypeError("fetch failed"));
    expect(await post({ token_hash: TOKEN, type: "email" })).toEqual({ status: 303, location: "/login?confirmed=1" });
  });

  it.each([
    [{ status: 403, code: "otp_expired" }, "/login?error=link_invalid"],
    [{ status: 429, code: "over_request_rate_limit" }, "/login?error=link_limited"],
    [{ status: 500, code: "unexpected_failure" }, "/login?error=link_failed"],
    [{ status: 0 }, "/login?error=link_failed"],
  ] as const)("refused with %j: %s, and no session to end", async (error, location) => {
    mocks.throwawayVerify.mockResolvedValue(refusedWith(error));
    expect(await post({ token_hash: TOKEN, type: "email" })).toEqual({ status: 303, location });
    expect(mocks.endSession).not.toHaveBeenCalled();
  });

  it("says link_failed when verifyOtp throws", async () => {
    mocks.throwawayVerify.mockRejectedValue(new TypeError("fetch failed"));
    expect(await post({ token_hash: TOKEN, type: "email" })).toEqual({ status: 303, location: "/login?error=link_failed" });
  });
});

describe("a reset link (recovery)", () => {
  it.each([
    ["no next", {}],
    ["a next on this site", { next: "/app/settings" }],
    ["a next to another site", { next: "//evil.example" }],
    ["a next back into /auth/", { next: "/auth/continue?token_hash=x&type=recovery" }],
  ])("is verified on this browser's cookies and always leads to /reset-password, with %s", async (_what, extra) => {
    expect(await post({ token_hash: TOKEN, type: "recovery", ...extra })).toEqual({ status: 303, location: "/reset-password" });
    expect(mocks.cookieVerify).toHaveBeenCalledWith({ type: "recovery", token_hash: TOKEN });
    expect(mocks.throwawayVerify).not.toHaveBeenCalled();
    expect(mocks.endSession).not.toHaveBeenCalled();
  });

  it.each([
    [{ status: 403, code: "otp_expired" }, "/login?error=reset_link_invalid"],
    [{ status: 429 }, "/login?error=link_limited"],
    [{ status: 503 }, "/login?error=link_failed"],
  ] as const)("refused with %j: %s", async (error, location) => {
    mocks.cookieVerify.mockResolvedValue(refusedWith(error));
    expect(await post({ token_hash: TOKEN, type: "recovery" })).toEqual({ status: 303, location });
  });
});

describe("what is refused before Supabase is asked", () => {
  it.each(["email_change", "invite", "sms", "RECOVERY", "recovery "])("type=%s: link_invalid, the token unused", async (type) => {
    expect(await post({ token_hash: TOKEN, type })).toEqual({ status: 303, location: "/login?error=link_invalid" });
    expect(mocks.cookieVerify).not.toHaveBeenCalled();
    expect(mocks.throwawayVerify).not.toHaveBeenCalled();
  });

  it("no token or no type: link_incomplete", async () => {
    expect((await post({ type: "email" })).location).toBe("/login?error=link_incomplete");
    expect((await post({ token_hash: TOKEN })).location).toBe("/login?error=link_incomplete");
    expect(mocks.throwawayVerify).not.toHaveBeenCalled();
  });

  it("another site's form, of either kind", async () => {
    for (const type of ["email", "recovery"]) {
      expect(await post({ token_hash: TOKEN, type }, { host: "otodoke.app", origin: "https://evil.example", "sec-fetch-site": "cross-site" })).toEqual({
        status: 303,
        location: "/login?error=link_invalid",
      });
    }
    expect(mocks.cookieVerify).not.toHaveBeenCalled();
    expect(mocks.throwawayVerify).not.toHaveBeenCalled();
  });
});

describe("[R3-28] GET /auth/confirm carries the link's token_hash, type and next only", () => {
  it("drops everything else (link=refused, intent and any other field)", async () => {
    const res = await GET(new NextRequest("https://otodoke.app/auth/confirm?next=%2Fapp&token_hash=t&type=recovery&link=refused&intent=switch_account&x=1"));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("/auth/continue?token_hash=t&type=recovery&next=%2Fapp");
    // Negative control: the same check sees a field that is carried.
    expect(res.headers.get("location")).toContain("type=recovery");
  });
});

describe("the words for these codes", () => {
  it("are fixed, one per code, and the URL's text is never shown", () => {
    expect(loginErrorMessage("link_invalid")).toBe(LOGIN_MESSAGES.link_invalid);
    expect(loginErrorMessage("reset_link_invalid")).toBe("再設定のリンクは使えませんでした。もう一度、再設定のメールを送ってください。");
    expect(loginErrorMessage("link_limited")).toBe("ただいま混み合っています。少し時間をおいてから、もう一度メールのリンクを開いてください。");
    // The app's own limit can hold a link back for up to 10 minutes: no promise of a minute.
    expect(loginErrorMessage("link_limited")).not.toContain("1分");
    expect(loginErrorMessage("アカウントが停止されました https://evil.example")).toBe("ログインできませんでした。もう一度お試しください。");
    expect(loginErrorMessage("constructor")).toBe("ログインできませんでした。もう一度お試しください。");
    expect(loginErrorMessage(undefined)).toBeNull();
  });

  it("verifyFailure decides by status, never by the English text", () => {
    expect(verifyFailure({ status: 429, code: "x" })).toBe("limited");
    expect(verifyFailure({ status: 400, code: "over_request_rate_limit" })).toBe("limited");
    expect(verifyFailure({ status: 0 })).toBe("failed");
    expect(verifyFailure({})).toBe("failed");
    expect(verifyFailure({ status: 520 })).toBe("failed");
    expect(verifyFailure({ status: 403, code: "otp_expired" })).toBe("invalid");
    expect(verifyFailure({ status: 422 })).toBe("invalid");
  });
});
