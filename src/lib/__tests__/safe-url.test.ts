import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isHttpsUrl } from "@/lib/safe-url";

/**
 * isHttpsUrl(raw): true only for an absolute https: URL (parsed with `new URL`), so a stored
 * tracking_url can become a link only when it cannot run script or point at a data blob.
 */

describe("isHttpsUrl", () => {
  it.each(["https://tracking.example.test/track?no=123456789012", "https://example.test", "HTTPS://EXAMPLE.TEST/a"])("lets %s through", (url) => {
    expect(isHttpsUrl(url)).toBe(true);
  });

  it.each([
    "http://tracking.example.test/track",
    "javascript:alert(1)",
    "JavaScript:alert(1)",
    " javascript:alert(1)",
    "java\tscript:alert(1)",
    "data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==",
    "vbscript:msgbox(1)",
    "/app/parcels/123",
    "//evil.example.test/x",
    "tracking.example.test/track",
    "https//broken",
    "https:",
    "ftp://example.test/file",
    "",
  ])("stops %j", (url) => {
    expect(isHttpsUrl(url)).toBe(false);
  });

  it("stops null and undefined", () => {
    expect(isHttpsUrl(null)).toBe(false);
    expect(isHttpsUrl(undefined)).toBe(false);
  });
});

describe("parcel page", () => {
  const page = readFileSync(path.resolve(__dirname, "../../app/app/parcels/[id]/page.tsx"), "utf8");

  it("checks a stored tracking_url before linking to it", () => {
    expect(page).toContain("isHttpsUrl");
    // The stored URL is only used behind the check.
    expect(page).toMatch(/isHttpsUrl\(\s*parcel\.tracking_url\s*\)/);
  });

  it("shows the category row and an edit link for typed-in parcels", () => {
    expect(page).toContain("CategorySheet");
    expect(page).toMatch(/\/edit/);
    expect(page).toMatch(/["']manual["']/);
  });
});
