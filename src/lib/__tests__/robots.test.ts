import { describe, expect, it } from "vitest";
import robots from "@/app/robots";

describe("robots.txt", () => {
  it("allows the public pages and keeps crawlers out of /app and /auth", () => {
    const { rules, sitemap } = robots();
    expect(rules).toEqual({ userAgent: "*", allow: "/", disallow: ["/app/", "/app$", "/auth/"] });
    expect(sitemap).toBeUndefined();
  });

  it("has no bare-prefix disallow that would block /apple-icon.png", () => {
    const { rules } = robots();
    const disallow = (Array.isArray(rules) ? rules[0] : rules).disallow as string[];
    for (const entry of disallow.filter((e) => !e.endsWith("$"))) {
      expect("/apple-icon.png".startsWith(entry)).toBe(false);
    }
  });
});
