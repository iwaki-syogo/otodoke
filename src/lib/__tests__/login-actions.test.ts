import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The login screens' Actions (src/app/login/actions.ts → src/lib/login-auth.ts): what each sends
 * Supabase, which result code each answer becomes, and the app's own limits. Supabase is mocked;
 * the limit RPCs are mocked here and their SQL has its own tests (login-mail-limit.test.ts).
 */

type AuthError = { status?: number; code?: string; message?: string; name?: string };

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  signIn: vi.fn(),
  signUp: vi.fn(),
  resend: vi.fn(),
  reset: vi.fn(),
  endSession: vi.fn(),
  headers: new Headers(),
}));

vi.mock("next/headers", () => ({ headers: async () => mocks.headers }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ rpc: mocks.rpc }) }));
// This browser's cookies: only the sign-in uses them.
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ auth: { signInWithPassword: mocks.signIn } }) }));
// The client that keeps no session: the mails.
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({ auth: { signUp: mocks.signUp, resend: mocks.resend, resetPasswordForEmail: mocks.reset, admin: { signOut: mocks.endSession } } }),
}));

const { signInWithAuthSecret, signUpWithAuthSecret, resendConfirmation, sendResetMail } = await import("@/app/login/actions");

const EMAIL = "someone@example.com";
// Shaped like a login secret, and unique so a leak into a log line is easy to spot.
const SECRET = "5ec7e7".padEnd(64, "0");
const TOKEN = "0.zTm7bLh4Qx-TOKEN-SHOULD-NEVER-BE-LOGGED-9f8e7d6c5b4a";
const IP = "203.0.113.7";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const calls = (fn: string) => mocks.rpc.mock.calls.filter(([name]) => name === fn);

/** claim_login_mail answers `verdict` (claim id 41 when ok); release_login_mail answers 1. */
function limits(verdict = "ok") {
  mocks.rpc.mockImplementation(async (fn: string) =>
    fn === "claim_login_mail" ? { data: [{ verdict, claim_id: verdict === "ok" ? 41 : null }], error: null } : { data: 1, error: null },
  );
}

function consoleText(): string {
  return (["log", "info", "warn", "error", "debug"] as const)
    .flatMap((level) => vi.mocked(console[level]).mock.calls)
    .map((args) => args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "))
    .join("\n");
}

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon");
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://otodoke.app");
  vi.stubEnv("VERCEL_ENV", "production");
  mocks.headers = new Headers({ "x-real-ip": IP });
  for (const fn of [mocks.rpc, mocks.signIn, mocks.signUp, mocks.resend, mocks.reset, mocks.endSession]) fn.mockReset();
  limits();
  mocks.signIn.mockResolvedValue({ data: { user: { id: "user-1" }, session: { access_token: "a.b.c" } }, error: null });
  mocks.signUp.mockResolvedValue({ data: { user: { id: "user-1" }, session: null }, error: null });
  mocks.resend.mockResolvedValue({ data: {}, error: null });
  mocks.reset.mockResolvedValue({ data: {}, error: null });
  mocks.endSession.mockResolvedValue({ data: null, error: null });
  for (const level of ["log", "info", "warn", "error", "debug"] as const) vi.spyOn(console, level).mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("signInWithAuthSecret", () => {
  it("signs in on this browser with the login secret as the password, and answers the user id without a redirect", async () => {
    expect(await signInWithAuthSecret({ email: " SomeOne@Example.COM\n", authSecret: SECRET, captchaToken: TOKEN })).toEqual({ ok: true, userId: "user-1" });
    expect(mocks.signIn).toHaveBeenCalledTimes(1);
    // The address as password-v1 reads it (email_norm), the same text the browser salted with.
    expect(mocks.signIn).toHaveBeenCalledWith({ email: EMAIL, password: SECRET, options: { captchaToken: TOKEN } });
  });

  it.each([
    ["a wrong address or secret", { status: 400, code: "invalid_credentials" }, "credentials"],
    ["an address not confirmed yet", { status: 400, code: "email_not_confirmed" }, "not_confirmed"],
    ["Supabase's own limit", { status: 429, code: "over_request_rate_limit" }, "rate"],
    ["a 429 without a code", { status: 429 }, "rate"],
    ["a refused bot check", { status: 400, code: "captcha_failed" }, "captcha"],
    ["no answer", { status: 0, name: "AuthRetryableFetchError" }, "network"],
    ["a 5xx", { status: 502 }, "network"],
    ["an answer that was not Supabase's", { name: "AuthUnknownError" }, "network"],
    ["anything else", { status: 400, code: "user_banned" }, "other"],
  ] as const)("answers %s as %s", async (_what, error, code) => {
    mocks.signIn.mockResolvedValue({ data: { user: null, session: null }, error: { ...error, message: `Supabase says something about ${EMAIL}` } });
    expect(await signInWithAuthSecret({ email: EMAIL, authSecret: SECRET })).toEqual({ ok: false, code });
  });

  it("answers network when the call throws", async () => {
    mocks.signIn.mockRejectedValue(new TypeError("fetch failed"));
    expect(await signInWithAuthSecret({ email: EMAIL, authSecret: SECRET })).toEqual({ ok: false, code: "network" });
  });

  it("decides by the code, never the English text", async () => {
    mocks.signIn.mockResolvedValue({ data: { user: null, session: null }, error: { status: 400, code: "invalid_credentials", message: "Email not confirmed" } });
    expect(await signInWithAuthSecret({ email: EMAIL, authSecret: SECRET })).toEqual({ ok: false, code: "credentials" });
  });

  it("counts only a wrong address or secret: claims an attempt before asking, keeps it on credentials, gives it back otherwise", async () => {
    mocks.signIn.mockResolvedValue({ data: { user: null, session: null }, error: { status: 400, code: "invalid_credentials" } });
    await signInWithAuthSecret({ email: EMAIL, authSecret: SECRET });
    const [[, claim]] = calls("claim_login_mail");
    // Its own namespace, and the numbers of LOGIN_ATTEMPT_LIMITS; hashes only.
    expect(claim).toEqual({
      p_email_hash: sha(`otodoke:login-attempt:email:${EMAIL}`),
      p_ip_hash: sha(`otodoke:login-attempt:ip:${IP}`),
      p_email_10m_limit: 10,
      p_email_1h_limit: 20,
      p_ip_1h_limit: 50,
    });
    expect(claim.p_email_hash).not.toBe(sha(`otodoke:login-mail:email:${EMAIL}`));
    expect(calls("release_login_mail")).toHaveLength(0);

    for (const answer of [
      { data: { user: { id: "user-1" }, session: {} }, error: null },
      { data: { user: null, session: null }, error: { status: 400, code: "email_not_confirmed" } },
      { data: { user: null, session: null }, error: { status: 429, code: "over_request_rate_limit" } },
      { data: { user: null, session: null }, error: { status: 0 } },
    ]) {
      mocks.rpc.mockClear();
      mocks.signIn.mockResolvedValue(answer);
      await signInWithAuthSecret({ email: EMAIL, authSecret: SECRET });
      expect(calls("release_login_mail")).toEqual([["release_login_mail", { p_claim_id: 41, p_email_hash: sha(`otodoke:login-attempt:email:${EMAIL}`) }]]);
    }
  });

  it.each(["email_10m", "email_1h", "ip_1h"])("answers rate without asking Supabase when the app's limit says %s", async (verdict) => {
    limits(verdict);
    expect(await signInWithAuthSecret({ email: EMAIL, authSecret: SECRET })).toEqual({ ok: false, code: "rate" });
    expect(mocks.signIn).not.toHaveBeenCalled();
  });

  it.each([
    ["a password as typed", "Tr0ub4dor&3"],
    ["upper-case hex", "A".repeat(64)],
    ["63 characters", "a".repeat(63)],
    ["65 characters", "a".repeat(65)],
    ["hex with a space", `${"a".repeat(63)} `],
    ["a number", 1234],
  ])("refuses %s as the login secret, before any limit or Supabase", async (_what, authSecret) => {
    expect(await signInWithAuthSecret({ email: EMAIL, authSecret } as never)).toEqual({ ok: false, code: "other" });
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.signIn).not.toHaveBeenCalled();
  });

  it("refuses a password field next to the login secret (the schema is strict)", async () => {
    expect(await signInWithAuthSecret({ email: EMAIL, authSecret: SECRET, password: "Tr0ub4dor&3" } as never)).toEqual({ ok: false, code: "other" });
    expect(mocks.signIn).not.toHaveBeenCalled();
  });

  it("answers invalid_email for an address that cannot be one, without counting it", async () => {
    expect(await signInWithAuthSecret({ email: "not-an-address", authSecret: SECRET })).toEqual({ ok: false, code: "invalid_email" });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("passes no token when the form has none, an empty one or one longer than any token", async () => {
    for (const captchaToken of [undefined, null, "", "   ", "x".repeat(2049)]) {
      mocks.signIn.mockClear();
      await signInWithAuthSecret({ email: EMAIL, authSecret: SECRET, captchaToken });
      expect(mocks.signIn.mock.calls[0][0].options.captchaToken).toBeUndefined();
    }
  });
});

describe("signUpWithAuthSecret", () => {
  it("makes the account through a client that keeps no session, with the confirmation link to /auth/confirm", async () => {
    expect(await signUpWithAuthSecret({ email: "New@Example.com", authSecret: SECRET, captchaToken: TOKEN })).toEqual({ ok: true, code: "signup_exists_or_sent" });
    expect(mocks.signUp).toHaveBeenCalledWith({ email: "new@example.com", password: SECRET, options: { emailRedirectTo: "https://otodoke.app/auth/confirm?next=%2Fapp", captchaToken: TOKEN } });
    // The browser's cookies are never touched: the cookie client is not asked at all.
    expect(mocks.signIn).not.toHaveBeenCalled();
    // Counted against the mail limit (its namespace), and kept: a mail went out.
    expect(calls("claim_login_mail")[0][1].p_email_hash).toBe(sha("otodoke:login-mail:email:new@example.com"));
    expect(calls("release_login_mail")).toHaveLength(0);
  });

  it.each([
    ["a non-ASCII letter", "ｕser@example.com"],
    ["a dotted capital I", "İstanbul@example.com"],
    ["a Japanese domain", "user@例え.jp"],
    ["a non-breaking space inside", "us er@example.com"],
  ])("refuses an address with %s (decision 9), before any limit or Supabase", async (_what, email) => {
    const answer = await signUpWithAuthSecret({ email, authSecret: SECRET });
    expect(answer.ok).toBe(false);
    expect(["email_not_ascii", "invalid_email"]).toContain((answer as { code: string }).code);
    expect(mocks.signUp).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("accepts ASCII symbols an address may have", async () => {
    expect(await signUpWithAuthSecret({ email: "o'brien+otodoke@example.co.uk", authSecret: SECRET })).toEqual({ ok: true, code: "signup_exists_or_sent" });
  });

  it.each([
    ["the address has an account", { status: 422, code: "user_already_exists" }],
    ["the address has an account (email_exists)", { status: 422, code: "email_exists" }],
    ["a mail went to it within the minute", { status: 429, code: "over_email_send_rate_limit" }],
  ])("answers the same as a sent mail when %s", async (_what, error) => {
    mocks.signUp.mockResolvedValue({ data: { user: null, session: null }, error });
    expect(await signUpWithAuthSecret({ email: EMAIL, authSecret: SECRET })).toEqual({ ok: true, code: "signup_exists_or_sent" });
    // Supabase sent nothing for this press: the app's mail allowance is given back.
    expect(calls("release_login_mail")).toHaveLength(1);
  });

  it.each([
    [{ status: 400, code: "captcha_failed" }, "captcha"],
    [{ status: 429, code: "over_request_rate_limit" }, "rate"],
    [{ status: 400, code: "email_address_invalid" }, "invalid_email"],
    [{ status: 500, code: "unexpected_failure" }, "network"],
    [{ status: 422, code: "signup_disabled" }, "other"],
  ] as const)("answers %j as %s", async (error, code) => {
    mocks.signUp.mockResolvedValue({ data: { user: null, session: null }, error });
    expect(await signUpWithAuthSecret({ email: EMAIL, authSecret: SECRET })).toEqual({ ok: false, code });
  });

  it("ends a session Supabase made (confirmations turned off) instead of keeping it", async () => {
    mocks.signUp.mockResolvedValue({ data: { user: { id: "user-1" }, session: { access_token: "x.y.z" } }, error: null });
    await signUpWithAuthSecret({ email: EMAIL, authSecret: SECRET });
    expect(mocks.endSession).toHaveBeenCalledWith("x.y.z", "local");
  });

  it("answers rate without asking Supabase when the app's mail limit is used up", async () => {
    limits("email_10m");
    expect(await signUpWithAuthSecret({ email: EMAIL, authSecret: SECRET })).toEqual({ ok: false, code: "rate" });
    expect(mocks.signUp).not.toHaveBeenCalled();
  });

  it("refuses a password field (strict)", async () => {
    expect(await signUpWithAuthSecret({ email: EMAIL, authSecret: SECRET, password: "x" } as never)).toEqual({ ok: false, code: "other" });
    expect(mocks.signUp).not.toHaveBeenCalled();
  });
});

describe("resendConfirmation and sendResetMail answer the same for every address", () => {
  it("send the mails with the link to /auth/confirm", async () => {
    expect(await resendConfirmation({ email: EMAIL, captchaToken: TOKEN })).toEqual({ ok: true, code: "confirmation_sent" });
    expect(mocks.resend).toHaveBeenCalledWith({ type: "signup", email: EMAIL, options: { emailRedirectTo: "https://otodoke.app/auth/confirm?next=%2Fapp", captchaToken: TOKEN } });
    expect(await sendResetMail({ email: EMAIL, captchaToken: TOKEN })).toEqual({ ok: true, code: "reset_sent" });
    expect(mocks.reset).toHaveBeenCalledWith(EMAIL, { redirectTo: "https://otodoke.app/auth/confirm?next=%2Fapp", captchaToken: TOKEN });
  });

  it("say sent when Supabase's answer could tell whether the address has an account", async () => {
    for (const error of [{ status: 429, code: "over_email_send_rate_limit" }, { status: 422, code: "user_not_found" }, { status: 429 }]) {
      mocks.resend.mockResolvedValue({ data: null, error });
      mocks.reset.mockResolvedValue({ data: null, error });
      expect(await resendConfirmation({ email: EMAIL })).toEqual({ ok: true, code: "confirmation_sent" });
      expect(await sendResetMail({ email: EMAIL })).toEqual({ ok: true, code: "reset_sent" });
    }
    // Negative control: an answer that is the same for every address is not hidden.
    mocks.reset.mockResolvedValue({ data: null, error: { status: 422, code: "signup_disabled" } });
    expect(await sendResetMail({ email: EMAIL })).toEqual({ ok: false, code: "other" });
  });

  it("say what is the same for every address: the bot check, the per-IP limit, an outage, the address's form", async () => {
    for (const [error, code] of [
      [{ status: 400, code: "captcha_failed" }, "captcha"],
      [{ status: 429, code: "over_request_rate_limit" }, "rate"],
      [{ status: 503 }, "network"],
    ] as const) {
      mocks.reset.mockResolvedValue({ data: null, error });
      expect(await sendResetMail({ email: EMAIL })).toEqual({ ok: false, code });
    }
    expect(await sendResetMail({ email: "nobody" })).toEqual({ ok: false, code: "invalid_email" });
    expect(await resendConfirmation({ email: "nobody" })).toEqual({ ok: false, code: "invalid_email" });
  });

  it("take no login secret, nor a password", async () => {
    expect(await sendResetMail({ email: EMAIL, authSecret: SECRET } as never)).toEqual({ ok: false, code: "other" });
    expect(await resendConfirmation({ email: EMAIL, password: "x" } as never)).toEqual({ ok: false, code: "other" });
    expect(mocks.reset).not.toHaveBeenCalled();
    expect(mocks.resend).not.toHaveBeenCalled();
  });
});

describe("the logs", () => {
  it("never carry the address, the login secret or the bot check's token, on any answer", async () => {
    mocks.signIn.mockResolvedValue({ data: { user: null, session: null }, error: { status: 400, code: "invalid_credentials", message: `Invalid login for ${EMAIL}` } });
    await signInWithAuthSecret({ email: EMAIL, authSecret: SECRET, captchaToken: TOKEN });
    mocks.signIn.mockRejectedValue(new Error(`boom ${SECRET}`));
    await signInWithAuthSecret({ email: EMAIL, authSecret: SECRET, captchaToken: TOKEN });
    mocks.signUp.mockResolvedValue({ data: { user: null, session: null }, error: { status: 500, message: `could not mail ${EMAIL}` } });
    await signUpWithAuthSecret({ email: EMAIL, authSecret: SECRET, captchaToken: TOKEN });
    mocks.reset.mockRejectedValue(new Error(`reset ${EMAIL}`));
    await sendResetMail({ email: EMAIL, captchaToken: TOKEN });
    limits("email_1h");
    await signInWithAuthSecret({ email: EMAIL, authSecret: SECRET });
    const text = consoleText();
    // The check must see the console: the failures did log.
    expect(text).toContain("[login] sign-in refused");
    expect(text).toContain("[login] sign-in limited");
    expect(text).not.toContain(EMAIL);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(TOKEN);
  });
});
