import { describe, expect, it } from "vitest";
import { identifyCarrier, normalizeTracking, trackingLinkFor } from "@/lib/carriers";
import { ManualParcelSchema, manualParcelRow } from "@/lib/manual-parcel";
import { buildParcelInsert, buildParcelUpdate, chooseParcel, mergeIntoManual, normalizeOrderNumber, type ParcelCandidate, type ParcelRow } from "@/lib/match";
import { processInboundEmail } from "@/lib/pipeline";
import { FakeDb } from "./fake-db";
import { USER, asAdmin, item, mailOf, precomputed, reading, sure } from "./pipeline-fixtures";

/**
 * Review D1-1: full-width digits (Japanese mail templates, numbers typed or pasted with Japanese
 * input) were dropped from tracking numbers and kept as they were in order numbers. The shop's
 * mail and the carrier's mail then made two parcels, and the amount was counted twice.
 */

const FW_TRACKING = "１２３４５６７８９０１２"; // 123456789012 in full-width digits
const FW_TRACKING_DASHED = "１２３４－５６７８－９０１２";
const FW_TRACKING_CHOON = "１２３４ー５６７８ー９０１２"; // the long-vowel mark, often typed for a dash

describe("a tracking number in full-width digits", () => {
  it("is read as its half-width number", () => {
    for (const n of [FW_TRACKING, FW_TRACKING_DASHED, FW_TRACKING_CHOON, "1234-５６７８-9012", "１２３４　５６７８　９０１２"]) {
      expect(normalizeTracking(n), n).toBe("123456789012");
    }
    expect(identifyCarrier("ＴＢＡ１２３４５６７８９０１").key).toBe("amazon");
    expect(trackingLinkFor(FW_TRACKING_DASHED, "ヤマト運輸")).toEqual(trackingLinkFor("1234-5678-9012", "ヤマト運輸"));
  });

  it("is stored half-width, with its carrier and link", () => {
    const row = buildParcelInsert(USER, reading({ tracking_number: sure(FW_TRACKING), carrier: sure("ヤマト運輸") }), "2026-11-03T01:00:00Z");
    expect(row.tracking_number).toBe("123456789012");
    expect(row.carrier).toBe("ヤマト運輸");
    expect(row.tracking_url).toBe("https://toi.kuronekoyamato.co.jp/cgi-bin/tneko");
  });

  it("with no letter or digit left is not stored at all, never as an empty string", () => {
    const row = buildParcelInsert(USER, reading({ tracking_number: sure("ー－ー") }), "2026-11-03T01:00:00Z");
    expect(row.tracking_number).toBeNull();
    expect(row.tracking_url).toBeNull();
    // Nor does it replace a number already stored.
    const stored = { ...row, tracking_number: "123456789012", carrier: "ヤマト運輸", last_email_at: "2026-11-02T00:00:00Z", status: "shipped" } as unknown as ParcelRow;
    expect(buildParcelUpdate(stored, reading({ tracking_number: sure("－－") }), "2026-11-04T00:00:00Z")).not.toHaveProperty("tracking_number");
    const typed = { ...stored, tracking_number: null, carrier: null, source: "manual" } as unknown as ParcelRow;
    expect(mergeIntoManual(typed, reading({ tracking_number: sure("－－") }), "2026-11-04T00:00:00Z")).not.toHaveProperty("tracking_number");
  });

  it.each([
    ["the shop mail first", false],
    ["the carrier mail first", true],
  ])("joins the carrier's half-width mail into one parcel (%s)", async (_name, carrierFirst) => {
    const db = new FakeDb();
    const shop = reading({ relevance: "shipped", shop_name: "小さな店", order_number: sure("A-20261103-77"), tracking_number: sure(FW_TRACKING), total_amount: sure(3300) });
    const carrier = reading({ relevance: "out_for_delivery", shop_name: null, carrier: sure("ヤマト運輸"), tracking_number: sure("1234-5678-9012"), expected_date: sure("2026-11-04") });
    const mails = [
      { x: shop, mail: { ...mailOf("2026-11-03T01:00:00Z"), messageId: "<shop@test>" } },
      { x: carrier, mail: { ...mailOf("2026-11-04T00:30:00Z"), messageId: "<carrier@test>" } },
    ];
    for (const m of carrierFirst ? [...mails].reverse() : mails) await processInboundEmail(asAdmin(db), m.mail, { precomputed: precomputed(m.x) });
    const parcels = db.rows("parcels").filter((r) => r.user_id === USER);
    expect(parcels).toHaveLength(1);
    expect(parcels[0]).toMatchObject({ tracking_number: "123456789012", order_number: "A-20261103-77", status: "out_for_delivery", expected_date: "2026-11-04", total_amount: 3300 });
  });
});

describe("an order number in full-width characters", () => {
  const existing = (order_number: string) =>
    ({ id: "p1", user_id: USER, shop: "小さな店", shop_key: "other", order_number, tracking_number: null, status: "ordered", created_at: "2026-11-01T00:00:00Z", source: "mail", itemNames: [] }) as unknown as ParcelCandidate;

  it("is the same order as its half-width form, whichever dash it is written with", () => {
    for (const n of ["ＡＢ－１２３４５６７８", "ＡＢー１２３４５６７８", "AB−12345678", "ａｂ　１２３４５６７８", "AB-12345678"]) expect(normalizeOrderNumber(n), n).toBe("AB12345678");
  });

  it("finds the parcel of the same order, full-width against half-width and against full-width", () => {
    const fw = reading({ relevance: "shipped", shop_name: "小さな店", order_number: sure("ＡＢ－１２３４５６７８") });
    expect(chooseParcel([existing("AB-12345678")], fw)?.id).toBe("p1");
    expect(chooseParcel([existing("ＡＢー１２３４５６７８")], fw)?.id).toBe("p1");
    expect(chooseParcel([existing("ＡＢ－１２３４５６７８")], reading({ relevance: "shipped", shop_name: "小さな店", order_number: sure("AB-12345678") }))?.id).toBe("p1");
    // A different order stays apart.
    expect(chooseParcel([existing("ＡＢ－１２３４５６７９")], fw)).toBeNull();
  });

  it("joins the half-width shipment mail into the order's parcel, so the amount counts once", async () => {
    const db = new FakeDb();
    const order = reading({ relevance: "order", shop_name: "小さな店", order_number: sure("ＡＢ－１２３４５６７８"), items: [item("品物", 3300)], total_amount: sure(3300) });
    const shipped = reading({ relevance: "shipped", shop_name: "小さな店", order_number: sure("AB-12345678"), carrier: sure("ヤマト運輸"), tracking_number: sure("6203-9184-5571"), total_amount: sure(3300) });
    await processInboundEmail(asAdmin(db), { ...mailOf("2026-11-01T01:00:00Z"), messageId: "<order@test>" }, { precomputed: precomputed(order) });
    await processInboundEmail(asAdmin(db), { ...mailOf("2026-11-02T01:00:00Z"), messageId: "<shipped@test>" }, { precomputed: precomputed(shipped) });
    const parcels = db.rows("parcels").filter((r) => r.user_id === USER);
    expect(parcels).toHaveLength(1);
    expect(parcels[0]).toMatchObject({ status: "shipped", tracking_number: "620391845571", total_amount: 3300 });
  });
});

describe("a tracking number typed in full-width on the hand-entry form", () => {
  const base = { title: "品名", shop: "店", ordered_at: "", expected_date: "", total_amount: "", category: "", carrier: "auto", presence: "", status: "ordered" };

  it.each([FW_TRACKING, FW_TRACKING_DASHED, FW_TRACKING_CHOON])("is saved as the half-width number: %s", (typed) => {
    const parsed = ManualParcelSchema.safeParse({ ...base, tracking_number: typed });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.tracking_number).toBe("123456789012");
    expect(manualParcelRow(parsed.data, new Date("2026-11-06T00:00:00Z")).tracking_number).toBe("123456789012");
  });

  it("is saved as no number when nothing but dashes is typed", () => {
    const parsed = ManualParcelSchema.safeParse({ ...base, tracking_number: "ーーー" });
    expect(parsed.success && parsed.data.tracking_number).toBeNull();
  });
});
