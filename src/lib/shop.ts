import { isCategory, type Category } from "@/lib/category";

/** Shops and the URL values the delivered and spend pages read (`?s=`, `?c=`). */

/** 未分類 in `?c=`. */
export const NONE = "none";

/** The shop a parcel counts under: Amazon signs its mails under several names, so they read as one. */
export function normalizeShop(p: { shop: string; shop_key: string | null }): string {
  return p.shop_key === "amazon" ? "Amazon" : p.shop;
}

/** A query value as one string: the first of an array, undefined for none. */
export function firstParam(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

/** `?c=` as a filter: one of the seven, null for 未分類 (`none`), undefined (no filter) for anything else. */
export function categoryParam(c: string | string[] | undefined): Category | null | undefined {
  const v = firstParam(c);
  return v === NONE ? null : isCategory(v) ? v : undefined;
}
