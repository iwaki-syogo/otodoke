import { z } from "zod";
import { CARRIERS, identifyCarrier, normalizeTracking } from "@/lib/carriers";
import { isCategory, type Category } from "@/lib/category";
import type { Database } from "@/lib/db/database.types";
import { todayJst } from "@/lib/format";

/**
 * A parcel typed in by hand: the form's checks and the parcels columns it becomes.
 * Kept out of the "use server" file so its types and constants can be shared with the form.
 */

/** Longest values kept. Shop listings often run long, so names get room; numbers do not. */
export const MANUAL_LIMITS = { title: 300, shop: 100, tracking: 40 } as const;
export const MANUAL_MAX_AMOUNT = 10_000_000;

/** Carrier choices on the form. "auto" lets the number's shape decide. */
export const MANUAL_CARRIERS = ["auto", "yamato", "sagawa", "japanpost", "seino", "fukutsu"] as const;
export type ManualCarrier = (typeof MANUAL_CARRIERS)[number];

/** How it is received: face to face, left at the door / in the mailbox, or not said. */
export const MANUAL_PRESENCE = ["face", "drop", ""] as const;

/** Statuses the form offers. */
export const MANUAL_STATUSES = ["ordered", "shipped", "delivered"] as const;
/**
 * Statuses a mail can move a typed-in parcel to. The form shows them only when the parcel is
 * already there, so saving it unchanged still works.
 */
export const MANUAL_CARRIED_STATUSES = ["out_for_delivery", "attempted"] as const;
/** A cancel notice moves a typed-in parcel here. Only a parcel already cancelled may be saved with it. */
export const MANUAL_CANCELLED = "cancelled";

/** What the form's Server Actions answer: the error, and what was sent so the fields can refill. */
export type ManualFormState = { error: string | null; values: Record<string, string> };

// Form values arrive as strings; a missing field reads as empty.
const text = () => z.string().default("").transform((s) => s.trim());

function isRealDate(v: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (y < 1900 || y > 2100) return false;
  const t = new Date(Date.UTC(2000, mo - 1, d));
  t.setUTCFullYear(y);
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}

const optionalDate = () =>
  text()
    .refine((v) => v === "" || isRealDate(v), "日付が正しくありません")
    .transform((v) => (v === "" ? null : v));

// Allows "1,980" and full-width digits; still a whole number of yen.
const amount = () =>
  text()
    .transform((v) => v.normalize("NFKC").replace(/,/g, ""))
    .refine((v) => v === "" || (/^\d{1,9}$/.test(v) && Number(v) <= MANUAL_MAX_AMOUNT), "金額が正しくありません")
    .transform((v) => (v === "" ? null : Number(v)));

export const ManualParcelSchema = z.object({
  title: text().pipe(z.string().min(1, "品名を入れてください").max(MANUAL_LIMITS.title, "品名が長すぎます")),
  shop: text().pipe(z.string().min(1, "店を入れてください").max(MANUAL_LIMITS.shop, "店の名前が長すぎます")),
  ordered_at: optionalDate(),
  expected_date: optionalDate(),
  total_amount: amount(),
  category: text()
    .refine((v) => v === "" || isCategory(v), "分類が正しくありません")
    .transform((v): Category | null => (v === "" ? null : (v as Category))),
  tracking_number: text()
    .refine((v) => v.length <= MANUAL_LIMITS.tracking, "追跡番号が長すぎます")
    .transform((v) => normalizeTracking(v) || null),
  carrier: z.enum(MANUAL_CARRIERS).default("auto"),
  presence: z.enum(MANUAL_PRESENCE).default(""),
  status: z.enum([...MANUAL_STATUSES, ...MANUAL_CARRIED_STATUSES]),
});

const ManualParcelWhileCancelled = ManualParcelSchema.extend({
  status: z.enum([...MANUAL_STATUSES, ...MANUAL_CARRIED_STATUSES, MANUAL_CANCELLED]),
});

/** The checks for saving an edit, given the parcel's status now: a cancelled one may stay cancelled. */
export function manualParcelSchemaFor(currentStatus: string | null) {
  return currentStatus === MANUAL_CANCELLED ? ManualParcelWhileCancelled : ManualParcelSchema;
}

export type ManualParcelInput = z.output<typeof ManualParcelWhileCancelled>;

type ParcelInsert = Database["public"]["Tables"]["parcels"]["Insert"];
export type ManualParcelColumns = Omit<ParcelInsert, "user_id">;

function carrierName(choice: ManualCarrier, tracking: string | null): string | null {
  if (choice !== "auto") return CARRIERS[choice].name;
  const found = identifyCarrier(tracking);
  return found.key === "unknown" ? null : found.name;
}

/**
 * The columns the form edits. Saving an edit writes only these. Given the stored category, an
 * unchanged one is left out, so an automatic category stays automatic.
 */
export function manualParcelFields(v: ManualParcelInput, now: Date, saved?: { category: string | null }): ManualParcelColumns {
  const category = saved && saved.category === v.category ? {} : { category: v.category, category_source: v.category ? ("user" as const) : null };
  return {
    title: v.title,
    shop: v.shop,
    shop_key: "other",
    ordered_at: v.ordered_at ?? todayJst(now),
    expected_date: v.expected_date,
    total_amount: v.total_amount,
    ...category,
    tracking_number: v.tracking_number,
    carrier: carrierName(v.carrier, v.tracking_number),
    tracking_url: null,
    requires_presence: v.presence === "" ? null : v.presence === "face",
    status: v.status,
  };
}

/**
 * The parcels columns for a new typed-in parcel (user_id is added by the caller from the session).
 * No tracking URL is built from typed input, and no parcel_items are written.
 */
export function manualParcelRow(v: ManualParcelInput, now: Date): ManualParcelColumns {
  return { ...manualParcelFields(v, now), source: "manual", last_email_at: now.toISOString() };
}
