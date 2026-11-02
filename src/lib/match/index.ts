import type { Database } from "@/lib/db/database.types";
import type { Extraction, Relevance } from "@/lib/extract/schema";
import { identifyCarrier, normalizeTracking, trackingUrlFor } from "@/lib/carriers";
import { todayJst } from "@/lib/format";

/** Calendar date (JST) of an ISO instant, for the `date` columns. */
function jstDate(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : todayJst(d);
}

export type ParcelRow = Database["public"]["Tables"]["parcels"]["Row"];
export type ParcelInsert = Database["public"]["Tables"]["parcels"]["Insert"];
export type ParcelUpdate = Database["public"]["Tables"]["parcels"]["Update"];

/** Parcel status, ordered so that a later stage never regresses to an earlier one. */
export const STATUS_RANK: Record<string, number> = {
  unknown: 0,
  ordered: 1,
  shipped: 2,
  out_for_delivery: 3,
  attempted: 3,
  delivered: 4,
  cancelled: 9,
};

export function relevanceToStatus(r: Relevance): string | null {
  switch (r) {
    case "order":
    case "payment":
      return "ordered";
    case "shipped":
      return "shipped";
    case "out_for_delivery":
      return "out_for_delivery";
    case "attempted":
      return "attempted";
    case "delivered":
      return "delivered";
    case "cancelled":
      return "cancelled";
    default:
      return null;
  }
}

export function isParcelRelevant(r: Relevance): boolean {
  return r !== "unrelated";
}

/** Normalize an order number for matching: drop spaces/dashes, uppercase. */
export function normalizeOrderNumber(raw: string): string {
  return raw.replace(/[\s\-‐–—]/g, "").toUpperCase();
}

const MIN_CONFIDENCE = 0.6;

/** A value of the wrong shape is treated as unread, so one odd value cannot fail the whole mail. */
function asDate(v: string | null): string | null {
  return v && /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(v) ? v : null;
}
/** A clock time as HH:MM. Some models write a full JST timestamp; any other offset is rejected rather than guessed. */
export function asTime(v: string | null): string | null {
  const m = v?.match(/^(?:\d{4}-\d{2}-\d{2}T)?(([01]\d|2[0-3]):[0-5]\d)(?::[0-5]\d)?(?:\+09:00)?$/);
  return m ? m[1] : null;
}

function confident<T>(f: { value: T | null; confidence: number }): T | null {
  return f.value !== null && f.confidence >= MIN_CONFIDENCE ? f.value : null;
}

export function parcelTitle(items: Extraction["items"], fallback: string | null): string | null {
  if (items.length === 0) return fallback;
  const first = items[0].name;
  return items.length > 1 ? `${first} 他${items.length - 1}点` : first;
}

/** Fields to write for a brand-new parcel from one extraction. */
export function buildParcelInsert(userId: string, x: Extraction, emailSentAt: string | null): ParcelInsert {
  const tracking = confident(x.tracking_number);
  const carrierHint = x.carrier.value;
  const carrier = tracking || carrierHint ? identifyCarrier(tracking, carrierHint) : null;
  const status = relevanceToStatus(x.relevance) ?? "unknown";
  return {
    user_id: userId,
    shop: x.shop_name ?? (carrier?.name ?? "不明な店"),
    shop_key: x.shop_key ?? "other",
    order_number: confident(x.order_number),
    title: parcelTitle(x.items, null),
    status,
    ordered_at: x.relevance === "order" ? (asDate(confident(x.ordered_at)) ?? jstDate(emailSentAt)) : asDate(confident(x.ordered_at)),
    expected_date: asDate(confident(x.expected_date)),
    expected_window_start: asTime(confident(x.expected_window_start)),
    expected_window_end: asTime(confident(x.expected_window_end)),
    expected_text: x.expected_text,
    carrier: carrier && carrier.key !== "unknown" ? carrier.name : carrierHint,
    tracking_number: tracking ? normalizeTracking(tracking) : null,
    tracking_url: trackingUrlFor(tracking, carrierHint),
    requires_presence: confident(x.requires_presence),
    presence_evidence: x.requires_presence.evidence,
    total_amount: confident(x.total_amount),
    needs_review: x.overall_confidence < MIN_CONFIDENCE,
    last_email_at: emailSentAt,
  };
}

/**
 * Merge a new extraction into an existing parcel. Later mails win for delivery
 * details; status never goes backwards except to `cancelled`.
 */
export function buildParcelUpdate(existing: ParcelRow, x: Extraction, emailSentAt: string | null): ParcelUpdate {
  const update: ParcelUpdate = {};
  const incomingStatus = relevanceToStatus(x.relevance);
  const isNewer = !existing.last_email_at || !emailSentAt || emailSentAt >= existing.last_email_at;

  if (incomingStatus) {
    const cur = STATUS_RANK[existing.status] ?? 0;
    const inc = STATUS_RANK[incomingStatus] ?? 0;
    if (incomingStatus === "cancelled" || inc > cur || (inc === cur && isNewer)) update.status = incomingStatus;
  }

  const orderNumber = confident(x.order_number);
  if (orderNumber && !existing.order_number) update.order_number = orderNumber;

  const tracking = confident(x.tracking_number);
  if (tracking && (!existing.tracking_number || isNewer)) {
    update.tracking_number = normalizeTracking(tracking);
    const info = identifyCarrier(tracking, x.carrier.value ?? existing.carrier);
    update.carrier = info.key !== "unknown" ? info.name : (x.carrier.value ?? existing.carrier);
    update.tracking_url = trackingUrlFor(tracking, x.carrier.value ?? existing.carrier);
  } else if (x.carrier.value && !existing.carrier) {
    update.carrier = x.carrier.value;
  }

  const expectedDate = asDate(confident(x.expected_date));
  if (expectedDate && isNewer) {
    update.expected_date = expectedDate;
    update.expected_window_start = asTime(confident(x.expected_window_start));
    update.expected_window_end = asTime(confident(x.expected_window_end));
    update.expected_text = x.expected_text;
  }

  const presence = confident(x.requires_presence);
  if (presence !== null && (existing.requires_presence === null || isNewer)) {
    update.requires_presence = presence;
    update.presence_evidence = x.requires_presence.evidence;
  }

  const total = confident(x.total_amount);
  if (total !== null && (existing.total_amount === null || x.relevance === "order")) update.total_amount = total;

  const orderedAt = asDate(confident(x.ordered_at));
  if (orderedAt && !existing.ordered_at) update.ordered_at = orderedAt;

  if (!existing.title && x.items.length > 0) update.title = parcelTitle(x.items, null);
  if (x.shop_name && (existing.shop === "不明な店" || /運輸|急便|郵便/.test(existing.shop)) && !/運輸|急便|郵便/.test(x.shop_name)) {
    update.shop = x.shop_name;
    if (x.shop_key) update.shop_key = x.shop_key;
  }

  if (emailSentAt && (!existing.last_email_at || emailSentAt > existing.last_email_at)) update.last_email_at = emailSentAt;
  if (x.overall_confidence < MIN_CONFIDENCE) update.needs_review = true;

  return update;
}
