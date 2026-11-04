import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Supabase Auth only redirects to URLs in auth.additional_redirect_urls.
// A wildcard host on vercel.app (e.g. "https://*-team.vercel.app") would let any
// project deployed under that team scope receive login links, so only exact hosts are allowed.
const configPath = path.resolve(__dirname, "../../../supabase/config.toml");

function readRedirectUrls(): string[] {
  const toml = readFileSync(configPath, "utf8");
  const line = toml.split("\n").find((l) => /^additional_redirect_urls\s*=/.test(l));
  if (!line) throw new Error("additional_redirect_urls is missing from supabase/config.toml");
  // A single-line TOML array of basic strings is valid JSON.
  const urls: unknown = JSON.parse(line.slice(line.indexOf("=") + 1).trim());
  if (!Array.isArray(urls) || !urls.every((u) => typeof u === "string")) {
    throw new Error("additional_redirect_urls must be an array of strings");
  }
  return urls;
}

function hostOf(url: string): string {
  // Not using URL(): it rejects or rewrites "*" in the host.
  return url.replace(/^[a-z]+:\/\//, "").split(/[/:]/)[0];
}

describe("supabase auth.additional_redirect_urls", () => {
  const urls = readRedirectUrls();

  it("has no wildcard host on vercel.app", () => {
    const wildcardVercel = urls.filter((u) => {
      const host = hostOf(u);
      return host.endsWith("vercel.app") && host.includes("*");
    });
    expect(wildcardVercel).toEqual([]);
  });

  it("allows the dev branch preview URL", () => {
    expect(urls).toContain("https://otodoke-app-git-dev-syodgo-9062s-projects.vercel.app/auth/confirm**");
  });

  it("allows the production domain", () => {
    expect(urls).toContain("https://otodoke.app/auth/confirm**");
  });

  it("allows the local dev server", () => {
    expect(urls).toContain("http://localhost:3015/auth/confirm**");
    expect(urls).toContain("http://otodoke.localhost:3015/auth/confirm**");
  });
});
