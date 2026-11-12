import { z } from "zod";
import { CARRIERS, identifyCarrier, normalizeTracking } from "@/lib/carriers";
import { isCategory, type Category } from "@/lib/category";
import type { Database } from "@/lib/db/database.types";
import { todayJst } from "@/lib/format";
import { RECEIVED_AT_NONE, isReceivedAt, needsCheck } from "@/lib/match";

/**
 * A parcel typed in by hand: the form's checks and the parcels columns it becomes.
 * Kept out of the "use server" file so its types and constants can be shared with the form.
 */

/** Longest values kept. Shop listings often run long, so names get room; numbers do not. */
export const MANUAL_LIMITS = { title: 300, shop: 100, tracking: 40 } as const;
/** The most that may be typed in, to stop a mistyped amount. An amount a mail filled in may be more. */
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
export const MANUAL_STATUSES = ["ordered", "shipped", "delivered", "received"] as const;
/**
 * "received" is a choice on the form only: it is saved as status delivered with received_at set.
 * "delivered" (配達済み) is delivered with received_at empty.
 */
export const MANUAL_RECEIVED = "received";
/**
 * Statuses a mail can move a typed-in parcel to. The form shows them only when the parcel is
 * already there, so saving it unchanged still works.
 */
export const MANUAL_CARRIED_STATUSES = ["out_for_delivery", "attempted"] as const;
/** A cancel notice moves a typed-in parcel here. Only a parcel already cancelled may be saved with it. */
export const MANUAL_CANCELLED = "cancelled";

/** Said when a delete comes without the 「本当に消す」 check. The same words as settings' clear_confirm. */
export const MANUAL_DELETE_UNCHECKED = "「本当に消す」にチェックを入れてください";

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

/**
 * Allows "1,980", "¥1,980", "¥ 1,980 円" and full-width digits (spaces only at the ends, after ¥ and before 円); still a whole number of yen, up to MANUAL_MAX_AMOUNT. The
 * stored amount saved back as it is passes too: a mail fills in an amount left empty, up to what
 * the column holds (2,147,483,647), and an edit that leaves it alone must still save.
 */
const amount = (stored: number | null = null) =>
  text()
    .transform((v) => {
      // Commas go wherever they are. Spaces go only at the ends, after ¥ and before 円: a space
      // between digits stays, so "480 480" is refused instead of joined into 480480.
      const cleaned = v
        .normalize("NFKC")
        .replace(/,/g, "")
        .trim()
        .replace(/^[¥￥]\s*(?=\d)/, "")
        .replace(/(\d)\s*円$/, "$1");
      // An input that was only commas must not read as empty: that would drop the amount silently.
      return cleaned === "" && v !== "" ? v : cleaned;
    })
    .refine((v) => v === "" || (/^\d{1,10}$/.test(v) && (Number(v) <= MANUAL_MAX_AMOUNT || Number(v) === stored)), "金額が正しくありません")
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

/**
 * The checks for saving an edit, given what is stored: a cancelled parcel may stay cancelled, and
 * the stored amount may be saved back unchanged, even one above what may be typed.
 */
export function manualParcelSchemaFor(currentStatus: string | null, storedAmount: number | null = null) {
  const total_amount = amount(storedAmount);
  return currentStatus === MANUAL_CANCELLED ? ManualParcelWhileCancelled.extend({ total_amount }) : ManualParcelSchema.extend({ total_amount });
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

const isReceivedRow = (saved?: Pick<ManualSaved, "status" | "received_at">) => saved?.status === "delivered" && isReceivedAt(saved.received_at);

type ReceivedColumns = { received_at?: string | null; check_dismissed_at?: string };

/**
 * 配達済み onto a parcel that is not delivered yet is written as received_at = '-infinity' (RECEIVED_AT_NONE) in
 * the same write: the database stores null and does not fill it in, which a plain null cannot ask for.
 * `date` is the date the parcel will have after this save, for the 14 days.
 */
function receivedColumns(choice: string, saved: ManualSaved | undefined, now: Date, date: { expected_date: string | null; expected_date_end: string | null }): ReceivedColumns {
  const wasDelivered = saved?.status === "delivered";
  if (choice === MANUAL_RECEIVED) return isReceivedRow(saved) ? {} : { received_at: now.toISOString() };
  if (choice === "delivered") {
    if (!wasDelivered) return { received_at: RECEIVED_AT_NONE };
    if (!isReceivedRow(saved)) return {};
    // 受け取り済み → 配達済み is the person saying 受け取っていない. Only when 要確認 would ask at once
    // (14 days or more since the delivery) is 「まだ」 recorded; an early answer is asked once at day 14.
    const asked = needsCheck({ status: "delivered", ...date, last_email_at: saved?.last_email_at ?? null, received_at: null, check_dismissed_at: null }, todayJst(now));
    return asked ? { received_at: null, check_dismissed_at: now.toISOString() } : { received_at: null };
  }
  return wasDelivered ? { received_at: null } : {};
}

/** What is stored for the parcel being edited. A column not given counts as changed. */
export type ManualSaved = {
  status?: string | null;
  received_at?: string | null;
  expected_date_end?: string | null;
  last_email_at?: string | null;
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

  // The form's 配達済み is delivered with no received_at, its 受け取り済み (received) is delivered with one.
  // An unchanged choice writes nothing about it, so a parcel keeps the received_at it has. A parcel that
  // leaves delivered loses it (the database does the same).
  const received = receivedColumns(v.status, saved, now, dateKept ? { expected_date: saved?.expected_date ?? null, expected_date_end: saved?.expected_date_end ?? null } : { expected_date: v.expected_date, expected_date_end: null });

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
    status: v.status === MANUAL_RECEIVED ? "delivered" : v.status,
    ...received,
  };
}

/**
 * The parcels columns for a new typed-in parcel (user_id is added by the caller from the session).
 * No tracking URL is built from typed input, and no parcel_items are written.
 */
export function manualParcelRow(v: ManualParcelInput, now: Date): ManualParcelColumns {
  return { ...manualParcelFields(v, now), source: "manual", last_email_at: now.toISOString() };
}

/** Whether an untouched creation still holds this form's values, without rewriting its times. */
export function manualCreationMatches(v: ManualParcelInput, saved: Database["public"]["Tables"]["parcels"]["Row"]): boolean {
  if (typeof saved.created_at !== "string" || !Number.isFinite(Date.parse(saved.created_at)) || saved.created_at !== saved.updated_at
    || typeof saved.last_email_at !== "string" || !Number.isFinite(Date.parse(saved.last_email_at))) return false;

  // last_email_at was written from the same clock as received_at and an empty order date.
  // A retry tomorrow must compare with that original write, rather than tomorrow's defaults.
  const expected = {
    received_at: null,
    order_number: null,
    needs_review: false,
    check_dismissed_at: null,
    ...manualParcelRow(v, new Date(saved.last_email_at)),
  };
  const stored: Record<string, unknown> = saved;
  return Object.entries(expected).every(([key, value]) => {
    // The received trigger turns the explicit "not received" sentinel into SQL NULL.
    if (key === "received_at" && value === RECEIVED_AT_NONE) return stored[key] === null;
    if ((key === "received_at" || key === "last_email_at") && typeof value === "string") {
      return typeof stored[key] === "string" && Date.parse(stored[key]) === Date.parse(value);
    }
    return stored[key] === value;
  });
}

/** What is stored, as far as "does this save change anything" needs it. */
export type ManualStoredForCompare = {
  title: string | null;
  shop: string | null;
  status: string | null;
  total_amount: number | null;
  requires_presence: boolean | null;
  received_at?: string | null;
};

/**
 * Whether writing `columns` (manualParcelFields given what is stored) would change nothing: every
 * column the edit always sends equals what is stored, and no other column is there (those are
 * written only on a difference). shop_key is not compared (an edit always sends "other"). A stored
 * null title or shop counts as a difference, the safe side. The same rule as the iOS app's writesNothing.
 */
export function manualWritesNothing(
  columns: ManualParcelColumns,
  saved: ManualStoredForCompare & { ordered_at?: string | null; tracking_number?: string | null; carrier?: string | null },
): boolean {
  for (const [key, value] of Object.entries(columns)) {
    switch (key) {
      case "title":
        if (saved.title === null || value !== saved.title) return false;
        break;
      case "shop":
        if (saved.shop === null || value !== saved.shop) return false;
        break;
      case "shop_key":
        break;
      case "ordered_at":
        // "=== undefined" is for clarity: a column not read never equals the value.
        if (saved.ordered_at === undefined || value !== saved.ordered_at) return false;
        break;
      // The tracking columns come together. Compared by value (not by the choice on the form), so a
      // number the automatic choice named, saved once, reads as the same: the carrier name written is
      // the stored one. tracking_url is not looked at.
      case "tracking_number":
        if (saved.tracking_number === undefined || value !== (normalizeTracking(saved.tracking_number ?? "") || null)) return false;
        break;
      case "carrier":
        // "=== undefined" is for clarity: a column not read never equals the value.
        if (saved.carrier === undefined || value !== saved.carrier) return false;
        break;
      case "tracking_url":
        break;
      case "total_amount":
        if (value !== saved.total_amount) return false;
        break;
      case "status":
        if (value !== saved.status) return false;
        break;
      case "received_at":
        // "=== undefined": a column not read never equals the value.
        if (saved.received_at === undefined || value !== saved.received_at) return false;
        break;
      case "requires_presence":
        if (value !== saved.requires_presence) return false;
        break;
      default:
        return false;
    }
  }
  return true;
}
