import { describe, expect, it } from "vitest";
import { buildParcelInsert, buildParcelUpdate, chooseParcel, mergeIntoManual, rebuildParcel, twinsByTracking, type ParcelCandidate, type ParcelRow } from "@/lib/match";
import { item, reading, sure } from "./pipeline-fixtures";

/**
 * Matching with categories and parcels typed in by hand (src/lib/match):
 * - chooseParcel: a parcel with source "manual" is matched only by tracking or order number.
 *   A candidate with no source (fixtures, replay) counts as a mail parcel.
 * - mergeIntoManual(existing, x, sentAt) -> update: fills only empty fields, moves status forward
 *   only, updates last_email_at, applies the category rule, never changes what the user typed.
 *   Exported from "@/lib/match" (it may live in src/lib/match/manual.ts and be re-exported).
 * - twinsByTracking: a parcel typed in by hand is always the one kept; two typed-in parcels are
 *   never folded into each other.
 * - buildParcelInsert / buildParcelUpdate / rebuildParcel decide the category with the rule in
 *   src/lib/match/category.ts.
 */

const NOW = new Date("2026-11-03T03:00:00Z");
const TRACKING = "123456789012";
const LONG_ORDER = "ORD-55556666";

type Row = ParcelRow & { source?: string; category?: string | null; category_source?: string | null };
type Over = Partial<Row> & { itemNames?: string[] };

function candidate(over: Over): ParcelCandidate {
  return {
    id: "c1",
    user_id: "u",
    shop: "テスト店",
    shop_key: "other",
    status: "ordered",
    title: null,
    order_number: null,
    tracking_number: null,
    carrier: null,
    tracking_url: null,
    expected_date: null,
    expected_date_end: null,
    expected_text: null,
    expected_window_start: null,
    expected_window_end: null,
    ordered_at: null,
    requires_presence: null,
    presence_evidence: null,
    total_amount: null,
    needs_review: false,
    last_email_at: "2026-11-01T00:00:00Z",
    created_at: "2026-11-01T00:00:00Z",
    updated_at: "2026-11-01T00:00:00Z",
    category: null,
    category_source: null,
    source: "mail",
    itemNames: [],
    ...over,
  } as ParcelCandidate;
}

const manual = (over: Over = {}) =>
  candidate({
    id: "manual",
    source: "manual",
    shop: "手入力の店",
    title: "手入力の品名",
    total_amount: 5000,
    category: "hobby",
    category_source: "user",
    ordered_at: "2026-11-01",
    ...over,
  });

describe("chooseParcel with parcels typed in by hand", () => {
  it("matches a typed-in parcel by tracking number", () => {
    const m = manual({ tracking_number: TRACKING });
    const x = reading({ relevance: "shipped", tracking_number: sure("1234-5678-9012") });
    expect(chooseParcel([m], x, NOW)?.id).toBe("manual");
  });

  it("matches a typed-in parcel by order number", () => {
    const m = manual({ order_number: LONG_ORDER });
    const x = reading({ relevance: "shipped", order_number: sure(LONG_ORDER), shop_name: "別の表記の店" });
    expect(chooseParcel([m], x, NOW)?.id).toBe("manual");
  });

  it("does not match a typed-in parcel on the same item from the same shop alone", () => {
    const name = "ワイヤレスイヤホン ノイズキャンセリング ブラック";
    const x = reading({ relevance: "shipped", shop_name: "テスト店", items: [item(name)] });
    const asMail = candidate({ id: "mail", shop: "テスト店", itemNames: [name], created_at: "2026-11-02T00:00:00Z" });
    // Control: the same parcel built from mails is matched on the item.
    expect(chooseParcel([asMail], x, NOW)?.id).toBe("mail");
    const typed = manual({ shop: "テスト店", itemNames: [name], created_at: "2026-11-02T00:00:00Z" });
    expect(chooseParcel([typed], x, NOW)).toBeNull();
  });

  it("does not match a typed-in parcel on the same known shop and day alone", () => {
    const x = reading({ relevance: "shipped", shop_name: "Amazon", shop_key: "amazon", tracking_number: sure("TBA999999999999"), expected_date: sure("2026-11-05") });
    const asMail = candidate({ id: "mail", shop: "Amazon", shop_key: "amazon", order_number: "503-0000000-0000001", expected_date: "2026-11-05" });
    // Control: a mail parcel with only an order number is matched on shop and day.
    expect(chooseParcel([asMail], x, NOW)?.id).toBe("mail");
    const typed = manual({ shop: "Amazon", shop_key: "amazon", order_number: "503-0000000-0000001", expected_date: "2026-11-05" });
    expect(chooseParcel([typed], x, NOW)).toBeNull();
  });

  it("treats a candidate with no source as a mail parcel", () => {
    const name = "ワイヤレスイヤホン ノイズキャンセリング ブラック";
    const x = reading({ relevance: "shipped", shop_name: "テスト店", items: [item(name)] });
    const legacy = candidate({ id: "legacy", itemNames: [name], created_at: "2026-11-02T00:00:00Z" });
    delete (legacy as Partial<Row>).source;
    expect(chooseParcel([legacy], x, NOW)?.id).toBe("legacy");
  });
});

describe("mergeIntoManual", () => {
  const sentAt = "2026-11-03T01:00:00Z";
  const mail = reading({
    relevance: "shipped",
    shop_name: "メールの店",
    order_number: sure(LONG_ORDER),
    tracking_number: sure("1234-5678-9012"),
    carrier: sure("ヤマト運輸"),
    items: [item("メールの品名", 9999)],
    total_amount: sure(9999),
    expected_date: sure("2026-11-05"),
    requires_presence: sure(true),
    category: "food",
  });

  it("keeps what the user typed: name, shop, amount, category, source", () => {
    const u = mergeIntoManual(manual({ tracking_number: TRACKING }), mail, sentAt) as Record<string, unknown>;
    for (const key of ["title", "shop", "shop_key", "total_amount", "category", "category_source", "ordered_at"]) expect(u, key).not.toHaveProperty(key);
    if ("source" in u) expect(u.source).toBe("manual");
  });

  it("fills only empty fields from the mail", () => {
    const u = mergeIntoManual(manual({ tracking_number: TRACKING }), mail, sentAt);
    expect(u.expected_date).toBe("2026-11-05");
    expect(u.order_number).toBe(LONG_ORDER);
    expect(u.requires_presence).toBe(true);
    expect(u.last_email_at).toBe(sentAt);
  });

  it("does not replace a date, a number or a choice the user already gave", () => {
    const u = mergeIntoManual(manual({ tracking_number: "999988887777", expected_date: "2026-11-10", requires_presence: false, order_number: "MY-ORDER-1" }), mail, sentAt) as Record<string, unknown>;
    expect(u).not.toHaveProperty("expected_date");
    expect(u).not.toHaveProperty("tracking_number");
    expect(u).not.toHaveProperty("requires_presence");
    expect(u).not.toHaveProperty("order_number");
  });

  it("fills an empty tracking number, normalized, with its carrier", () => {
    const u = mergeIntoManual(manual({ order_number: LONG_ORDER }), mail, sentAt);
    expect(u.tracking_number).toBe(TRACKING);
    expect(u.carrier).toBe("ヤマト運輸");
  });

  it("moves the status forward only", () => {
    expect(mergeIntoManual(manual({ status: "ordered" }), mail, sentAt).status).toBe("shipped");
    expect(mergeIntoManual(manual({ status: "delivered" }), mail, sentAt)).not.toHaveProperty("status");
  });

  it("gives an uncategorised typed-in parcel the mail's category as auto", () => {
    const u = mergeIntoManual(manual({ category: null, category_source: null }), mail, sentAt) as Record<string, unknown>;
    expect(u.category).toBe("food");
    expect(u.category_source).toBe("auto");
  });
});

describe("twinsByTracking with parcels typed in by hand", () => {
  const twin = (id: string, over: Record<string, unknown>) => ({ id, tracking_number: TRACKING, order_number: null, created_at: "2026-11-01T00:00:00Z", source: "mail", ...over });

  it("always keeps the typed-in parcel, even against one with an order number", () => {
    const parcels = [twin("mail-order", { order_number: LONG_ORDER, created_at: "2026-10-30T00:00:00Z" }), twin("typed", { source: "manual", created_at: "2026-11-02T00:00:00Z" })];
    const t = twinsByTracking(parcels, "mail-order");
    expect(t?.keep.id).toBe("typed");
    expect(t?.absorb.map((p) => p.id)).toEqual(["mail-order"]);
  });

  it("never folds one typed-in parcel into another", () => {
    const parcels = [twin("typed-1", { source: "manual" }), twin("typed-2", { source: "manual", created_at: "2026-11-02T00:00:00Z" }), twin("carrier", {})];
    const t = twinsByTracking(parcels, "carrier");
    expect(t).not.toBeNull();
    expect(["typed-1", "typed-2"]).toContain(t!.keep.id);
    expect(t!.absorb.map((p) => p.id)).toEqual(["carrier"]);
  });

  it("keeps the old choice when no parcel was typed in", () => {
    const parcels = [twin("carrier", { created_at: "2026-10-30T00:00:00Z" }), twin("shop", { order_number: LONG_ORDER })];
    expect(twinsByTracking(parcels, "carrier")?.keep.id).toBe("shop");
  });
});

describe("category in the parcel rules", () => {
  const sentAt = "2026-11-03T01:00:00Z";

  it("buildParcelInsert writes the reading's category as auto, or neither", () => {
    const withCat = buildParcelInsert("u", reading({ category: "electronics" }), sentAt) as Record<string, unknown>;
    expect(withCat.category).toBe("electronics");
    expect(withCat.category_source).toBe("auto");
    const without = buildParcelInsert("u", reading({ category: null }), sentAt) as Record<string, unknown>;
    expect(without.category ?? null).toBeNull();
    expect(without.category_source ?? null).toBeNull();
  });

  it("buildParcelUpdate never touches the user's category", () => {
    const u = buildParcelUpdate(candidate({ category: "beauty", category_source: "user" }), reading({ items: [item("新しい品名")], category: "food" }), sentAt) as Record<string, unknown>;
    expect(u).not.toHaveProperty("category");
    expect(u).not.toHaveProperty("category_source");
  });

  it("buildParcelUpdate gives the shop's category when the carrier notice came first", () => {
    const carrier = buildParcelInsert("u", reading({ shop_name: null, tracking_number: sure(TRACKING), category: null }), "2026-11-02T00:00:00Z");
    const row = candidate({ ...(carrier as Partial<Row>), itemNames: [] });
    const u = buildParcelUpdate(row, reading({ relevance: "shipped", items: [item("シャツ ホワイト")], category: "fashion" }), sentAt) as Record<string, unknown>;
    expect(u.category).toBe("fashion");
    expect(u.category_source).toBe("auto");
  });

  it("buildParcelUpdate replaces an auto category when the mail is the first with item names", () => {
    const row = candidate({ title: "衣料品", itemNames: [], category: "other", category_source: "auto" });
    const u = buildParcelUpdate(row, reading({ items: [item("スマートウォッチ")], category: "electronics" }), sentAt) as Record<string, unknown>;
    expect(u.category).toBe("electronics");
  });

  it("buildParcelUpdate keeps an auto category once items are known", () => {
    const row = candidate({ title: "お米 5kg", itemNames: ["お米 5kg"], category: "food", category_source: "auto" });
    const u = buildParcelUpdate(row, reading({ items: [item("お米 5kg")], category: "daily" }), sentAt) as Record<string, unknown>;
    expect(u).not.toHaveProperty("category");
  });

  it("rebuildParcel ends with the shop's category when the carrier mail is older", () => {
    const fields = rebuildParcel("u", [
      { x: reading({ shop_name: null, tracking_number: sure(TRACKING), category: null }), sentAt: "2026-11-01T00:00:00Z" },
      { x: reading({ relevance: "shipped", tracking_number: sure(TRACKING), items: [item("ランニングシューズ")], category: "fashion" }), sentAt: "2026-11-02T00:00:00Z" },
      { x: reading({ relevance: "delivered", tracking_number: sure(TRACKING), shop_name: null, category: null }), sentAt: "2026-11-03T00:00:00Z" },
    ]) as Record<string, unknown>;
    expect(fields.category).toBe("fashion");
    expect(fields.category_source).toBe("auto");
  });
});
