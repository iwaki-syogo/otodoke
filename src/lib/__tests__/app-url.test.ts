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

const mocks = vi.hoisted(() => ({ otp: [] as Array<{ email: string; options?: { emailRedirectTo?: string } }> }));

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: {
      signInWithOtp: async (args: { email: string; options?: { emailRedirectTo?: string } }) => {
        mocks.otp.push(args);
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

async function submitLogin(values: Record<string, string>): Promise<string> {
  stub(values);
  mocks.otp.length = 0;
  const { sendMagicLink } = await import("@/app/login/actions");
  const form = new FormData();
  form.set("email", "someone@example.com");
  form.set("next", "/app");
  try {
    await sendMagicLink(form);
  } catch (error) {
    return (error as Error).message;
  }
  return "no redirect";
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

describe("sendMagicLink redirect target", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("sends the preview's branch URL as emailRedirectTo", async () => {
    const result = await submitLogin({ VERCEL_ENV: "preview", VERCEL_BRANCH_URL: BRANCH });
    expect(result).toBe(`REDIRECT:/login?sent=${encodeURIComponent("someone@example.com")}`);
    expect(mocks.otp).toHaveLength(1);
    expect(mocks.otp[0].options?.emailRedirectTo).toBe(`https://${BRANCH}/auth/confirm?next=${encodeURIComponent("/app")}`);
  });

  it("sends the production URL as emailRedirectTo in production", async () => {
    await submitLogin({ VERCEL_ENV: "production", VERCEL_BRANCH_URL: "otodoke-app-git-main-syodgo-9062s-projects.vercel.app", NEXT_PUBLIC_APP_URL: "https://otodoke.app" });
    expect(mocks.otp[0].options?.emailRedirectTo).toBe(`https://otodoke.app/auth/confirm?next=${encodeURIComponent("/app")}`);
  });

  it("sends no email and returns an error when Vercel has no URL to use", async () => {
    const result = await submitLogin({ VERCEL_ENV: "preview" });
    expect(mocks.otp).toHaveLength(0);
    expect(result).toMatch(/^REDIRECT:\/login\?error=/);
  });
});
