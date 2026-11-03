import type { Database } from "@/lib/db/database.types";
import type { Extraction, OtherOrder, Relevance } from "@/lib/extract/schema";
import { identifyCarrier, normalizeTracking, trackingUrlFor } from "@/lib/carriers";
import { addDays, todayJst } from "@/lib/format";

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

/** A payment notice that already names a tracking number means the parcel has left the shop. */
function statusOf(x: Extraction): string | null {
  return x.relevance === "payment" && confident(x.tracking_number) ? "shipped" : relevanceToStatus(x.relevance);
}

export function isParcelRelevant(r: Relevance): boolean {
  return r !== "unrelated";
}

/** Normalize an order number for matching: drop spaces/dashes, uppercase. */
export function normalizeOrderNumber(raw: string): string {
  return raw.replace(/[\s\-‐–—]/g, "").toUpperCase();
}

const MIN_CONFIDENCE = 0.6;

/** Mails close enough to the purchase for their date to stand in for the order date. */
const DATES_THE_PURCHASE: Relevance[] = ["order", "payment", "shipped"];

/** A value of the wrong shape is treated as unread, so one odd value cannot fail the whole mail. */
function asDate(v: string | null): string | null {
  if (!v || !/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(v)) return null;
  // Rejects 2026-02-31, which the pattern allows and the date column does not.
  return new Date(`${v}T00:00:00Z`).toISOString().startsWith(v) ? v : null;
}
/** A clock time as HH:MM. Some models write a full JST timestamp; any other offset is rejected rather than guessed. */
export function asTime(v: string | null): string | null {
  const m = v?.match(/^(?:\d{4}-\d{2}-\d{2}[T ])?(([01]\d|2[0-3]):[0-5]\d)(?::[0-5]\d)?(?:\+09:00)?$/);
  return m ? m[1] : null;
}

function confident<T>(f: { value: T | null; confidence: number }): T | null {
  return f.value !== null && f.confidence >= MIN_CONFIDENCE ? f.value : null;
}

/** Shown when no mail names who sent the parcel. */
export const UNKNOWN_SENDER = "送り主不明";
const CARRIER_NAME = /運輸|急便|郵便|ゆうパック|ゆうパケット|ヤマト|佐川|西濃|福山通運|配送センター/;

/** Older parcels may carry one of these until a mail names the real shop. */
function isPlaceholderShop(shop: string): boolean {
  return shop === UNKNOWN_SENDER || shop === "不明な店" || CARRIER_NAME.test(shop);
}

/**
 * The seller, or null. A carrier name or the addressee ("〇〇様") is not a seller,
 * and the model sometimes offers one when the mail names no sender.
 */
export function shopNameOf(x: Pick<Extraction, "shop_name">): string | null {
  const name = x.shop_name?.trim();
  if (!name || CARRIER_NAME.test(name) || /様$/.test(name)) return null;
  return name;
}

/**
 * The slip category (衣料品), or null. Some shops print an order code in the slip's item field,
 * and a string of digits tells the user nothing about the parcel.
 */
export function slipCategoryOf(x: Pick<Extraction, "package_description">): string | null {
  const v = confident(x.package_description)?.trim();
  if (!v) return null;
  const digits = (v.match(/\d/g) ?? []).length;
  const words = v.replace(/[\d\s\-‐–—ー_/.,#:：()（）]/g, "").replace(/^No/i, "").length;
  return words > 0 && digits <= words ? v : null;
}

/** The last day of a promised window, when the mail gives one that makes sense. */
function windowEnd(x: Pick<Extraction, "expected_date_end">, start: string | null): string | null {
  const end = asDate(confident(x.expected_date_end));
  return start && end && end > start ? end : null;
}

export function parcelTitle(items: Extraction["items"], fallback: string | null): string | null {
  if (items.length === 0) return fallback;
  const first = items[0].name;
  return items.length > 1 ? `${first} 他${items.length - 1}点` : first;
}

/** A carrier notice alone is no order of ours: the shipment needs an order number or a price to count. */
function orderDate(x: Extraction, emailSentAt: string | null): string | null {
  const stated = asDate(confident(x.ordered_at));
  if (stated) return stated;
  if (!DATES_THE_PURCHASE.includes(x.relevance)) return null;
  if (x.relevance === "shipped" && confident(x.order_number) === null && confident(x.total_amount) === null) return null;
  return jstDate(emailSentAt);
}

/** Fields to write for a brand-new parcel from one extraction. */
export function buildParcelInsert(userId: string, x: Extraction, emailSentAt: string | null): ParcelInsert {
  const tracking = confident(x.tracking_number);
  const carrierHint = x.carrier.value;
  const carrier = tracking || carrierHint ? identifyCarrier(tracking, carrierHint) : null;
  const status = statusOf(x) ?? "unknown";
  return {
    user_id: userId,
    shop: shopNameOf(x) ?? UNKNOWN_SENDER,
    shop_key: x.shop_key ?? "other",
    order_number: confident(x.order_number),
    // A carrier slip names only a category (衣料品): better than nothing until the shop mail arrives.
    title: parcelTitle(x.items, slipCategoryOf(x)),
    status,
    // A shop that sends no order mail still spent money: fall back to the first mail we saw.
    ordered_at: orderDate(x, emailSentAt),
    expected_date: asDate(confident(x.expected_date)),
    expected_date_end: windowEnd(x, asDate(confident(x.expected_date))),
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
export function buildParcelUpdate(existing: ParcelRow & { itemNames?: string[] }, x: Extraction, emailSentAt: string | null): ParcelUpdate {
  const update: ParcelUpdate = {};
  const incomingStatus = statusOf(x);
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
    update.expected_date_end = windowEnd(x, expectedDate);
    update.expected_window_start = asTime(confident(x.expected_window_start));
    update.expected_window_end = asTime(confident(x.expected_window_end));
    update.expected_text = x.expected_text;
  }

  const presence = confident(x.requires_presence);
  if (presence !== null && (existing.requires_presence === null || isNewer)) {
    update.requires_presence = presence;
    update.presence_evidence = x.requires_presence.evidence;
  }

  const orderedAt = orderDate(x, emailSentAt);
  if (orderedAt && !existing.ordered_at) update.ordered_at = orderedAt;

  // Real item names replace a slip category; a parcel that already has item rows keeps its title.
  const hasItems = existing.itemNames ? existing.itemNames.length > 0 : existing.title !== null;
  if (x.items.length > 0 && !hasItems) update.title = parcelTitle(x.items, null);
  else if (!existing.title && slipCategoryOf(x)) update.title = slipCategoryOf(x);
  // The first mail with an order number names the seller; a carrier slip may have named a warehouse.
  const shop = shopNameOf(x);
  if (shop && (isPlaceholderShop(existing.shop) || (!existing.order_number && orderNumber !== null))) {
    update.shop = shop;
    if (x.shop_key) update.shop_key = x.shop_key;
  }

  if (emailSentAt && (!existing.last_email_at || emailSentAt > existing.last_email_at)) update.last_email_at = emailSentAt;
  if (x.overall_confidence < MIN_CONFIDENCE) update.needs_review = true;

  return update;
}

export type ParcelCandidate = ParcelRow & { itemNames: string[] };

const MIN_ITEM_MATCH = 8;
const UNIQUE_ORDER_LENGTH = 8;

/** "other" covers every small shop, so there the names have to agree as well. */
function sameShop(p: ParcelRow, x: Extraction): boolean {
  const key = x.shop_key ?? "other";
  if (p.shop_key !== key) return false;
  return key !== "other" || p.shop === (shopNameOf(x) ?? p.shop);
}

/**
 * Which existing parcel a mail belongs to, or null for a new one. Tries the order number,
 * then the tracking number, then two softer signals.
 */
export function chooseParcel(candidates: ParcelCandidate[], x: Extraction, now: Date = new Date()): ParcelCandidate | null {
  const newestFirst = [...candidates].sort((a, b) => b.created_at.localeCompare(a.created_at));
  const statedOrder = confident(x.order_number);
  const orderNumber = statedOrder ? normalizeOrderNumber(statedOrder) : null;
  if (orderNumber) {
    // Small shops number orders from 1001, so the same number at another shop is another order.
    // A long number is unique on its own, and marketplaces sign one order under two shop names.
    const hit = newestFirst.find(
      (p) => p.order_number && normalizeOrderNumber(p.order_number) === orderNumber && (orderNumber.length >= UNIQUE_ORDER_LENGTH || sameShop(p, x)),
    );
    if (hit) return hit;
  }
  const statedTracking = confident(x.tracking_number);
  const tracking = statedTracking ? normalizeTracking(statedTracking) : null;
  if (tracking) {
    const hit = newestFirst.find((p) => p.tracking_number === tracking);
    if (hit) return hit;
  }

  const shopKey = x.shop_key ?? "other";

  // A shop mail with only an order number and a carrier mail with only a tracking number
  // describe one parcel when they name the same known shop and the same day.
  const expected = asDate(confident(x.expected_date));
  if (expected && shopKey !== "other" && (orderNumber || tracking) && !(orderNumber && tracking)) {
    const hit = newestFirst.find(
      (p) =>
        p.shop_key === shopKey &&
        p.expected_date === expected &&
        p.status !== "cancelled" &&
        (tracking ? p.order_number !== null && p.tracking_number === null : p.tracking_number !== null && p.order_number === null),
    );
    if (hit) return hit;
  }

  // Same item from the same shop recently. Subscription notices are left out: their item
  // repeats every delivery, so the match would land on an older, unrelated parcel.
  if (x.items.length > 0 && x.relevance !== "order" && x.relevance !== "other_purchase") {
    const since = new Date(now.getTime() - 30 * 86_400_000).toISOString();
    const first = x.items[0].name.replace(/\.{3}|…/g, "").trim();
    const recent = newestFirst.filter(
      (p) =>
        sameShop(p, x) &&
        p.created_at >= since &&
        p.status !== "delivered" &&
        // A different order or tracking number is a different parcel, however alike the item.
        !(orderNumber && p.order_number && normalizeOrderNumber(p.order_number) !== orderNumber) &&
        !(tracking && p.tracking_number && p.tracking_number !== tracking),
    );
    const hit = recent.slice(0, 20).find((p) =>
      p.itemNames.some((raw) => {
        const name = raw.replace(/\.{3}|…/g, "").trim();
        // Short names like 「Tシャツ」 say too little to call two mails one parcel.
        return Math.min(name.length, first.length) >= MIN_ITEM_MATCH && (name.startsWith(first) || first.startsWith(name));
      }),
    );
    if (hit) return hit;
  }
  return null;
}

/** Subscription and account notices describe no parcel unless they carry a tracking number. */
export function startsParcel(x: Extraction): boolean {
  return x.relevance !== "other_purchase" || confident(x.tracking_number) !== null;
}

const SHIPMENT_MAILS: Relevance[] = ["shipped", "out_for_delivery", "attempted", "delivered"];
const ORDER_MAILS: Relevance[] = ["order", "payment"];
/** The schema asks for 0.9 or more when the mail states a value outright. */
const STATED_OUTRIGHT = 0.9;

/**
 * What a parcel cost, from every mail read for it. Shipment mails state the amount of their
 * own order number, so they win. Order mails are weaker: Amazon lists several order numbers
 * in one mail, and its total or item list can cover more or less than this parcel.
 */
export function parcelTotal(mails: Extraction[]): number | null {
  const orderMails = mails.filter((m) => ORDER_MAILS.includes(m.relevance));
  const stated = orderMails.map((m) => m.total_amount).filter((f) => f.value && f.confidence >= MIN_CONFIDENCE);
  const firm = stated.filter((f) => f.confidence >= STATED_OUTRIGHT).at(-1)?.value ?? null;
  const weak = stated.at(-1)?.value ?? 0;

  const listed = orderMails.find((m) => m.items.length > 0)?.items ?? [];
  const itemSum = listed.length > 0 && listed.every((i) => i.unit_price !== null) ? listed.reduce((sum, i) => sum + (i.unit_price ?? 0) * (i.quantity ?? 1), 0) : 0;

  // A set: the same mail may be delivered twice, while parts of one order state different amounts.
  const shipments = new Set<number>();
  for (const m of mails) {
    const total = m.total_amount;
    if (SHIPMENT_MAILS.includes(m.relevance) && total.value && total.confidence >= MIN_CONFIDENCE) shipments.add(total.value);
  }
  const shipped = [...shipments].reduce((a, b) => a + b, 0);

  const total = shipped > 0 ? Math.max(shipped, firm ?? 0) : (firm ?? Math.max(weak, itemSum));
  return total > 0 ? total : null;
}

/** How long past its date a parcel waits before the user is asked whether it came. */
export const CHECK_AFTER_DAYS = 14;

type DatedParcel = Pick<ParcelRow, "status" | "expected_date" | "expected_date_end" | "last_email_at">;

/** The last day a parcel may still arrive on time: the end of a window, or the one date. */
export function lastExpectedDay(p: Pick<ParcelRow, "expected_date" | "expected_date_end">): string | null {
  return p.expected_date_end ?? p.expected_date;
}

/**
 * Still open two weeks after it should have arrived (or, with no date, two weeks after its
 * last mail). Most shops send no delivery mail, so these are asked about rather than guessed.
 */
export function needsCheck(p: DatedParcel, today: string): boolean {
  if (p.status === "delivered" || p.status === "cancelled") return false;
  const cutoff = addDays(today, -CHECK_AFTER_DAYS);
  const lastDay = lastExpectedDay(p);
  if (lastDay) return lastDay <= cutoff;
  return p.last_email_at !== null && todayJst(new Date(p.last_email_at)) <= cutoff;
}

/**
 * Whether the parcel has to be handed over in person, as shown to the user. A mail that says
 * nothing about it counts as face-to-face (the owner's decision: being home is the safe guess),
 * except Amazon, which mostly leaves parcels at the door, so it stays unknown. The stored value
 * is never changed; this is worked out on display.
 */
export function faceToFace(p: Pick<ParcelRow, "requires_presence" | "shop_key">): boolean | null {
  return p.requires_presence ?? (p.shop_key === "amazon" ? null : true);
}

/** Past its date with no delivery mail yet, but not long enough to ask. */
export function isLate(p: DatedParcel, today: string): boolean {
  if (p.status === "delivered" || p.status === "cancelled") return false;
  const lastDay = lastExpectedDay(p);
  return lastDay !== null && lastDay < today;
}

const NO_VALUE = { value: null, evidence: null, confidence: 0 };

/**
 * One reading per order. A mail that lists several orders becomes several readings, each
 * with only its own items, total and delivery estimate, so no parcel mixes two orders.
 * The extra orders carry no tracking: shipment mails name one order each and add it later.
 */
export function splitOrders(x: Extraction): Extraction[] {
  const others = (x.other_orders ?? []).filter((o: OtherOrder) => confident(o.order_number) !== null);
  const first: Extraction = { ...x, other_orders: [] };
  return [
    first,
    ...others.map(
      (o: OtherOrder): Extraction => ({
        ...first,
        order_number: o.order_number,
        items: o.items,
        total_amount: o.total_amount,
        expected_date: o.expected_date,
        expected_date_end: o.expected_date_end,
        expected_text: o.expected_text,
        expected_window_start: { ...NO_VALUE },
        expected_window_end: { ...NO_VALUE },
        tracking_number: { ...NO_VALUE },
        package_description: { ...NO_VALUE },
      }),
    ),
  ];
}

/**
 * A parcel built again from all of its mails, oldest first, with the same rules as when
 * the mails arrived one by one. Used when two parcels turn out to be one.
 */
export function rebuildParcel(userId: string, mails: { x: Extraction; sentAt: string | null }[]): ParcelInsert {
  const ordered = [...mails].sort((a, b) => (a.sentAt ?? "").localeCompare(b.sentAt ?? ""));
  const [head, ...rest] = ordered;
  const row = { ...buildParcelInsert(userId, head.x, head.sentAt), itemNames: head.x.items.map((i) => i.name) } as unknown as ParcelRow & { itemNames: string[] };
  for (const m of rest) {
    Object.assign(row, buildParcelUpdate(row, m.x, m.sentAt));
    if (row.itemNames.length === 0) row.itemNames = m.x.items.map((i) => i.name);
  }
  const { itemNames: _names, ...fields } = row;
  void _names;
  fields.total_amount = parcelTotal(ordered.map((m) => m.x));
  return fields as ParcelInsert;
}

/**
 * Parcels that hold the same tracking number are one parcel. It happens when the carrier
 * mails before the shop does: the carrier mail opens a parcel of its own, then the shop
 * mail joins its order and brings the same number. The parcel with the order number stays.
 */
/** Carriers reuse tracking numbers after some months; twins are opened within days of each other. */
const TWIN_WINDOW_MS = 30 * 86_400_000;

export function twinsByTracking<T extends Pick<ParcelRow, "id" | "tracking_number" | "order_number" | "created_at">>(parcels: T[], keepId: string): { keep: T; absorb: T[] } | null {
  const target = parcels.find((p) => p.id === keepId);
  if (!target?.tracking_number) return null;
  const near = (p: T) => Math.abs(Date.parse(p.created_at) - Date.parse(target.created_at)) <= TWIN_WINDOW_MS;
  const same = parcels.filter((p) => p.tracking_number === target.tracking_number && near(p));
  if (same.length < 2) return null;
  const withOrder = same.filter((p) => p.order_number);
  // Two different orders under one number would be a shop reusing slips: leave them apart.
  if (new Set(withOrder.map((p) => normalizeOrderNumber(p.order_number!))).size > 1) return null;
  const keep = withOrder[0] ?? [...same].sort((a, b) => a.created_at.localeCompare(b.created_at))[0];
  return { keep, absorb: same.filter((p) => p.id !== keep.id) };
}
