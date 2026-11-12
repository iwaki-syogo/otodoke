const PROBE = "https://otodoke.invalid";
const HOME = "/app";

/**
 * Where to go after login: a path on this site, else /app. The result goes into a Location header.
 *
 * - The value is parsed, not pattern-matched: browsers read "/\\x.example" and "/\t/x.example" as
 *   another site.
 * - The path it parses to is checked as well: "/.//x.example" and "/..//x.example" parse to
 *   "//x.example", which a browser also reads as another site.
 * - And once more with the path's percent-escapes decoded ("/%2F/x.example", "/%5C/x.example",
 *   "/%252F/x.example"), for any server on the way that decodes a path before it redirects.
 * - Never into /auth/ (nor /auth itself), checked on both of those paths and in any case. Nothing
 *   after login leads there: the login pages are where a link is used, not where one arrives. A
 *   next there showed this site's own answers after a login that worked
 *   (/auth/continue?link=refused, a refusal that did not happen), or put another person's token
 *   behind 「荷物を見る」 (/auth/continue?token_hash=…).
 *
 * No page of the app has a path that starts with an empty or encoded segment, so nothing a person
 * is sent to after login is refused. The query and fragment are kept as they are.
 */
export function safeNextPath(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith("/")) return HOME;
  const url = onThisSite(value);
  if (!url) return HOME;
  const decoded = decodeAsciiEscapes(url.pathname);
  const decodedUrl = decoded === null ? null : onThisSite(decoded);
  if (!decodedUrl) return HOME;
  if (isAuthPath(url.pathname) || isAuthPath(decodedUrl.pathname)) return HOME;
  return url.pathname + url.search + url.hash;
}

/** /auth and everything under it, in capitals too (a parsed path: dot segments resolved). */
function isAuthPath(pathname: string): boolean {
  const path = pathname.toLowerCase();
  return path === "/auth" || path.startsWith("/auth/");
}

/** `value` read as a browser reads a Location on this site; null when it would leave the site. */
function onThisSite(value: string): URL | null {
  try {
    const url = new URL(value, PROBE);
    // "//x.example" parses as a path here, but in a Location header it is another site.
    return url.origin === PROBE && !url.pathname.startsWith("//") ? url : null;
  } catch {
    return null;
  }
}

/** Decoding rounds before a path counts as nested too deep to be one the app sent. */
const MAX_DECODES = 8;

/**
 * `path` with its ASCII percent-escapes decoded, as often as they nest ("%252F" → "%2F" → "/").
 * Escapes of other bytes (Japanese text) are left alone: they cannot make a slash, a backslash or
 * the tab and newlines a browser drops. Null when the nesting goes deeper than MAX_DECODES.
 */
function decodeAsciiEscapes(path: string): string | null {
  let current = path;
  for (let round = 0; round <= MAX_DECODES; round++) {
    const next = current.replace(/%([0-7][0-9a-f])/gi, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
    if (next === current) return current;
    current = next;
  }
  return null;
}
