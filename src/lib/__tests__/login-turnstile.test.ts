import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import nextConfig from "../../../next.config";

/**
 * Cloudflare Turnstile on the login form. The browser puts the token in `cf-turnstile-response`;
 * the server action hands it to Supabase as `captchaToken`, and Supabase checks it once CAPTCHA
 * protection is on. This code ships before CAPTCHA is turned on, so a missing token must still
 * reach Supabase (which ignores it while CAPTCHA is off).
 */

type OtpArgs = { email: string; options?: { emailRedirectTo?: string; captchaToken?: string } };

const mocks = vi.hoisted(() => ({
  otp: [] as OtpArgs[],
  otpError: null as null | { status: number; code?: string; message: string },
  rpc: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
}));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ "x-real-ip": "203.0.113.7" }) }));
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
      signInWithOtp: async (args: OtpArgs) => {
        mocks.otp.push(args);
        return { error: mocks.otpError };
      },
    },
  }),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ rpc: mocks.rpc }) }));

const EMAIL = "someone@example.com";
// Shaped like a real token, and unique so a leak into any log line is easy to spot.
const TOKEN = "0.zTm7bLh4Qx-TOKEN-SHOULD-NEVER-BE-LOGGED-9f8e7d6c5b4a";

async function submit(fields: Record<string, string>): Promise<string> {
  const { sendMagicLink } = await import("@/app/login/actions");
  const form = new FormData();
  form.set("email", EMAIL);
  form.set("next", "/app");
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  try {
    await sendMagicLink(form);
  } catch (error) {
    return (error as Error).message;
  }
  return "no redirect";
}

async function loginPage(params: Record<string, string> = {}): Promise<string> {
  const Page = (await import("@/app/login/page")).default as unknown as (p: { searchParams: Promise<Record<string, string>> }) => Promise<Parameters<typeof renderToStaticMarkup>[0]>;
  return renderToStaticMarkup(await Page({ searchParams: Promise.resolve(params) }));
}

/** Everything written to the console during the test, as one string. */
function consoleText(): string {
  return [console.log, console.info, console.warn, console.error, console.debug]
    .flatMap((fn) => vi.mocked(fn).mock.calls)
    .map((args) => args.map((a) => (a instanceof Error ? `${a.message} ${a.stack}` : typeof a === "string" ? a : JSON.stringify(a))).join(" "))
    .join("\n");
}

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon");
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://otodoke.app");
  vi.stubEnv("VERCEL_ENV", "production");
  mocks.otp.length = 0;
  mocks.otpError = null;
  mocks.rpc.mockReset();
  mocks.rpc.mockImplementation(async (fn: string) =>
    fn === "claim_login_mail" ? { data: [{ verdict: "ok", claim_id: 7 }], error: null } : { data: 1, error: null },
  );
  for (const level of ["log", "info", "warn", "error", "debug"] as const) vi.spyOn(console, level).mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("sendMagicLink passes the Turnstile token to Supabase", () => {
  it("sends the token from cf-turnstile-response as captchaToken", async () => {
    expect(await submit({ "cf-turnstile-response": TOKEN })).toBe(`REDIRECT:/login?sent=${encodeURIComponent(EMAIL)}`);
    expect(mocks.otp).toHaveLength(1);
    expect(mocks.otp[0].options?.captchaToken).toBe(TOKEN);
    expect(mocks.otp[0].options?.emailRedirectTo).toBe("https://otodoke.app/auth/confirm?next=%2Fapp");
  });

  it.each([
    ["no field at all", {}],
    ["an empty field (widget not solved yet)", { "cf-turnstile-response": "" }],
    ["only spaces", { "cf-turnstile-response": "   " }],
    ["something longer than any token", { "cf-turnstile-response": "x".repeat(2049) }],
  ])("still asks Supabase to send, without a token, for %s", async (_label, fields) => {
    expect(await submit(fields)).toBe(`REDIRECT:/login?sent=${encodeURIComponent(EMAIL)}`);
    expect(mocks.otp).toHaveLength(1);
    expect(mocks.otp[0].options?.captchaToken).toBeUndefined();
  });

  it("says to reload or try another browser, and gives the send back, when Supabase wanted a token the press did not have", async () => {
    mocks.otpError = { status: 400, code: "captcha_failed", message: "captcha protection: request disallowed (no captcha_token found)" };
    expect(await submit({})).toBe("REDIRECT:/login?error=captcha_missing");
    // No mail went out, so the app's own allowance is given back.
    expect(mocks.rpc.mock.calls.filter(([fn]) => fn === "release_login_mail")).toHaveLength(1);
    expect(await loginPage({ error: "captcha_missing" })).toContain("確認が終わりませんでした。ページを読み込み直すか、別のブラウザでお試しください。");
  });

  it("says to send again, and gives the send back, when Supabase refused the token the press sent", async () => {
    mocks.otpError = { status: 400, code: "captcha_failed", message: "captcha protection: request disallowed (timeout-or-duplicate)" };
    expect(await submit({ "cf-turnstile-response": TOKEN })).toBe("REDIRECT:/login?error=captcha_refused");
    expect(mocks.rpc.mock.calls.filter(([fn]) => fn === "release_login_mail")).toHaveLength(1);
    expect(await loginPage({ error: "captcha_refused" })).toContain("確認が切れました。もう一度リンクを送ってください。");
  });

  it("tells missing from refused by what the press sent, not by Supabase's English text", async () => {
    // Supabase says "no token" although one was sent: still the refused case.
    mocks.otpError = { status: 400, code: "captcha_failed", message: "captcha protection: request disallowed (no captcha_token found)" };
    expect(await submit({ "cf-turnstile-response": TOKEN })).toBe("REDIRECT:/login?error=captcha_refused");
    // Supabase names Cloudflare's codes although nothing usable was sent: still the missing case.
    mocks.otpError = { status: 400, code: "captcha_failed", message: "captcha protection: request disallowed (invalid-input-response)" };
    expect(await submit({ "cf-turnstile-response": "   " })).toBe("REDIRECT:/login?error=captcha_missing");
    expect(await submit({ "cf-turnstile-response": "x".repeat(2049) })).toBe("REDIRECT:/login?error=captcha_missing");

    const missing = await loginPage({ error: "captcha_missing" });
    const refused = await loginPage({ error: "captcha_refused" });
    expect(missing).toContain("別のブラウザ");
    expect(missing).not.toContain("確認が切れました");
    expect(refused).toContain("もう一度リンクを送ってください");
    expect(refused).not.toContain("別のブラウザ");
    // The query carries the code only; Supabase's words never reach the page.
    for (const page of [missing, refused]) expect(page).not.toMatch(/captcha|disallowed|timeout-or-duplicate/);
  });

  it("keeps the wording of the code used before the two were told apart", async () => {
    expect(await loginPage({ error: "captcha" })).toContain("確認が切れました。もう一度お試しください。");
  });

  it("decides by the code, not the English text", async () => {
    mocks.otpError = { status: 400, code: "captcha_failed", message: "something else entirely" };
    expect(await submit({ "cf-turnstile-response": TOKEN })).toBe("REDIRECT:/login?error=captcha_refused");
    mocks.otpError = { status: 500, message: "captcha verification process failed" };
    expect(await submit({ "cf-turnstile-response": TOKEN })).toBe("REDIRECT:/login?error=send_failed");
    expect(await submit({})).toBe("REDIRECT:/login?error=send_failed");
    mocks.otpError = { status: 429, code: "over_email_send_rate_limit", message: "captcha" };
    expect(await submit({ "cf-turnstile-response": TOKEN })).toBe("REDIRECT:/login?error=busy");
    expect(await submit({})).toBe("REDIRECT:/login?error=busy");
  });

  it("never writes the token to the log, on success or failure", async () => {
    await submit({ "cf-turnstile-response": TOKEN });
    mocks.otpError = { status: 400, code: "captcha_failed", message: "captcha protection: request disallowed (invalid-input-response)" };
    await submit({ "cf-turnstile-response": TOKEN });
    mocks.otpError = { status: 500, code: "unexpected_failure", message: "refused" };
    await submit({ "cf-turnstile-response": TOKEN });
    // The check itself must see the console: the failure paths did log something.
    expect(consoleText()).toContain("signInWithOtp failed");
    expect(consoleText()).not.toContain(TOKEN);
    expect(consoleText()).not.toContain("TOKEN-SHOULD-NEVER");
  });
});

describe("the login form carries the widget", () => {
  it("renders the hidden token field (empty, no value attribute for React to re-apply) and the widget slot inside the form, above the button", async () => {
    const html = await loginPage();
    const form = html.slice(html.indexOf("<form"), html.indexOf("</form>"));
    expect(form).toContain('<input type="hidden" name="cf-turnstile-response"/>');
    // While the page loads the slot keeps the widget's height (not hidden) and there is no notice.
    expect(form).toContain('<div data-turnstile-widget="true" class="min-h-[65px] w-full"></div>');
    expect(form).not.toContain("確認を読み込めませんでした");
    const email = form.indexOf('name="email"');
    const widget = form.indexOf("data-turnstile-widget");
    const button = form.indexOf('type="submit"');
    expect(email).toBeGreaterThan(-1);
    expect(widget).toBeGreaterThan(email);
    expect(button).toBeGreaterThan(widget);
  });

  it("keeps the form usable while there is no token", async () => {
    const html = await loginPage();
    expect(html).not.toMatch(/\sdisabled(=|\s|>)/);
  });

  it("is a client component that renders explicitly with the Otodoke sitekey and resets after each send", () => {
    // How it behaves over time is in login-turnstile-widget.test.ts and login-submit-button.test.ts.
    const source = readFileSync(path.resolve(__dirname, "../../app/login/turnstile-widget.tsx"), "utf8");
    expect(source.startsWith('"use client";')).toBe(true);
    expect(source).toContain("turnstile.render(");
    expect(source).toContain('"response-field": false');
    expect(source).toContain('"error-callback"');
    expect(source).toContain("turnstile.reset(");
    expect(source).toContain("turnstile.remove(");
    const page = readFileSync(path.resolve(__dirname, "../../app/login/page.tsx"), "utf8");
    const form = page.slice(page.indexOf("<form action={sendMagicLink}"), page.indexOf("</form>"));
    expect(form).toContain("<TurnstileWidget />");
  });

  it("uses the public sitekey and Cloudflare's exact script URL", async () => {
    const t = await import("@/lib/turnstile");
    expect(t.TURNSTILE_SITEKEY).toBe("0x4AAAAAAF1bMWXBw0RF-dvv");
    expect(t.TURNSTILE_SCRIPT_URL).toBe("https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit");
    expect(t.TURNSTILE_RESPONSE_FIELD).toBe("cf-turnstile-response");
  });
});

describe("the security headers let Turnstile load", () => {
  it("does not restrict scripts, frames or connections (only frame-ancestors is set)", async () => {
    const [rule] = await nextConfig.headers!();
    const csp = rule.headers.find((h) => h.key === "Content-Security-Policy")!.value;
    // If a fuller CSP is added later, it must allow https://challenges.cloudflare.com in
    // script-src, frame-src and connect-src, or the login widget stops loading.
    for (const directive of ["default-src", "script-src", "frame-src", "child-src", "connect-src"]) {
      if (csp.includes(directive)) expect(csp).toMatch(new RegExp(`${directive}[^;]*https://challenges\\.cloudflare\\.com`));
    }
    // X-Frame-Options / frame-ancestors only stop others from framing this app; they do not stop
    // this app from framing Cloudflare.
    expect(csp).toBe("frame-ancestors 'none'");
  });
});
