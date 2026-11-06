import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The app's own URL goes into the login email. On a Vercel preview it must be the branch URL:
 * NEXT_PUBLIC_APP_URL exists only for Production, and falling back to localhost sends a link
 * nobody can open from a phone.
 */

const base = {
  NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon",
  // Blank means "not configured" to env(); this clears anything the shell running the tests has.
  NEXT_PUBLIC_APP_URL: "",
  VERCEL_ENV: "",
  VERCEL_BRANCH_URL: "",
};

const BRANCH = "otodoke-app-git-dev-syodgo-9062s-projects.vercel.app";

/** Where each mail's link was to lead, as the Actions asked Supabase. */
const mocks = vi.hoisted(() => ({ sent: [] as Array<{ step: string; redirectTo?: string }> }));

vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
// The mail limit has its own tests (login-mail-limit.test.ts); here it must never reach a database.
vi.mock("@/lib/login-mail-limit", () => ({
  clientIp: () => null,
  claimLoginMail: async () => ({ verdict: "ok", claimId: null }),
  releaseLoginMail: async () => {},
  claimLoginTry: async () => "ok",
  claimLoginAttempt: async () => ({ verdict: "ok", claimId: null }),
  releaseLoginAttempt: async () => {},
}));
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    auth: {
      signUp: async (args: { options?: { emailRedirectTo?: string } }) => {
        mocks.sent.push({ step: "signUp", redirectTo: args.options?.emailRedirectTo });
        return { data: { user: null, session: null }, error: null };
      },
      resend: async (args: { options?: { emailRedirectTo?: string } }) => {
        mocks.sent.push({ step: "resend", redirectTo: args.options?.emailRedirectTo });
        return { error: null };
      },
      resetPasswordForEmail: async (_email: string, options?: { redirectTo?: string }) => {
        mocks.sent.push({ step: "reset", redirectTo: options?.redirectTo });
        return { error: null };
      },
    },
  }),
}));

function stub(values: Record<string, string>) {
  vi.resetModules();
  for (const [key, value] of Object.entries({ ...base, ...values })) vi.stubEnv(key, value);
}

async function loadAppUrl(values: Record<string, string>): Promise<() => string> {
  stub(values);
  const mod = (await import("../env")) as unknown as { appUrl?: () => string };
  if (typeof mod.appUrl !== "function") throw new Error("appUrl is not exported from env.ts");
  return mod.appUrl;
}

/** The three mails the web asks for, with the same env; their answers in order. */
async function requestMails(values: Record<string, string>): Promise<unknown[]> {
  stub(values);
  mocks.sent.length = 0;
  const { signUpWithAuthSecret, resendConfirmation, sendResetMail } = await import("@/app/login/actions");
  const email = "someone@example.com";
  return [await signUpWithAuthSecret({ email, authSecret: "a".repeat(64) }), await resendConfirmation({ email }), await sendResetMail({ email })];
}

describe("appUrl", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("uses the branch URL on a Vercel preview", async () => {
    const appUrl = await loadAppUrl({ VERCEL_ENV: "preview", VERCEL_BRANCH_URL: BRANCH });
    expect(appUrl()).toBe(`https://${BRANCH}`);
  });

  it("prefers the branch URL over NEXT_PUBLIC_APP_URL on a preview", async () => {
    const appUrl = await loadAppUrl({ VERCEL_ENV: "preview", VERCEL_BRANCH_URL: BRANCH, NEXT_PUBLIC_APP_URL: "https://otodoke.app" });
    expect(appUrl()).toBe(`https://${BRANCH}`);
  });

  it("uses NEXT_PUBLIC_APP_URL in production, not the branch URL", async () => {
    const appUrl = await loadAppUrl({
      VERCEL_ENV: "production",
      VERCEL_BRANCH_URL: "otodoke-app-git-main-syodgo-9062s-projects.vercel.app",
      NEXT_PUBLIC_APP_URL: "https://otodoke.app",
    });
    expect(appUrl()).toBe("https://otodoke.app");
  });

  it("keeps the localhost default on a developer machine", async () => {
    const appUrl = await loadAppUrl({});
    expect(appUrl()).toBe("http://localhost:3015");
  });

  it("uses NEXT_PUBLIC_APP_URL on a developer machine when it is set", async () => {
    const appUrl = await loadAppUrl({ NEXT_PUBLIC_APP_URL: "http://otodoke.localhost:3015" });
    expect(appUrl()).toBe("http://otodoke.localhost:3015");
  });

  it("throws on Vercel production without NEXT_PUBLIC_APP_URL instead of using localhost", async () => {
    const appUrl = await loadAppUrl({ VERCEL_ENV: "production" });
    expect(() => appUrl()).toThrow(/NEXT_PUBLIC_APP_URL/);
  });

  it("throws on a Vercel preview with neither a branch URL nor NEXT_PUBLIC_APP_URL", async () => {
    const appUrl = await loadAppUrl({ VERCEL_ENV: "preview" });
    expect(() => appUrl()).toThrow();
  });

  it("uses NEXT_PUBLIC_APP_URL on a preview without a branch URL", async () => {
    const appUrl = await loadAppUrl({ VERCEL_ENV: "preview", NEXT_PUBLIC_APP_URL: "https://otodoke.app" });
    expect(appUrl()).toBe("https://otodoke.app");
  });
});

describe("the mails' link target (confirmation, again, reset)", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("leads to the preview's branch URL on a preview", async () => {
    const answers = await requestMails({ VERCEL_ENV: "preview", VERCEL_BRANCH_URL: BRANCH });
    expect(answers).toEqual([
      { ok: true, code: "signup_exists_or_sent" },
      { ok: true, code: "confirmation_sent" },
      { ok: true, code: "reset_sent" },
    ]);
    expect(mocks.sent).toEqual(["signUp", "resend", "reset"].map((step) => ({ step, redirectTo: `https://${BRANCH}/auth/confirm?next=${encodeURIComponent("/app")}` })));
  });

  it("leads to the production URL in production", async () => {
    await requestMails({ VERCEL_ENV: "production", VERCEL_BRANCH_URL: "otodoke-app-git-main-syodgo-9062s-projects.vercel.app", NEXT_PUBLIC_APP_URL: "https://otodoke.app" });
    expect(mocks.sent.map((s) => s.redirectTo)).toEqual(Array(3).fill(`https://otodoke.app/auth/confirm?next=${encodeURIComponent("/app")}`));
  });

  it("sends no mail and answers not_configured when Vercel has no URL to use", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const answers = await requestMails({ VERCEL_ENV: "preview" });
    expect(mocks.sent).toHaveLength(0);
    expect(answers).toEqual(Array(3).fill({ ok: false, code: "not_configured" }));
  });
});
