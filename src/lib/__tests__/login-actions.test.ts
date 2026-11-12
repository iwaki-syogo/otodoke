import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The login screens' Actions (src/app/login/actions.ts → src/lib/login-auth.ts): what each sends
 * Supabase, which result code each answer becomes, and the app's own limits. Supabase is mocked;
 * the limit RPCs are mocked here and their SQL has its own tests (login-mail-limit.test.ts).
 */

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

/** One integer key of the [auth.rate_limit] section of supabase/config.toml; throws if absent. */
function authRateLimit(key: string): number {
  const toml = readFileSync(resolve(process.cwd(), "supabase/config.toml"), "utf8");
  const section = toml.match(/^\[auth\.rate_limit\]\s*\n([\s\S]*?)(?=^\[|(?![\s\S]))/m);
  const value = section?.[1].match(new RegExp(`^${key}\\s*=\\s*(\\d+)\\s*(?:#.*)?$`, "m"));
  if (!value) throw new Error(`[auth.rate_limit] ${key} not found in supabase/config.toml`);
  return Number(value[1]);
}

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
    ["an address not confirmed yet", { status: 400, code: "email_not_confirmed" }, "credentials"],
    ["Supabase's own limit", { status: 429, code: "over_request_rate_limit" }, "rate"],
    ["a 429 without a code", { status: 429 }, "rate"],
    ["a refused bot check", { status: 400, code: "captcha_failed" }, "captcha"],
    ["no answer", { status: 0, name: "AuthRetryableFetchError" }, "network"],
    ["an Auth 500 outside mail sending", { status: 500, code: "unexpected_failure" }, "network"],
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

  it("counts every sign-in per IP, 15 in any 10 minutes (never 100 in 5), and never gives one back", async () => {
    await signInWithAuthSecret({ email: EMAIL, authSecret: SECRET });
    const [[, tries]] = calls("claim_login_mail");
    // The IP's key goes in the address column: the function's 10-minute window then applies to it.
    expect(tries).toEqual({ p_email_hash: sha(`otodoke:login-try:email:${IP}`), p_ip_hash: null, p_email_10m_limit: 15, p_email_1h_limit: 60, p_ip_1h_limit: 60 });
    // Any 5 minutes lie in some 10 minutes: one IP's sign-ins, with its sign-ups (the mail limit,
    // per hour) on top, stay under Supabase's 100 per 5 minutes that every visitor shares.
    // Read from supabase/config.toml, which mirrors the dashboard value (Authentication > Rate
    // Limits > "Rate limit for sign-ups and sign-ins"); change both together.
    const SUPABASE_SIGN_IN_UP_PER_5_MIN = authRateLimit("sign_in_sign_ups");
    const { LOGIN_MAIL_LIMITS, LOGIN_TRY_LIMITS } = await import("@/lib/login-mail-limit");
    expect(LOGIN_TRY_LIMITS.ipPer10Minutes + LOGIN_MAIL_LIMITS.ipPerHour).toBeLessThan(SUPABASE_SIGN_IN_UP_PER_5_MIN);
    // One IP's mails per hour stay below Supabase's project-wide mail limit (config.toml email_sent),
    // so a single IP cannot take the whole mail allowance.
    expect(LOGIN_MAIL_LIMITS.ipPerHour).toBeLessThan(authRateLimit("email_sent"));
    // Only the address's attempt is given back after a success, never the try.
    expect(calls("release_login_mail").map(([, args]) => args.p_email_hash)).toEqual([sha(`otodoke:login-attempt:email:${EMAIL}`)]);
  });

  it("answers rate without asking Supabase when this IP has used its sign-ins", async () => {
    mocks.rpc.mockImplementation(async (fn: string, args: { p_email_hash: string }) =>
      fn === "claim_login_mail" && args.p_email_hash === sha(`otodoke:login-try:email:${IP}`) ? { data: [{ verdict: "email_10m", claim_id: null }], error: null } : { data: [{ verdict: "ok", claim_id: 41 }], error: null },
    );
    expect(await signInWithAuthSecret({ email: EMAIL, authSecret: SECRET })).toEqual({ ok: false, code: "rate" });
    expect(mocks.signIn).not.toHaveBeenCalled();
  });

  it("counts wrong credentials and pending confirmation identically, giving back only other outcomes", async () => {
    mocks.signIn.mockResolvedValue({ data: { user: null, session: null }, error: { status: 400, code: "invalid_credentials" } });
    await signInWithAuthSecret({ email: EMAIL, authSecret: SECRET });
    const claim = calls("claim_login_mail").map(([, args]) => args).find((args) => args.p_email_hash === sha(`otodoke:login-attempt:email:${EMAIL}`));
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
    ["new account awaiting confirmation", [{ id: "new-identity" }], "email_not_confirmed"],
    ["existing account awaiting confirmation", [{ id: "pending-identity" }], "email_not_confirmed"],
    ["confirmed account with another secret", [], "invalid_credentials"],
  ])("%s: sign-up, follow-up sign-in, and the later rate response are indistinguishable", async (_what, identities, authCode) => {
    const held = new Map<string, number>();
    const claimKeys = new Map<number, string>();
    let claimId = 0;
    mocks.rpc.mockImplementation(async (fn: string, args: { p_email_hash: string; p_email_10m_limit: number; p_claim_id?: number }) => {
      if (fn === "release_login_mail") {
        const key = claimKeys.get(args.p_claim_id!);
        if (key) held.set(key, (held.get(key) ?? 0) - 1);
        return { data: 1, error: null };
      }
      if (fn !== "claim_login_mail") return { data: null, error: null };
      const count = held.get(args.p_email_hash) ?? 0;
      if (count >= args.p_email_10m_limit) return { data: [{ verdict: "email_10m", claim_id: null }], error: null };
      held.set(args.p_email_hash, count + 1);
      claimKeys.set(++claimId, args.p_email_hash);
      return { data: [{ verdict: "ok", claim_id: claimId }], error: null };
    });
    mocks.signUp.mockResolvedValue({ data: { user: { id: "user-1", identities }, session: null }, error: null });
    expect(await signUpWithAuthSecret({ email: EMAIL, authSecret: SECRET })).toEqual({ ok: true, code: "signup_exists_or_sent" });
    mocks.signIn.mockResolvedValue({ data: { user: null, session: null }, error: { status: 400, code: authCode } });
    const { LOGIN_ATTEMPT_LIMITS } = await import("@/lib/login-mail-limit");
    for (let i = 0; i < LOGIN_ATTEMPT_LIMITS.emailPer10Minutes; i++) {
      expect(await signInWithAuthSecret({ email: EMAIL, authSecret: SECRET })).toEqual({ ok: false, code: "credentials" });
    }
    expect(await signInWithAuthSecret({ email: EMAIL, authSecret: SECRET })).toEqual({ ok: false, code: "rate" });
    expect(calls("release_login_mail")).toHaveLength(0);
    expect(mocks.signIn).toHaveBeenCalledTimes(LOGIN_ATTEMPT_LIMITS.emailPer10Minutes);
  });

  it("a correct secret awaiting confirmation can sign in after confirmation without changing input", async () => {
    const input = { email: EMAIL, authSecret: SECRET };
    mocks.signIn.mockResolvedValueOnce({ data: { user: null, session: null }, error: { status: 400, code: "email_not_confirmed" } });
    expect(await signInWithAuthSecret(input)).toEqual({ ok: false, code: "credentials" });
    expect(calls("release_login_mail")).toHaveLength(0);
    expect(await signInWithAuthSecret(input)).toEqual({ ok: true, userId: "user-1" });
    expect(mocks.signIn.mock.calls.map(([value]) => value)).toEqual([
      { email: EMAIL, password: SECRET, options: { captchaToken: undefined } },
      { email: EMAIL, password: SECRET, options: { captchaToken: undefined } },
    ]);
    expect(calls("release_login_mail")).toHaveLength(1);
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

describe("mail delivery backpressure", () => {
  it.each([
    ["a new sign-up reaching the confirmation sender", mocks.signUp, () => signUpWithAuthSecret({ email: EMAIL, authSecret: SECRET })],
    ["a pending account's resend reaching the confirmation sender", mocks.resend, () => resendConfirmation({ email: EMAIL })],
    ["a confirmed account's reset reaching the recovery sender", mocks.reset, () => sendResetMail({ email: EMAIL })],
  ] as const)("%s does not report an email-send 429 as sent", async (_step, upstream, request) => {
    const failure = { data: { user: null, session: null }, error: { status: 429, code: "over_email_send_rate_limit" } };
    upstream.mockResolvedValue(failure);
    expect(await request()).toEqual({ ok: false, code: "mail_busy" });
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(calls("claim_login_mail")).toHaveLength(1);
    expect(calls("release_login_mail")).toHaveLength(1);
  });
});

describe("pinned Auth sender ordering and the accepted address-dependent failure boundary", () => {
  // Official Auth source at 88725864802773ad4533e0cad28f7a2740c89a7e:
  // signup.go returns confirmed users before sending; resend.go skips missing/confirmed users;
  // recover.go skips missing users. These cases model those early outcomes, not a shared 429.
  // A first signup can reach the project quota (not an existing ConfirmationSentAt cooldown).
  // The SMTP row models a synchronous sender failure, not every possible unexpected_failure.
  const signup = () => signUpWithAuthSecret({ email: EMAIL, authSecret: SECRET });
  const resend = () => resendConfirmation({ email: EMAIL });
  const reset = () => sendResetMail({ email: EMAIL });
  const states = [
    ["signup new", "sender", mocks.signUp, signup, "signup_exists_or_sent"],
    ["signup pending", "sender", mocks.signUp, signup, "signup_exists_or_sent"],
    ["signup confirmed (user_already_exists)", "exists", mocks.signUp, signup, "signup_exists_or_sent"],
    ["signup confirmed (sanitized 200)", "early", mocks.signUp, signup, "signup_exists_or_sent"],
    ["resend missing", "early", mocks.resend, resend, "confirmation_sent"],
    ["resend pending", "sender", mocks.resend, resend, "confirmation_sent"],
    ["resend confirmed", "early", mocks.resend, resend, "confirmation_sent"],
    ["recover missing", "early", mocks.reset, reset, "reset_sent"],
    ["recover pending", "sender", mocks.reset, reset, "reset_sent"],
    ["recover confirmed", "sender", mocks.reset, reset, "reset_sent"],
  ] as const;
  const pressure = [
    ["email-send 429", { status: 429, code: "over_email_send_rate_limit" }],
    ["raw 429", { status: 429 }],
    ["SMTP 500", { status: 500, code: "unexpected_failure" }],
  ] as const;
  const scenarios = states.flatMap(([state, stage, upstream, request, sent]) => pressure.map(([label, failure]) =>
    ({ label: `${state} under ${label} send backpressure`, stage, upstream, request, sent, failure })));

  it.each(states)("%s keeps its neutral response and allowance with normal sending capacity", async (_state, stage, upstream, request, sent) => {
    upstream.mockResolvedValue({ data: { user: { id: "synthetic-user", identities: stage === "sender" ? [{ id: "synthetic-identity" }] : [] }, session: null }, error: stage === "exists" ? { status: 422, code: "user_already_exists" } : null });
    expect(await request()).toEqual({ ok: true, code: sent });
    expect(calls("claim_login_mail")).toHaveLength(1);
    expect(calls("release_login_mail")).toHaveLength(0);
  });

  it.each(scenarios)("$label", async ({ stage, upstream, request, sent, failure }) => {
    const error = stage === "sender" ? failure : stage === "exists" ? { status: 422, code: "user_already_exists" } : null;
    upstream.mockResolvedValue({ data: { user: { id: "synthetic-user", identities: [] }, session: null }, error });
    expect(await request()).toEqual(stage === "sender" ? { ok: false, code: "mail_busy" } : { ok: true, code: sent });
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(calls("claim_login_mail")).toHaveLength(1);
    expect(calls("release_login_mail")).toHaveLength(stage === "sender" ? 1 : 0);
  });

  it.each([
    ["signup", mocks.signUp, signup],
    ["resend", mocks.resend, resend],
    ["recover", mocks.reset, reset],
  ] as const)("%s keeps code-only send backpressure separate from network failures", async (_step, upstream, request) => {
    upstream.mockResolvedValue({ data: { user: null, session: null }, error: { code: "over_email_send_rate_limit" } });
    expect(await request()).toEqual({ ok: false, code: "mail_busy" });
    expect(calls("release_login_mail")).toHaveLength(1);
    for (const error of [{ status: 502, code: "unexpected_failure" }, { status: 503 }, { status: 0, name: "AuthRetryableFetchError" }]) {
      upstream.mockResolvedValue({ data: { user: null, session: null }, error });
      expect(await request()).toEqual({ ok: false, code: "network" });
    }
    upstream.mockRejectedValue(new TypeError("fetch failed"));
    expect(await request()).toEqual({ ok: false, code: "network" });
    expect(calls("release_login_mail")).toHaveLength(5);
  });

  it.each(["user_already_exists", "email_exists", "user_not_found"])("keeps the non-send alias %s neutral even with an inconsistent busy status", async (code) => {
    for (const status of [422, 429, 500]) {
      for (const [upstream, request, sent, releases] of [
        [mocks.signUp, signup, "signup_exists_or_sent", 0],
        [mocks.resend, resend, "confirmation_sent", 1],
        [mocks.reset, reset, "reset_sent", 1],
      ] as const) {
        mocks.rpc.mockClear();
        upstream.mockResolvedValue({ data: { user: null, session: null }, error: { status, code } });
        expect(await request()).toEqual({ ok: true, code: sent });
        expect(calls("claim_login_mail")).toHaveLength(1);
        expect(calls("release_login_mail")).toHaveLength(releases);
      }
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

  it("a success whose user has no identities keeps the same result for a confirmed address (no mail sent)", async () => {
    mocks.signUp.mockResolvedValue({ data: { user: { id: "u", identities: [] }, session: null }, error: null });
    expect(await signUpWithAuthSecret({ email: EMAIL, authSecret: SECRET })).toEqual({ ok: true, code: "signup_exists_or_sent" });
  });

  it.each([
    ["identities missing", { user: { id: "u" }, session: null }],
    ["identities undefined", { user: { id: "u", identities: undefined }, session: null }],
    ["identities not an array", { user: { id: "u", identities: null }, session: null }],
    ["identities filled (an unconfirmed address)", { user: { id: "u", identities: [{ id: "i" }] }, session: null }],
    ["no user", { user: null, session: null }],
  ])("negative control: %s keeps signup_exists_or_sent", async (_what, data) => {
    mocks.signUp.mockResolvedValue({ data, error: null });
    expect(await signUpWithAuthSecret({ email: EMAIL, authSecret: SECRET })).toEqual({ ok: true, code: "signup_exists_or_sent" });
  });

  it("accepts ASCII symbols an address may have", async () => {
    expect(await signUpWithAuthSecret({ email: "o'brien+otodoke@example.co.uk", authSecret: SECRET })).toEqual({ ok: true, code: "signup_exists_or_sent" });
  });

  it("an error user_already_exists (422, confirmations off) keeps the same result, is not logged as a failure, and the allowance is kept", async () => {
    mocks.signUp.mockResolvedValue({ data: { user: null, session: null }, error: { status: 422, code: "user_already_exists" } });
    expect(await signUpWithAuthSecret({ email: EMAIL, authSecret: SECRET })).toEqual({ ok: true, code: "signup_exists_or_sent" });
    expect(calls("claim_login_mail")).toHaveLength(1);
    expect(calls("release_login_mail")).toHaveLength(0);
    expect(consoleText()).not.toContain("user_already_exists");
  });

  it("identities [] keeps the allowance too (no release)", async () => {
    mocks.signUp.mockResolvedValue({ data: { user: { id: "u", identities: [] }, session: null }, error: null });
    await signUpWithAuthSecret({ email: EMAIL, authSecret: SECRET });
    expect(calls("claim_login_mail")).toHaveLength(1);
    expect(calls("release_login_mail")).toHaveLength(0);
  });

  it.each([
    ["the address has an account (email_exists)", { status: 422, code: "email_exists" }],
    ["the compatibility alias user_not_found", { status: 422, code: "user_not_found" }],
  ])("answers the same as a sent mail when %s", async (_what, error) => {
    mocks.signUp.mockResolvedValue({ data: { user: null, session: null }, error });
    expect(await signUpWithAuthSecret({ email: EMAIL, authSecret: SECRET })).toEqual({ ok: true, code: "signup_exists_or_sent" });
    // Hidden outcomes count the same as new and pending accounts, including later rate answers.
    expect(calls("release_login_mail")).toHaveLength(0);
  });

  it.each([
    [{ status: 400, code: "captcha_failed" }, "captcha"],
    [{ status: 429, code: "over_request_rate_limit" }, "rate"],
    [{ status: 400, code: "email_address_invalid" }, "invalid_email"],
    [{ status: 500, code: "unexpected_failure" }, "mail_busy"],
    [{ status: 422, code: "signup_disabled" }, "other"],
    [{ status: 400, code: "bad_json" }, "other"],
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

describe("resendConfirmation and sendResetMail keep normal sent outcomes neutral", () => {
  it("send the mails with the link to /auth/confirm", async () => {
    expect(await resendConfirmation({ email: EMAIL, captchaToken: TOKEN })).toEqual({ ok: true, code: "confirmation_sent" });
    expect(mocks.resend).toHaveBeenCalledWith({ type: "signup", email: EMAIL, options: { emailRedirectTo: "https://otodoke.app/auth/confirm?next=%2Fapp", captchaToken: TOKEN } });
    expect(await sendResetMail({ email: EMAIL, captchaToken: TOKEN })).toEqual({ ok: true, code: "reset_sent" });
    expect(mocks.reset).toHaveBeenCalledWith(EMAIL, { redirectTo: "https://otodoke.app/auth/confirm?next=%2Fapp", captchaToken: TOKEN });
  });

  it("say sent for the address-dependent early non-send compatibility aliases", async () => {
    for (const error of [{ status: 422, code: "user_already_exists" }, { status: 422, code: "user_not_found" }, { status: 422, code: "email_exists" }]) {
      mocks.resend.mockResolvedValue({ data: null, error });
      mocks.reset.mockResolvedValue({ data: null, error });
      expect(await resendConfirmation({ email: EMAIL })).toEqual({ ok: true, code: "confirmation_sent" });
      expect(await sendResetMail({ email: EMAIL })).toEqual({ ok: true, code: "reset_sent" });
    }
    // Negative control: an answer that is the same for every address is not hidden.
    mocks.reset.mockResolvedValue({ data: null, error: { status: 422, code: "signup_disabled" } });
    expect(await sendResetMail({ email: EMAIL })).toEqual({ ok: false, code: "other" });
  });

  it("negative control: user_already_exists is an answer only at sign-up; resend and reset keep sent and give the allowance back", async () => {
    const error = { status: 422, code: "user_already_exists" };
    mocks.resend.mockResolvedValue({ data: null, error });
    mocks.reset.mockResolvedValue({ data: null, error });
    expect(await resendConfirmation({ email: EMAIL })).toEqual({ ok: true, code: "confirmation_sent" });
    expect(calls("release_login_mail")).toHaveLength(1);
    expect(await sendResetMail({ email: EMAIL })).toEqual({ ok: true, code: "reset_sent" });
    expect(calls("release_login_mail")).toHaveLength(2);
  });

  it("keeps the bot check, per-IP limit, non-500 outage and address validation categories", async () => {
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
