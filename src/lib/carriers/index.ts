/**
 * Carrier identification is rule-based on purpose: a tracking number's shape plus
 * the carrier name written in the mail decides, never the model.
 */
export type CarrierKey = "yamato" | "sagawa" | "japanpost" | "amazon" | "seino" | "fukutsu" | "unknown";

/**
 * How to show a parcel on the carrier's own site with its number already in.
 * - open: a plain link whose URL carries the number.
 * - post: the carrier's form only takes the number by POST, so the app submits that form.
 * - copy: the carrier takes no number from outside; the user copies it, then opens the input
 *   page in a new tab. pageName is that page's own title, shown on the link to it.
 * Checked against each site on 2026-11-03. Sagawa's new page (after its October 2026
 * outage) runs on Server Actions, which refuse a cross-site POST, hence "copy".
 */
export type TrackingLink =
  | { kind: "open"; url: string }
  | { kind: "post"; url: string; fields: Record<string, string> }
  | { kind: "copy"; url: string; pageName: string };

export interface CarrierInfo {
  key: CarrierKey;
  name: string;
  link: (n: string) => TrackingLink | null;
}

export const CARRIERS: Record<CarrierKey, CarrierInfo> = {
  yamato: {
    key: "yamato",
    name: "ヤマト運輸",
    // A GET with the number shows an empty form; the form itself posts these two fields.
    link: (n) => ({ kind: "post", url: "https://toi.kuronekoyamato.co.jp/cgi-bin/tneko", fields: { category: "1", number01: n } }),
  },
  sagawa: {
    key: "sagawa",
    name: "佐川急便",
    link: () => ({ kind: "copy", url: "https://e-customer.sagawa-exp.co.jp/k2k", pageName: "佐川のお荷物お問い合わせサービス" }),
  },
  japanpost: {
    key: "japanpost",
    name: "日本郵便",
    link: (n) => ({
      kind: "open",
      url: `https://trackings.post.japanpost.jp/services/srv/search/direct?reqCodeNo1=${n}&searchKind=S002&locale=ja`,
    }),
  },
  amazon: {
    key: "amazon",
    name: "Amazon配送",
    link: () => null, // tracked from the order page, no public lookup by number
  },
  seino: {
    key: "seino",
    name: "西濃運輸",
    link: (n) => ({ kind: "post", url: "https://track.seino.co.jp/kamotsu/gempyoNoShokaiSpn.do", fields: { action: "InquirySpn", GNPNO1: n } }),
  },
  fukutsu: {
    key: "fukutsu",
    name: "福山通運",
    link: (n) => ({ kind: "open", url: `https://corp.fukutsu.co.jp/situation/tracking_no_hunt/${n}` }),
  },
  unknown: { key: "unknown", name: "不明", link: () => null },
};

const HINTS: Array<[RegExp, CarrierKey]> = [
  [/ヤマト|クロネコ|kuroneko|yamato/i, "yamato"],
  [/佐川|sagawa/i, "sagawa"],
  [/日本郵便|ゆうパック|ゆうパケット|郵便局|japan ?post|レターパック|クリックポスト/i, "japanpost"],
  [/amazon|アマゾン/i, "amazon"],
  [/西濃|seino/i, "seino"],
  [/福山通運|fukutsu/i, "fukutsu"],
];

/** Full-width ASCII forms (U+FF01-U+FF5E) as ASCII: １２３４ is 1234, Ｎｏ． is No. */
function halfWidth(s: string): string {
  return s.replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
}

/**
 * A "No." or "No:" before the number (No.1234-5678-9012, 伝票No.1234…, Ｎｏ．１２３４…). The "." or
 * ":" tells the label from a number that starts with the letters NO (EJ123456789JP's two letters
 * can be any two); a number itself never has either.
 */
const NUMBER_LABEL = /^[^0-9A-Za-z]*no\s*[.:]/i;

/**
 * Normalize a tracking number: keep letters and digits only, upper-cased, after dropping a "No."
 * label. Full-width ones (１２３４, typed in Japanese input or printed in a mail) count as their
 * half-width forms first, or they would be dropped and the number lost. Only those are folded, not
 * all of NFKC: NFKC spells signs with letters and digits (№ as "No", ① as "1"), which then joined
 * the number and changed it. A sign is dropped like any other mark. Letters and digits come out
 * unchanged, so a number stored before reads the same. Empty when nothing of it is left.
 */
export function normalizeTracking(raw: string): string {
  return halfWidth(raw).replace(NUMBER_LABEL, "").replace(/[^0-9A-Za-z]/g, "").toUpperCase();
}

/**
 * Decide the carrier from the number shape and, where the shape is ambiguous
 * (12 digits can be Yamato or Sagawa), from a carrier name mentioned nearby.
 */
export function identifyCarrier(trackingRaw: string | null | undefined, hint?: string | null): CarrierInfo {
  const hinted = hint ? HINTS.find(([re]) => re.test(hint))?.[1] : undefined;
  const n = trackingRaw ? normalizeTracking(trackingRaw) : "";

  if (/^TBA\d{9,13}$/.test(n)) return CARRIERS.amazon;
  if (/^[A-Z]{2}\d{9}JP$/.test(n)) return CARRIERS.japanpost; // EMS / international
  if (/^\d{12}$/.test(n)) {
    if (hinted === "yamato" || hinted === "sagawa") return CARRIERS[hinted];
    if (hinted && hinted !== "unknown") return CARRIERS[hinted];
    return CARRIERS.unknown;
  }
  if (/^\d{11}$/.test(n) || /^\d{13}$/.test(n)) {
    return CARRIERS[hinted && hinted !== "unknown" ? hinted : "japanpost"];
  }
  if (/^\d{10}$/.test(n)) return CARRIERS[hinted && hinted !== "unknown" ? hinted : "unknown"];
  if (hinted) return CARRIERS[hinted];
  return CARRIERS.unknown;
}

/** How to look a number up on the carrier's site, or null when the carrier has no public lookup. */
export function trackingLinkFor(trackingRaw: string | null | undefined, hint?: string | null): TrackingLink | null {
  if (!trackingRaw) return null;
  const n = normalizeTracking(trackingRaw);
  if (!n) return null;
  return identifyCarrier(trackingRaw, hint).link(n);
}

/**
 * Amazon's own tracking for an order (Amazon parcels rarely carry a carrier number). This
 * address sends a signed-out user to sign-in and then on to the order's package tracking page.
 * Only a Japanese Amazon order number (250-1234567-1234567) is turned into a link.
 */
export function amazonOrderTrackingUrl(orderNumber: string | null | undefined): string | null {
  const n = orderNumber?.trim() ?? "";
  if (!/^\d{3}-\d{7}-\d{7}$/.test(n)) return null;
  return `https://www.amazon.co.jp/gp/your-account/ship-track?orderId=${encodeURIComponent(n)}`;
}

/** The carrier page for a number, or null when the carrier has no public lookup. */
export function trackingUrlFor(trackingRaw: string | null | undefined, hint?: string | null): string | null {
  return trackingLinkFor(trackingRaw, hint)?.url ?? null;
}
