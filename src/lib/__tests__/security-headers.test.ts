import { describe, expect, it } from "vitest";
import nextConfig from "../../../next.config";

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
      "Content-Security-Policy": "frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'self'",
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
    expect(directives.get("form-action")).toEqual(["'self'"]);
    // The tests run outside the dev server: no eval and no socket allowance.
    expect(directives.get("script-src")).not.toContain("'unsafe-eval'");
    expect(directives.get("connect-src")).not.toContain("ws:");
    // No host but this site and Turnstile is named anywhere.
    const hosts = watched.match(/https?:\/\/[^\s;]+/g) ?? [];
    expect(new Set(hosts)).toEqual(new Set(["https://challenges.cloudflare.com"]));
    // Watching only: the enforced policy restricts none of these.
    const enforced = rule.headers.find((h) => h.key === "Content-Security-Policy")!.value;
    for (const d of ["default-src", "script-src", "connect-src", "frame-src", "img-src", "style-src"]) expect(enforced).not.toContain(d);
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
