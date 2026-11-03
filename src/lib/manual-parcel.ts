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
/** Keeps a stored carrier name the five do not cover (a mail filled it in). Offered only then. */
export const MANUAL_KEEP_CARRIER = "keep";
export type ManualCarrierChoice = ManualCarrier | typeof MANUAL_KEEP_CARRIER;

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

const optionalDate = (message: string) =>
  text()
    .refine((v) => v === "" || isRealDate(v), message)
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
  ordered_at: optionalDate("注文日が正しくありません"),
  expected_date: optionalDate("お届け予定日が正しくありません"),
  total_amount: amount(),
  category: text()
    .refine((v) => v === "" || isCategory(v), "分類が正しくありません")
    .transform((v): Category | null => (v === "" ? null : (v as Category))),
  tracking_number: text()
    .refine((v) => v.length <= MANUAL_LIMITS.tracking, "追跡番号が長すぎます")
    .transform((v) => normalizeTracking(v) || null),
  carrier: z.enum([...MANUAL_CARRIERS, MANUAL_KEEP_CARRIER]).default("auto"),
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

/** The carrier choice that saves back a stored name: one of the five, "auto" when the number gives it, else keep it. */
export function manualCarrierChoice(name: string | null, tracking: string | null): ManualCarrierChoice {
  const named = MANUAL_CARRIERS.find((c) => c !== "auto" && CARRIERS[c].name === name);
  if (named) return named;
  if (name === null || carrierName("auto", tracking) === name) return "auto";
  return MANUAL_KEEP_CARRIER;
}

/** What is stored for the parcel being edited. A column not given counts as changed. */
export type ManualSaved = {
  category: string | null;
  ordered_at?: string | null;
  expected_date?: string | null;
  tracking_number?: string | null;
  carrier?: string | null;
  requires_presence?: boolean | null;
};

/**
 * The columns the form edits. Saving an edit compares with what is stored, so a save without
 * changes keeps what a mail added: an unchanged category stays automatic, an unchanged date keeps
 * its range, time and wording, an unchanged number and carrier keep the tracking URL, and an
 * unchanged way of receiving keeps its evidence. A changed one drops what came with the old value.
 */
export function manualParcelFields(v: ManualParcelInput, now: Date, saved?: ManualSaved): ManualParcelColumns {
  const category = saved && saved.category === v.category ? {} : { category: v.category, category_source: v.category ? ("user" as const) : null };

  const dateKept = saved?.expected_date !== undefined && saved.expected_date === v.expected_date;
  const date = dateKept ? {} : { expected_date: v.expected_date, expected_date_end: null, expected_window_start: null, expected_window_end: null, expected_text: null };

  const storedCarrier = saved?.carrier;
  const storedNumber = saved?.tracking_number;
  const trackingKept =
    storedCarrier !== undefined &&
    storedNumber !== undefined &&
    (normalizeTracking(storedNumber ?? "") || null) === v.tracking_number &&
    manualCarrierChoice(storedCarrier, storedNumber) === v.carrier;
  const carrier = v.carrier === MANUAL_KEEP_CARRIER ? (storedCarrier !== undefined ? storedCarrier : carrierName("auto", v.tracking_number)) : carrierName(v.carrier, v.tracking_number);
  const tracking = trackingKept ? {} : { tracking_number: v.tracking_number, carrier, tracking_url: null };

  const presence = v.presence === "" ? null : v.presence === "face";
  const evidence = saved?.requires_presence !== undefined && saved.requires_presence === presence ? {} : { presence_evidence: null };

  // An order date left empty is today for a new parcel; an edit keeps the stored one.
  const orderedAt = v.ordered_at ?? (saved?.ordered_at !== undefined ? saved.ordered_at : todayJst(now));

  return {
    title: v.title,
    shop: v.shop,
    shop_key: "other",
    ordered_at: orderedAt,
    ...date,
    total_amount: v.total_amount,
    ...category,
    ...tracking,
    requires_presence: presence,
    ...evidence,
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
