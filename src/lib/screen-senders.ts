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
 * supabase/migrations/20261106180000 has the same lists in public.is_shared_mail_domain(): the
 * daily purge treats a mark on such a domain as no mark, and the migration clears those marks once.
 * Its copies are checked against these (screen-senders-migration.test.ts).
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
  // Internet providers whose addresses are on the domain itself
  "nifty.com",
  "ybb.ne.jp",
  "excite.co.jp",
];

/**
 * Internet providers that give each person an address on a subdomain of their own domain
 * (user@xxx.plala.or.jp, user@abc.ocn.ne.jp): the domain and every subdomain of it are shared.
 * Only these: the free-mail domains above are matched exactly, so a big provider's own system
 * subdomain (mail.yahoo.co.jp, where its shop sends from) can still be remembered.
 */
export const SHARED_MAIL_DOMAIN_SUFFIXES: readonly string[] = [
  "plala.or.jp",
  "ocn.ne.jp",
  "so-net.ne.jp",
  "biglobe.ne.jp",
  "auone-net.jp",
  "dion.ne.jp",
  "odn.ne.jp",
  "eonet.ne.jp",
  "hi-ho.ne.jp",
  "asahi-net.or.jp",
  "zaq.ne.jp",
  "home.ne.jp",
];

const SHARED = new Set(SHARED_MAIL_DOMAINS);

function normalized(domain: string | null | undefined): string {
  return domain?.trim().toLowerCase().replace(/\.+$/, "") ?? "";
}

/** A domain many people have their own address on: listed exactly, or under a listed provider. */
export function isSharedMailDomain(domain: string | null | undefined): boolean {
  const d = normalized(domain);
  return SHARED.has(d) || SHARED_MAIL_DOMAIN_SUFFIXES.some((s) => d === s || d.endsWith(`.${s}`));
}

/**
 * True when a mark on mail from this domain may be remembered: there is a domain, and it is not
 * one many people have their own address on (isSharedMailDomain).
 */
export function isRememberableDomain(domain: string | null | undefined): domain is string {
  return normalized(domain) !== "" && !isSharedMailDomain(domain);
}

/** A subject of a mail forwarded by hand (Gmail Fwd:, Outlook FW:, 転送:). */
const FORWARDED_SUBJECT = /^\s*(?:fwd?|fw|転送)\s*[:：]/i;

/**
 * A dropped mail that came from the person themselves: a copy they forwarded by hand (its sender is
 * them, not the shop), or a mail from the domain of their own login address. Its sender is never
 * remembered: the person's own domain would let their own (and, on a company domain, their
 * colleagues') mail past the free rules.
 */
export function cameFromThemselves(row: { from_domain: string | null; subject: string | null }, ownEmail: string | null | undefined): boolean {
  if (FORWARDED_SUBJECT.test(row.subject ?? "")) return true;
  const own = normalized(ownEmail?.split("@")[1]);
  // On a shared domain (gmail.com) the same domain is anybody's: that is said as shared instead.
  return own !== "" && normalized(row.from_domain) === own && !isSharedMailDomain(own);
}
