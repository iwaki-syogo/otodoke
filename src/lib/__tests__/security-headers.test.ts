import { describe, expect, it } from "vitest";
import nextConfig from "../../../next.config";
import { CARRIERS } from "@/lib/carriers";

/**
 * Production answered with HSTS only (Vercel's). These headers are set by next.config.ts for every
 * route; this pins the exact values so a later edit cannot drop or loosen one silently.
 */
describe("security headers", () => {
  it("applies the fixed set to every route", async () => {
    expect(nextConfig.headers).toBeTypeOf("function");
    const rules = await nextConfig.headers!();
    expect(rules).toHaveLength(1);
    expect(Object.fromEntries(rules[0].headers.map((h) => [h.key, h.value]))).toEqual({
      "X-Frame-Options": "DENY",
      "Content-Security-Policy":
        "frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'self' https://toi.kuronekoyamato.co.jp https://track.seino.co.jp",
      "Content-Security-Policy-Report-Only": expect.stringContaining("default-src 'self'"),
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "strict-origin-when-cross-origin",
      "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    });
  });

  it("watches scripts, connections, frames and images without blocking them, outside the dev server too", async () => {
    const [rule] = await nextConfig.headers!();
    const watched = rule.headers.find((h) => h.key === "Content-Security-Policy-Report-Only")!.value;
    const directives = new Map(watched.split(";").map((d) => d.trim().split(/\s+/)).map(([name, ...values]) => [name, values]));
    expect(directives.get("default-src")).toEqual(["'self'"]);
    expect(directives.get("object-src")).toEqual(["'none'"]);
    expect(directives.get("base-uri")).toEqual(["'none'"]);
    expect(directives.get("form-action")).toEqual(["'self'", "https://toi.kuronekoyamato.co.jp", "https://track.seino.co.jp"]);
    // The tests run outside the dev server: no eval and no socket allowance.
    expect(directives.get("script-src")).not.toContain("'unsafe-eval'");
    expect(directives.get("connect-src")).not.toContain("ws:");
    // No host but this site, Turnstile and the two carrier forms is named anywhere.
    const hosts = watched.match(/https?:\/\/[^\s;]+/g) ?? [];
    expect(new Set(hosts)).toEqual(new Set(["https://challenges.cloudflare.com", "https://toi.kuronekoyamato.co.jp", "https://track.seino.co.jp"]));
    // Watching only: the enforced policy restricts none of these.
    const enforced = rule.headers.find((h) => h.key === "Content-Security-Policy")!.value;
    for (const d of ["default-src", "script-src", "connect-src", "frame-src", "img-src", "style-src"]) expect(enforced).not.toContain(d);
  });

  // The tracking button posts a form to Yamato and Seino. A form-action of 'self' alone blocked it: the
  // browser refused the submission and the button did nothing (2026-11-28, reproduced in Chrome).
  it("lets every carrier tracking form be sent, and no other site", async () => {
    const [rule] = await nextConfig.headers!();
    for (const key of ["Content-Security-Policy", "Content-Security-Policy-Report-Only"]) {
      const policy = rule.headers.find((h) => h.key === key)!.value;
      const formAction = policy.split(";").map((d) => d.trim().split(/\s+/)).find(([name]) => name === "form-action")!.slice(1);
      const posted = Object.values(CARRIERS).map((c) => c.link("123456789012")).filter((l) => l?.kind === "post");
      expect(posted.length, key).toBe(2);
      for (const link of posted) expect(formAction, `${key} ${link!.url}`).toContain(new URL(link!.url).origin);
      // A carrier reached by a plain link or by copying does not widen where a form may go.
      expect(formAction.filter((v) => v !== "'self'").sort(), key).toEqual(posted.map((l) => new URL(l!.url).origin).sort());
    }
  });

  it("matches the root path and nested paths", async () => {
    const [rule] = await nextConfig.headers!();
    // The matcher Next.js builds for custom headers (server/lib/router-utils/filesystem.js).
    // "/:path*" would pass every path here except "/".
    const { getPathMatch } = await import("next/dist/shared/lib/router/utils/path-match");
    const match = getPathMatch(rule.source, { strict: true, removeUnnamedParams: true });
    for (const path of ["/", "/login", "/auth/confirm", "/app/settings", "/app/parcels/x/edit", "/api/inbound"]) {
      expect(match(path), path).not.toBe(false);
    }
  });
});
