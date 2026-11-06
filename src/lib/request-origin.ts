/**
 * Whether a form POST came from a page of this site, by what the browser says about it. Used
 * where a POST signs the browser in (/auth/confirm): a form on another site could otherwise sign
 * the visitor in to the sender's own account (login CSRF).
 *
 * - Sec-Fetch-Site (a page cannot set it): anything but "same-origin" is refused.
 * - Origin: must be this request's own Host, over https or http (the local dev server is http).
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
  return !!host && (origin === `https://${host}` || origin === `http://${host}`);
}
