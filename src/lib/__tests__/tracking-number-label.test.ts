import { describe, expect, it } from "vitest";
import { identifyCarrier, normalizeTracking, trackingLinkFor } from "@/lib/carriers";
import { ManualParcelSchema, manualParcelRow } from "@/lib/manual-parcel";
import { processInboundEmail } from "@/lib/pipeline";
import { FakeDb } from "./fake-db";
import { USER, asConsentingAdmin, mailOf, precomputed, reading, sure } from "./pipeline-fixtures";

/**
 * Review R2-3: normalizeTracking applied NFKC (8a07200), which spells the sign № as "No". So
 * "№123456789012" became "NO123456789012", no carrier's shape, and the carrier's page was sent
 * another number. Full-width "Ｎｏ．" did the same. Only full-width forms are folded now, and a
 * "No." or "No:" label before the number is dropped.
 */

const NUMBER = "123456789012";

describe("a sign or label written before a tracking number", () => {
  it.each([
    "№123456789012",
    "№ 1234-5678-9012",
    "No.1234-5678-9012",
    "NO.123456789012",
    "no.123456789012",
    "No:1234-5678-9012",
    "No：1234-5678-9012",
    "No . 1234 5678 9012",
    "Ｎｏ．１２３４－５６７８－９０１２",
    "ＮＯ．１２３４５６７８９０１２",
    "ｎｏ：１２３４５６７８９０１２",
    "伝票No.1234-5678-9012",
    "お問い合わせ番号：№1234-5678-9012",
  ])("is not part of the number: %s", (raw) => {
    expect(normalizeTracking(raw)).toBe(NUMBER);
  });

  it("is not part of the number when the number has letters either", () => {
    expect(normalizeTracking("No.EJ123456789JP")).toBe("EJ123456789JP");
    expect(normalizeTracking("Ｎｏ．ＥＪ１２３４５６７８９ＪＰ")).toBe("EJ123456789JP");
    expect(normalizeTracking("№TBA123456789012")).toBe("TBA123456789012");
  });

  it("a sign NFKC spells with letters or digits is dropped like any other mark", () => {
    // ① was read as "1": 1123456789012 is 13 digits, a Japan Post shape.
    expect(normalizeTracking("①1234-5678-9012")).toBe(NUMBER);
    expect(normalizeTracking("⑴1234-5678-9012")).toBe(NUMBER);
    expect(normalizeTracking("Ⅱ 1234-5678-9012")).toBe(NUMBER);
  });

  it("gives the carrier and the link of the number itself", () => {
    expect(identifyCarrier("№1234-5678-9012", "ヤマト運輸").key).toBe("yamato");
    expect(trackingLinkFor("№1234-5678-9012", "ヤマト運輸")).toEqual(trackingLinkFor("1234-5678-9012", "ヤマト運輸"));
    // 11 digits: Japan Post without a hint.
    expect(identifyCarrier("Ｎｏ．１２３４５６７８９０１").key).toBe("japanpost");
    expect(trackingLinkFor("No.12345678901", null)).toEqual(trackingLinkFor("12345678901", null));
  });
});

describe("numbers with letters stay as they are", () => {
  it.each([
    ["EJ123456789JP", "EJ123456789JP"],
    ["ej 123 456 789 jp", "EJ123456789JP"],
    ["ＥＪ１２３４５６７８９ＪＰ", "EJ123456789JP"],
    ["TBA123456789012", "TBA123456789012"],
    ["ＴＢＡ１２３４５６７８９０１２", "TBA123456789012"],
    // The international shape takes any two letters first, NO among them.
    ["NO123456789JP", "NO123456789JP"],
    // With no "." or ":", NO cannot be told from the number's own letters, so it stays.
    ["No123456789012", "NO123456789012"],
    ["No 1234-5678-9012", "NO123456789012"],
    ["Nov.123", "NOV123"],
  ])("%s", (raw, out) => {
    expect(normalizeTracking(raw)).toBe(out);
  });

  it("keeps the carrier each letter rule gives", () => {
    expect(identifyCarrier("EJ123456789JP").key).toBe("japanpost");
    expect(identifyCarrier("NO123456789JP").key).toBe("japanpost");
    expect(identifyCarrier("ＴＢＡ１２３４５６７８９０１２").key).toBe("amazon");
  });

  it("reads a number stored before the same: letters and digits come out unchanged", () => {
    for (const stored of ["123456789012", "NO123456789012", "EJ123456789JP", "TBA123456789012", "NOV123", "A1B2C3", "0"]) {
      expect(normalizeTracking(stored), stored).toBe(stored);
    }
    for (const raw of ["№123456789012", "No.EJ123456789JP", "Ｎｏ．１２３４", "①1234", "No.", "ーー"]) {
      const once = normalizeTracking(raw);
      expect(normalizeTracking(once), raw).toBe(once);
    }
  });
});

describe("a tracking number written with № in a mail and on the hand-entry form", () => {
  it.each([
    ["the shop mail first", false],
    ["the carrier mail first", true],
  ])("joins the carrier's mail without it into one parcel (%s)", async (_name, carrierFirst) => {
    const db = new FakeDb();
    const shop = reading({ relevance: "shipped", shop_name: "小さな店", order_number: sure("A-20261106-12"), tracking_number: sure("№1234-5678-9012"), carrier: sure("ヤマト運輸"), total_amount: sure(3300) });
    const carrier = reading({ relevance: "out_for_delivery", shop_name: null, carrier: sure("ヤマト運輸"), tracking_number: sure("1234-5678-9012"), expected_date: sure("2026-11-07") });
    const mails = [
      { x: shop, mail: { ...mailOf("2026-11-06T01:00:00Z"), messageId: "<shop-sign@test>" } },
      { x: carrier, mail: { ...mailOf("2026-11-07T00:30:00Z"), messageId: "<carrier-sign@test>" } },
    ];
    for (const m of carrierFirst ? [...mails].reverse() : mails) await processInboundEmail(asConsentingAdmin(db), m.mail, { precomputed: precomputed(m.x) });
    const parcels = db.rows("parcels").filter((r) => r.user_id === USER);
    expect(parcels).toHaveLength(1);
    expect(parcels[0]).toMatchObject({ tracking_number: NUMBER, carrier: "ヤマト運輸", status: "out_for_delivery", total_amount: 3300 });
  });

  it("is saved as the number on the form", () => {
    const base = { title: "品名", shop: "店", ordered_at: "", expected_date: "", total_amount: "", category: "", carrier: "auto", presence: "", status: "ordered" };
    for (const typed of ["№1234-5678-9012", "Ｎｏ．１２３４－５６７８－９０１２", "No.1234-5678-9012"]) {
      const parsed = ManualParcelSchema.safeParse({ ...base, tracking_number: typed });
      expect(parsed.success, typed).toBe(true);
      if (!parsed.success) continue;
      expect(manualParcelRow(parsed.data, new Date("2026-11-06T00:00:00Z")).tracking_number, typed).toBe(NUMBER);
    }
  });
});
