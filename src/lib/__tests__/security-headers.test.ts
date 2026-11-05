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
      "Content-Security-Policy": "frame-ancestors 'none'",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "strict-origin-when-cross-origin",
      "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    });
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
