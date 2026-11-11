import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

/**
 * Read-only smoke check for a locally running Next server. No credentials or cookies are sent.
 * Run with: node_modules/.bin/tsx scripts/check-public-pages.ts http://127.0.0.1:PORT
 * Legitimate local forms include localhost, IPv4 loopback and IPv6 loopback, with or without a
 * port or final slash. Preview/production and non-root URLs are intentionally not accepted;
 * use a local build rather than overriding that boundary.
 */
export function localBaseUrl(raw: string | undefined): URL {
  if (!raw) throw new Error("Provide the local server base URL explicitly.");
  const url = new URL(raw);
  if (!new Set(["localhost", "127.0.0.1", "[::1]"]).has(url.hostname) || !new Set(["http:", "https:"]).has(url.protocol)) {
    throw new Error("Only a loopback or localhost HTTP server is accepted.");
  }
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error("Use a base origin without credentials, path, query or fragment.");
  return url;
}

function anchorHrefs(html: string): string[] {
  return Array.from(html.matchAll(/<a\b[^>]*\bhref="([^"]+)"/g), (m) => m[1].replaceAll("&amp;", "&"));
}

export async function checkPublicPages(raw: string | undefined): Promise<string[]> {
  const base = localBaseUrl(raw);
  const results: string[] = [];
  const read = (route: string) => fetch(new URL(route, base), { method: "GET", redirect: "manual", headers: { cookie: "" }, signal: AbortSignal.timeout(15_000) });
  for (const [route, heading, sibling] of [["/terms", "利用規約", "/support"], ["/support", "サポート", "/terms"]]) {
    const response = await read(route);
    assert.equal(response.status, 200, `${route}: signed-out status`);
    const html = await response.text();
    assert.match(html, new RegExp(`<h1[^>]*>${heading}</h1>`), `${route}: visible heading`);
    assert.ok(html.includes("support@otodoke.app"), `${route}: contact`);
    assert.ok(!html.includes(["転送", "するだけ"].join("")), `${route}: wording`);
    const hrefs = anchorHrefs(html);
    for (const required of ["/", "/privacy", sibling]) assert.ok(hrefs.includes(required), `${route}: link to ${required}`);
    for (const href of new Set(hrefs.filter((value) => value.startsWith("/")))) {
      const target = new URL(href, base);
      assert.equal(target.origin, base.origin, `${route}: local link`);
      const linked = await read(target.pathname + target.search);
      if (target.pathname === "/app" || target.pathname.startsWith("/app/")) {
        assert.ok([303, 307, 308].includes(linked.status), `${href}: protected route`);
        assert.equal(new URL(linked.headers.get("location") ?? "", base).pathname, "/login", `${href}: login destination`);
      } else {
        assert.equal(linked.status, 200, `${href}: public link status`);
      }
      await linked.body?.cancel();
    }
    results.push(`PASS ${route}: signed-out 200, content and local links`);
  }
  const protectedResponse = await read("/app");
  assert.ok([303, 307, 308].includes(protectedResponse.status), "/app remains protected");
  assert.equal(new URL(protectedResponse.headers.get("location") ?? "", base).pathname, "/login");
  await protectedResponse.body?.cancel();
  results.push("PASS /app: signed-out redirect to /login");
  return results;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  checkPublicPages(process.argv[2]).then((results) => results.forEach((line) => console.log(line))).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Public-page check failed.");
    process.exitCode = 1;
  });
}
