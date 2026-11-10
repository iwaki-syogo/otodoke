/**
 * Whether a form POST came from a page of this site, by what the browser says about it. Used
 * where a POST signs the browser in (/auth/confirm): a form on another site could otherwise sign
 * the visitor in to the sender's own account (login CSRF).
 *
 * - Sec-Fetch-Site (a page cannot set it): anything but "same-origin" is refused.
 * - Origin: must be this request's own Host, over https. Plain http only for the hosts a
 *   developer serves the app from over http (see servedOverHttp): a public host over http is a
 *   page someone on the network could have written.
 *   The Host is compared, never a fixed URL: otodoke.app, the Vercel URLs and localhost:3015 all
 *   post to themselves. "null" is refused, except when Sec-Fetch-Site says same-origin: a page
 *   served with `Referrer-Policy: no-referrer` sends "null" on its own POSTs (Fetch standard).
 * - Neither header: let through. Only a browser can be made to carry a forged login, every
 *   current browser sends at least one of them, and an old one should not be locked out.
 */
export function fromThisSite(headers: Headers): boolean {
  const site = headers.get("sec-fetch-site");
  if (site !== null && site !== "same-origin") return false;
  const origin = headers.get("origin")?.toLowerCase();
  if (origin === undefined) return true;
  if (origin === "null") return site === "same-origin";
  const host = headers.get("host")?.toLowerCase();
  if (!host) return false;
  return origin === `https://${host}` || (origin === `http://${host}` && servedOverHttp(host));
}

/**
 * Whether a Host (with or without its port) is one the app is served from over plain http: the
 * developer's own machine (localhost, *.localhost, 127.0.0.0/8, [::1]) or a phone on the
 * developer's tailnet (Tailscale's 100.64.0.0/10, e.g. 100.101.102.103:3015). Everything else,
 * otodoke.app and every Vercel URL included, is https.
 */
export function servedOverHttp(host: string): boolean {
  const name = hostName(host.toLowerCase());
  if (name === "localhost" || name.endsWith(".localhost") || name === "[::1]") return true;
  const ip = ipv4(name);
  return ip !== null && (ip[0] === 127 || (ip[0] === 100 && ip[1] >= 64 && ip[1] <= 127));
}

/** The name part of a Host header value: "[::1]:3015" → "[::1]", "localhost:3015" → "localhost". */
export function hostName(host: string): string {
  const match = /^(\[[0-9a-f:.]+\]|[^:[\]]+)(?::\d+)?$/.exec(host);
  return match ? match[1] : "";
}

/** The four numbers of a dotted IPv4 address; null for anything else (names, other forms). */
function ipv4(name: string): number[] | null {
  const parts = name.split(".");
  if (parts.length !== 4 || !parts.every((part) => /^(?:0|[1-9]\d{0,2})$/.test(part))) return null;
  const octets = parts.map(Number);
  return octets.every((n) => n <= 255) ? octets : null;
}
