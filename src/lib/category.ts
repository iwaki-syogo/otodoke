/**
 * Spending categories of a parcel. This file is the only place that spells out the keys,
 * their display names and colours; everything else imports from here.
 */
export const CATEGORIES = ["food", "daily", "hobby", "fashion", "electronics", "beauty", "other"] as const;

export type Category = (typeof CATEGORIES)[number];

/** Who set parcels.category: the reading (auto) or the person (user, never overwritten automatically). */
export const CATEGORY_SOURCES = ["auto", "user"] as const;
export type CategorySource = (typeof CATEGORY_SOURCES)[number];

/** Where a parcel came from: built from mails, or typed in by the person. */
export const PARCEL_SOURCES = ["mail", "manual"] as const;
export type ParcelSource = (typeof PARCEL_SOURCES)[number];

export const UNCATEGORIZED_LABEL = "未分類";

const LABELS: Record<Category, string> = {
  food: "食費",
  daily: "日用品",
  hobby: "趣味・レジャー",
  fashion: "ファッション",
  electronics: "家電・ガジェット",
  beauty: "美容・健康",
  other: "その他",
};

// Categorical slots in a fixed order (validated for colour-vision deficiency on adjacent pairs).
// Uncategorized is a neutral gray on purpose: it is "no category", not an eighth one.
const COLORS: Record<Category, string> = {
  food: "#2a78d6",
  daily: "#eb6834",
  hobby: "#1baf7a",
  fashion: "#eda100",
  electronics: "#e87ba4",
  beauty: "#008300",
  other: "#6250d6",
};
const UNCATEGORIZED_COLOR = "#a8a7a0";

export function isCategory(v: unknown): v is Category {
  return typeof v === "string" && (CATEGORIES as readonly string[]).includes(v);
}

export function categoryLabel(c: Category | null): string {
  return c ? LABELS[c] : UNCATEGORIZED_LABEL;
}

export function categoryColor(c: Category | null): string {
  return c ? COLORS[c] : UNCATEGORIZED_COLOR;
}
