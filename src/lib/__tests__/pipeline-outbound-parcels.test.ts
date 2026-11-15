import { describe, expect, it } from "vitest";
import { withDefaults } from "@/lib/extract/schema";
import { verifyEvidence } from "@/lib/extract/verify-evidence";
import { arrivingReadings, buildParcelUpdate, isOutbound, mergeIntoManual, parcelTotal, rebuildParcel, startsParcel } from "@/lib/match";
import { processInboundEmail } from "@/lib/pipeline";
import { FakeDb, type Row } from "./fake-db";
import { USER, asConsentingAdmin, mailOf, none, precomputed, reading, sure } from "./pipeline-fixtures";

/**
 * A mail whose reader is the sender (a freight receipt, a sender's copy, a return going out) is not a
 * parcel coming to them, whatever it was read as. Only a stated, confident `inbound: false` says so;
 * null and true keep the old behavior. All shops, carriers, names and numbers here are made up.
 */

const T = "123456789012";
const T_RAW = "1234-5678-9012";
const WHEN = "2026-11-03T01:00:00Z";

/** The reading says the reader is the sender, quoting a line the made-up mail really contains. */
const sentByReader = () => sure(false);

function parcelRow(over: Row = {}): Row {
  return {
    id: "p-existing",
    user_id: USER,
    shop: "サンプル商店",
    shop_key: "other",
    title: "サンプルの品",
    status: "shipped",
    source: "mail",
    tracking_number: T,
    expected_date: "2026-11-05",
    requires_presence: null,
    created_at: "2026-11-01T00:00:00Z",
    updated_at: "2026-11-01T00:00:00Z",
    last_email_at: "2026-11-01T00:00:00Z",
    ...over,
  };
}

const run = (db: FakeDb, x: ReturnType<typeof reading>) => processInboundEmail(asConsentingAdmin(db), mailOf(WHEN), { precomputed: precomputed(x) });
const parcelWrites = (db: FakeDb) => db.rpcCalls.filter((c) => c.name === "create_mail_parcel" || c.name === "update_mail_parcel");

describe("startsParcel: the reader is the sender", () => {
  it("T1: a freight receipt with a waybill number opens no parcel", () => {
    expect(startsParcel(reading({ relevance: "other_purchase", tracking_number: sure("0000-1111-2222"), inbound: sentByReader() }))).toBe(false);
  });
  it("T2: a subscription shipment with a tracking number still opens one", () => {
    expect(startsParcel(reading({ relevance: "other_purchase", tracking_number: sure("3333-4444-5555") }))).toBe(true);
    expect(startsParcel(reading({ relevance: "other_purchase", tracking_number: sure("3333-4444-5555"), inbound: sure(true) }))).toBe(true);
  });
  it("T3: a shop's delivery notice opens one", () => {
    expect(startsParcel(reading({ relevance: "shipped", shop_name: "サンプル商店", tracking_number: sure(T_RAW), inbound: sure(true) }))).toBe(true);
  });
  it("T4: a parcel coming from family opens one", () => {
    expect(startsParcel(reading({ relevance: "shipped", shop_name: "サンプル 花子", tracking_number: sure(T_RAW), inbound: sure(true) }))).toBe(true);
  });
  it("T5: a delivered notice to the sender opens none, even though it is not other_purchase", () => {
    expect(startsParcel(reading({ relevance: "delivered", tracking_number: sure(T_RAW), inbound: sentByReader() }))).toBe(false);
  });
  it("T6: a notice addressed to a family name, with inbound not stated, opens one", () => {
    expect(startsParcel(reading({ relevance: "shipped", shop_name: "サンプル商店", tracking_number: sure(T_RAW), inbound: none }))).toBe(true);
  });
});

describe("what a false inbound must not reject", () => {
  it("a parcel to a family or company name, when the mail does not say the reader sent it", () => {
    for (const shop_name of ["サンプル 花子", "株式会社サンプル"]) {
      expect(startsParcel(reading({ relevance: "shipped", shop_name, tracking_number: sure(T_RAW), inbound: none }))).toBe(true);
    }
  });
  it("a return coming back to the reader (inbound not stated, or stated true) still opens a parcel", () => {
    expect(startsParcel(reading({ relevance: "shipped", tracking_number: sure(T_RAW), inbound: none }))).toBe(true);
    expect(startsParcel(reading({ relevance: "delivered", tracking_number: sure(T_RAW), inbound: sure(true) }))).toBe(true);
  });
  it("a shop's pickup notice keeps today's behavior: no parcel without a number, one with a number", () => {
    expect(startsParcel(reading({ relevance: "other_purchase", inbound: none }))).toBe(false);
    expect(startsParcel(reading({ relevance: "other_purchase", tracking_number: sure("7777-8888-9999"), inbound: none }))).toBe(true);
  });
  it("a false the model is not sure of does not count", () => {
    const unsure = { value: false, evidence: "根拠の行", confidence: 0.4 };
    expect(isOutbound(reading({ inbound: unsure }))).toBe(false);
    expect(startsParcel(reading({ relevance: "shipped", tracking_number: sure(T_RAW), inbound: unsure }))).toBe(true);
  });
  it("a false quoting a line the mail does not contain is dropped to null before it is used", () => {
    const x = verifyEvidence(reading({ relevance: "shipped", tracking_number: sure(T_RAW), inbound: { value: false, evidence: "メールに無い行", confidence: 0.95 } }), {
      subject: "テストのお知らせ",
      text: "テスト本文\n根拠の行",
    });
    expect(x.inbound.value).toBeNull();
    expect(startsParcel(x)).toBe(true);
  });
  it("a true quoting a line the mail does not contain adds no review flag, in the reading or on the parcel", async () => {
    const quote = { value: true, evidence: "メールに無い行", confidence: 0.95 };
    const x = verifyEvidence(reading({ relevance: "shipped", tracking_number: sure(T_RAW), inbound: quote }), { subject: "テストのお知らせ", text: "テスト本文\n根拠の行" });
    expect(x.evidence_review ?? []).not.toContain("inbound");
    const db = new FakeDb({ parcels: [], emails: [], extractions: [] });
    await run(db, reading({ relevance: "shipped", tracking_number: sure(T_RAW), inbound: quote }));
    expect(db.rows("parcels")).toHaveLength(1);
    expect(db.rows("parcels")[0].needs_review).toBe(false);
  });
  it("a false whose quotation is missing is still flagged for review", () => {
    const x = verifyEvidence(reading({ relevance: "shipped", tracking_number: sure(T_RAW), inbound: { value: false, evidence: "メールに無い行", confidence: 0.95 } }), { subject: "テストのお知らせ", text: "テスト本文\n根拠の行" });
    expect(x.evidence_review).toContain("inbound");
  });
  it("a reading saved before the field existed reads as not stated", () => {
    const old = { ...reading({ relevance: "shipped" }) } as Partial<ReturnType<typeof reading>>;
    delete old.inbound;
    const filled = withDefaults(old as ReturnType<typeof reading>);
    expect(filled.inbound).toEqual({ value: null, evidence: null, confidence: 0 });
    expect(isOutbound(filled)).toBe(false);
  });
});

describe("the mail processing with a reader who sent the parcel", () => {
  it("T1: files the reading but opens no parcel", async () => {
    const db = new FakeDb({ parcels: [], emails: [], extractions: [] });
    await run(db, reading({ relevance: "other_purchase", tracking_number: sure("0000-1111-2222"), inbound: sentByReader() }));
    expect(db.rows("parcels")).toEqual([]);
    expect(parcelWrites(db)).toEqual([]);
    expect(db.rows("extractions")).toHaveLength(1);
    expect(db.rows("extractions")[0].parcel_id).toBeNull();
  });

  it("T2: a subscription shipment with a number opens a parcel", async () => {
    const db = new FakeDb({ parcels: [], emails: [], extractions: [] });
    await run(db, reading({ relevance: "other_purchase", tracking_number: sure("3333-4444-5555") }));
    expect(db.rows("parcels")).toHaveLength(1);
  });

  it("T5: a delivered notice to the sender opens none", async () => {
    const db = new FakeDb({ parcels: [], emails: [], extractions: [] });
    await run(db, reading({ relevance: "delivered", tracking_number: sure(T_RAW), inbound: sentByReader() }));
    expect(db.rows("parcels")).toEqual([]);
  });

  it("T5: and leaves the status, date and presence of a parcel with the same number alone", async () => {
    const db = new FakeDb({ parcels: [parcelRow()], emails: [], extractions: [] });
    await run(db, reading({ relevance: "delivered", tracking_number: sure(T_RAW), expected_date: sure("2026-11-03"), requires_presence: sure(true), inbound: sentByReader() }));
    const row = db.find("parcels", "p-existing")!;
    expect(row.status).toBe("shipped");
    expect(row.expected_date).toBe("2026-11-05");
    expect(row.requires_presence).toBeNull();
    expect(row.last_email_at).toBe("2026-11-01T00:00:00Z");
    expect(parcelWrites(db)).toEqual([]);
    expect(db.rows("extractions")).toHaveLength(1);
    expect(db.rows("extractions")[0].parcel_id).toBe("p-existing");
  });

  it("control: the same delivered notice without the sender's mark does move that parcel", async () => {
    const db = new FakeDb({ parcels: [parcelRow()], emails: [], extractions: [] });
    await run(db, reading({ relevance: "delivered", tracking_number: sure(T_RAW), expected_date: sure("2026-11-03"), inbound: none }));
    expect(db.find("parcels", "p-existing")!.status).toBe("delivered");
  });

  it("T6: a notice with inbound not stated opens a parcel", async () => {
    const db = new FakeDb({ parcels: [], emails: [], extractions: [] });
    await run(db, reading({ relevance: "shipped", shop_name: "サンプル 花子", tracking_number: sure(T_RAW), inbound: none }));
    expect(db.rows("parcels")).toHaveLength(1);
  });

  it("T4: a parcel from family stated as coming to the reader opens a parcel", async () => {
    const db = new FakeDb({ parcels: [], emails: [], extractions: [] });
    await run(db, reading({ relevance: "shipped", shop_name: "サンプル 花子", tracking_number: sure(T_RAW), inbound: sure(true) }));
    expect(db.rows("parcels")).toHaveLength(1);
  });
});

describe("siblings of the freight receipt", () => {
  const ORDER = "ORD-12345678";
  const Y_RAW = "9999-8888-7777";
  const original = () => parcelRow({ order_number: ORDER, status: "delivered", carrier: "サンプル配送", tracking_url: "https://carrier.example.test/x", requires_presence: false });
  const returnLabel = (inbound: ReturnType<typeof reading>["inbound"]) =>
    reading({ relevance: "other_purchase", order_number: sure(ORDER), tracking_number: sure(Y_RAW), carrier: sure("別のサンプル配送"), requires_presence: sure(true), inbound });

  it("S1: a return label joined to the original order leaves its number, carrier, link, presence and clock alone", async () => {
    const db = new FakeDb({ parcels: [original()], emails: [], extractions: [] });
    await run(db, returnLabel(sentByReader()));
    const row = db.find("parcels", "p-existing")!;
    expect(row).toMatchObject({ tracking_number: T, carrier: "サンプル配送", tracking_url: "https://carrier.example.test/x", requires_presence: false, status: "delivered", last_email_at: "2026-11-01T00:00:00Z" });
    expect(parcelWrites(db)).toEqual([]);
    expect(db.rows("extractions")[0].parcel_id).toBe("p-existing");
  });

  it("S1 control: the same label without the sender's mark does replace the number (today's behavior)", async () => {
    const db = new FakeDb({ parcels: [original()], emails: [], extractions: [] });
    await run(db, returnLabel(none));
    expect(db.find("parcels", "p-existing")!.tracking_number).not.toBe(T);
  });

  it("S1: a typed-in parcel is left alone too", () => {
    const manual = { ...original(), source: "manual" } as unknown as Parameters<typeof mergeIntoManual>[0];
    expect(mergeIntoManual(manual, returnLabel(sentByReader()), WHEN)).toEqual({});
    expect(buildParcelUpdate(manual, returnLabel(sentByReader()), WHEN)).toEqual({});
  });

  it("S2: a seller's 'your item has shipped' notice with a tracking number opens no parcel", async () => {
    const db = new FakeDb({ parcels: [], emails: [], extractions: [] });
    await run(db, reading({ relevance: "shipped", tracking_number: sure("5555-6666-7777"), inbound: sentByReader() }));
    expect(db.rows("parcels")).toEqual([]);
  });

  it("S2': the buyer's 'the seller has shipped' notice still opens one", async () => {
    const db = new FakeDb({ parcels: [], emails: [], extractions: [] });
    await run(db, reading({ relevance: "shipped", tracking_number: sure("5555-6666-7777"), inbound: sure(true) }));
    expect(db.rows("parcels")).toHaveLength(1);
  });

  it("S3: a shipping application receipt opens no parcel", async () => {
    const db = new FakeDb({ parcels: [], emails: [], extractions: [] });
    await run(db, reading({ relevance: "other_purchase", tracking_number: sure("0000-1111-2222"), inbound: sentByReader() }));
    expect(db.rows("parcels")).toEqual([]);
  });

  it("S3': a delivery-time change receipt joins the existing parcel and writes its date", async () => {
    const db = new FakeDb({ parcels: [parcelRow()], emails: [], extractions: [] });
    await run(db, reading({ relevance: "other_purchase", tracking_number: sure(T_RAW), expected_date: sure("2026-11-07"), inbound: none }));
    expect(db.find("parcels", "p-existing")!.expected_date).toBe("2026-11-07");
  });
});

describe("a sender's reading does not leak into a parcel's rebuilt fields or total", () => {
  const shipment = (amount: number, inbound: ReturnType<typeof reading>["inbound"] = none) => reading({ relevance: "shipped", tracking_number: sure(T_RAW), total_amount: sure(amount), inbound });
  it("parcelTotal ignores it", () => {
    expect(parcelTotal([shipment(1000), shipment(500, sentByReader())])).toBe(parcelTotal([shipment(1000)]));
  });
  it("rebuildParcel called directly leaves it out, so an oldest sender's reading does not make the status delivered", () => {
    const sent = reading({ relevance: "delivered", tracking_number: sure(T_RAW), inbound: sentByReader() });
    const readings = [{ x: reading({ relevance: "shipped", tracking_number: sure(T_RAW) }), sentAt: "2026-11-02T00:00:00Z" }, { x: sent, sentAt: "2026-11-01T00:00:00Z" }];
    expect(rebuildParcel(USER, readings).status).toBe("shipped");
    expect(rebuildParcel(USER, arrivingReadings(readings)).status).toBe("shipped");
  });
  it("rebuildParcel still builds when every reading is the sender's", () => {
    const sent = [{ x: reading({ relevance: "shipped", tracking_number: sure(T_RAW), inbound: sentByReader() }), sentAt: null }];
    expect(rebuildParcel(USER, sent).status).toBe("shipped");
  });
  it("keeps every reading when all of them are the sender's, so something is left to rebuild from", () => {
    const sent = [{ x: reading({ relevance: "delivered", inbound: sentByReader() }), sentAt: null }];
    expect(arrivingReadings(sent)).toEqual(sent);
  });
});
