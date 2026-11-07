import { describe, expect, it } from "vitest";
import robots from "@/app/robots";

describe("robots.txt", () => {
  it("allows the public pages and keeps crawlers out of /app and /auth", () => {
    const { rules, sitemap } = robots();
    expect(rules).toEqual({ userAgent: "*", allow: "/", disallow: ["/app", "/auth"] });
    expect(sitemap).toBeUndefined();
  });
});
