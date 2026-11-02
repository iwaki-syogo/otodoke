/**
 * Carrier identification is rule-based on purpose: a tracking number's shape plus
 * the carrier name written in the mail decides, never the model.
 */
export type CarrierKey = "yamato" | "sagawa" | "japanpost" | "amazon" | "seino" | "fukutsu" | "unknown";

export interface CarrierInfo {
  key: CarrierKey;
  name: string;
  trackingUrl: (n: string) => string | null;
}

export const CARRIERS: Record<CarrierKey, CarrierInfo> = {
  yamato: {
    key: "yamato",
    name: "ヤマト運輸",
    trackingUrl: (n) => `https://toi.kuronekoyamato.co.jp/cgi-bin/tneko?number=${n}`,
  },
  sagawa: {
    key: "sagawa",
    name: "佐川急便",
    trackingUrl: (n) => `https://k2k.sagawa-exp.co.jp/p/web/okurijosearch.do?okurijoNo=${n}`,
  },
  japanpost: {
    key: "japanpost",
    name: "日本郵便",
    trackingUrl: (n) =>
      `https://trackings.post.japanpost.jp/services/srv/search/direct?reqCodeNo1=${n}&searchKind=S002&locale=ja`,
  },
  amazon: {
    key: "amazon",
    name: "Amazon配送",
    trackingUrl: () => null, // tracked from the order page, no public lookup by number
  },
  seino: {
    key: "seino",
    name: "西濃運輸",
    trackingUrl: (n) => `https://track.seino.co.jp/cgi-bin/gnpquery.pgm?GNPNO1=${n}`,
  },
  fukutsu: {
    key: "fukutsu",
    name: "福山通運",
    trackingUrl: (n) => `https://corp.fukutsu.co.jp/situation/tracking_no_hunt/${n}`,
  },
  unknown: { key: "unknown", name: "不明", trackingUrl: () => null },
};

const HINTS: Array<[RegExp, CarrierKey]> = [
  [/ヤマト|クロネコ|kuroneko|yamato/i, "yamato"],
  [/佐川|sagawa/i, "sagawa"],
  [/日本郵便|ゆうパック|ゆうパケット|郵便局|japan ?post|レターパック|クリックポスト/i, "japanpost"],
  [/amazon|アマゾン/i, "amazon"],
  [/西濃|seino/i, "seino"],
  [/福山通運|fukutsu/i, "fukutsu"],
];

/** Normalize a tracking number: keep letters and digits only. */
export function normalizeTracking(raw: string): string {
  return raw.replace(/[^0-9A-Za-z]/g, "").toUpperCase();
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

/** Tracking URL for a number, or null when the carrier has no public lookup. */
export function trackingUrlFor(trackingRaw: string | null | undefined, hint?: string | null): string | null {
  if (!trackingRaw) return null;
  const info = identifyCarrier(trackingRaw, hint);
  return info.trackingUrl(normalizeTracking(trackingRaw));
}
