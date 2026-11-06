/**
 * Which senders 「これは荷物」 may remember. One list, read by the pipeline (which honours a mark),
 * the settings action (which makes one) and the settings page (which lists them), so the three
 * never disagree.
 *
 * A mark is kept by the sender's domain. A domain that anyone can have an address on (free mail,
 * a phone carrier's mail, a big provider's mail) is never remembered: a mark on gmail.com would
 * send every gmail.com mail, a friend's included, past the free rules to Claude. A manual forward
 * comes from the user's own address too, so pressing 「これは荷物」 on one would mark exactly such
 * a domain. The person is told so when they press, and can register that parcel by hand.
 *
 * A remembered sender is still checked by the cheap Claude call (src/lib/pipeline.ts secondLook):
 * anyone can write a From line, and a shop sends its ads from the same domain as its notices.
 *
 * supabase/migrations/20261106180000 clears, once, the marks made on these domains before this
 * list existed. Its copy of the list is checked against this one (screen-senders.test.ts).
 */
export const SHARED_MAIL_DOMAINS: readonly string[] = [
  // Free mail
  "gmail.com",
  "googlemail.com",
  "yahoo.co.jp",
  "ymail.ne.jp",
  "yahoo.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "outlook.com",
  "outlook.jp",
  "hotmail.com",
  "hotmail.co.jp",
  "live.com",
  "live.jp",
  "msn.com",
  "aol.com",
  "proton.me",
  "protonmail.com",
  // Phone carriers
  "docomo.ne.jp",
  "ezweb.ne.jp",
  "au.com",
  "softbank.ne.jp",
  "i.softbank.jp",
  "yahoo.ne.jp",
  "ymobile.ne.jp",
  "uqmobile.jp",
  "rakumail.jp",
  // Internet providers
  "nifty.com",
  "biglobe.ne.jp",
  "ocn.ne.jp",
  "so-net.ne.jp",
  "plala.or.jp",
];

const SHARED = new Set(SHARED_MAIL_DOMAINS);

/**
 * True when a mark on mail from this domain may be remembered: there is a domain, and it is not
 * one many people have their own address on. Exact match only: a shop's own subdomain of a big
 * provider (mail.yahoo.co.jp, say) is not where people have their addresses.
 */
export function isRememberableDomain(domain: string | null | undefined): domain is string {
  const d = domain?.trim().toLowerCase().replace(/\.$/, "") ?? "";
  return d !== "" && !SHARED.has(d);
}
