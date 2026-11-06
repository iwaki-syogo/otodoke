import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import nextConfig from "../../../next.config";

/**
 * Cloudflare Turnstile on the login screens. The browser puts the token in `cf-turnstile-response`
 * and the Actions hand it to Supabase as `captchaToken` (login-actions.test.ts checks that, with a
 * missing, empty or too long token). Supabase checks it once CAPTCHA protection is on.
 *
 * Where the widget sits in the new login and sign-up forms is the screens' part (their tests).
 */

describe("the widget", () => {
  it("is a client component that renders explicitly with the Otodoke sitekey and resets after each send", () => {
    // How it behaves over time is in login-turnstile-widget.test.ts and login-submit-button.test.ts.
    const source = readFileSync(path.resolve(__dirname, "../../app/login/turnstile-widget.tsx"), "utf8");
    expect(source.startsWith('"use client";')).toBe(true);
    expect(source).toContain("turnstile.render(");
    expect(source).toContain('"response-field": false');
    expect(source).toContain('"error-callback"');
    expect(source).toContain("turnstile.reset(");
    expect(source).toContain("turnstile.remove(");
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
