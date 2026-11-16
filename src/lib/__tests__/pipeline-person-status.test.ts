import { describe, expect, it } from "vitest";
import { rebuildParcel } from "@/lib/match";
import { processInboundEmail } from "@/lib/pipeline";
import { FakeDb, type Row } from "./fake-db";
import { USER, asConsentingAdmin, mailOf, precomputed, reading, sure } from "./pipeline-fixtures";

/**
 * Plan A: a parcel carries `status_set_by_person_at`, the time a person decided its status. A mail sent
 * BEFORE that time must not move the status (up or down). With the time null, an older mail still counts
 * (an order swap), as before. All shops and numbers here are made up.
 */

const T = "123456789012";
const T_RAW = "1234-5678-9012";
const BEFORE = "2026-11-01T00:00:00Z";
const T1 = "2026-11-02T00:00:00Z";
const T2 = "2026-11-04T00:00:00Z";
const T3 = "2026-11-06T00:00:00Z";
const AFTER_T3 = "2026-11-07T00:00:00Z";

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
    created_at: BEFORE,
    updated_at: BEFORE,
    last_email_at: BEFORE,
    ...over,
  };
}

const run = (db: FakeDb, x: ReturnType<typeof reading>, sentAt: string) => processInboundEmail(asConsentingAdmin(db), mailOf(sentAt), { precomputed: precomputed(x) });
const statusOf = (db: FakeDb) => db.find("parcels", "p-existing")!.status;
const mailReading = (relevance: "delivered" | "shipped") => reading({ relevance, tracking_number: sure(T_RAW) });

describe("a status the person decided is not moved by a mail sent before the decision", () => {
  it("P1: an older delivered mail does not bring back a parcel whose delivery record the person undid", async () => {
    const db = new FakeDb({
      parcels: [parcelRow({ status: "shipped", received_at: null, last_email_at: T3, status_set_by_person_at: AFTER_T3 })],
      emails: [],
      extractions: [],
    });
    await run(db, mailReading("delivered"), T1);
    expect(statusOf(db)).toBe("shipped");
  });

  it("P2: an older shipment mail does not change the status a person picked on a typed-in parcel", async () => {
    const db = new FakeDb({
      parcels: [parcelRow({ source: "manual", status: "ordered", last_email_at: T3, status_set_by_person_at: AFTER_T3 })],
      emails: [],
      extractions: [],
    });
    await run(db, mailReading("shipped"), T1);
    expect(statusOf(db)).toBe("ordered");
  });

  it("P3: an older shipment still counts when the person has decided nothing (order swap)", async () => {
    const db = new FakeDb({ parcels: [parcelRow({ status: "ordered", last_email_at: T3 })], emails: [], extractions: [] });
    await run(db, mailReading("shipped"), T1);
    expect(statusOf(db)).toBe("shipped");
    const rebuilt = rebuildParcel(USER, [
      { x: mailReading("shipped"), sentAt: T1 },
      { x: reading({ relevance: "order", tracking_number: sure(T_RAW) }), sentAt: T3 },
    ]);
    expect(rebuilt.status).toBe(statusOf(db));
  });

  it("P4: a mail sent after the person's decision still moves the status", async () => {
    const db = new FakeDb({
      parcels: [parcelRow({ status: "shipped", received_at: null, last_email_at: T1, status_set_by_person_at: T2 })],
      emails: [],
      extractions: [],
    });
    await run(db, mailReading("delivered"), T3);
    expect(statusOf(db)).toBe("delivered");
  });

  it("P5: an older whole cancellation does not cancel what the person set afterwards", async () => {
    const db = new FakeDb({
      parcels: [parcelRow({ status: "shipped", received_at: null, last_email_at: T3, status_set_by_person_at: AFTER_T3 })],
      emails: [],
      extractions: [],
    });
    await run(db, reading({ relevance: "cancelled", tracking_number: sure(T_RAW), cancel_partial: sure(false) }), T1);
    expect(statusOf(db)).toBe("shipped");
  });
});

describe("a mail with no sent time counts as before", () => {
  it("P6: a mail with no sent time still moves a status the person decided", async () => {
    const db = new FakeDb({
      parcels: [parcelRow({ status: "shipped", received_at: null, last_email_at: T1, status_set_by_person_at: AFTER_T3 })],
      emails: [],
      extractions: [],
    });
    await processInboundEmail(asConsentingAdmin(db), { ...mailOf(T1), sentAt: null }, { precomputed: precomputed(mailReading("delivered")) });
    expect(statusOf(db)).toBe("delivered");
  });
});

describe("twin parcels keep the status a person decided", () => {
  const ORDER = "ORD-12345678";
  const SENT = "2026-11-03T00:00:00Z";
  function twoParcels(a: Row, b: Row) {
    return new FakeDb({
      emails: [
        { id: "m-a", user_id: USER, sent_at: "2026-11-01T00:00:00Z" },
        { id: "m-b", user_id: USER, sent_at: "2026-11-02T00:00:00Z" },
      ],
      parcels: [
        parcelRow({ id: "p-a", order_number: ORDER, status: "ordered", tracking_number: null, last_email_at: BEFORE, ...a }),
        parcelRow({ id: "p-b", shop: "送り主不明", status: "shipped", tracking_number: T, created_at: T1, ...b }),
      ],
      extractions: [
        { id: "x-a", user_id: USER, email_id: "m-a", parcel_id: "p-a", result: reading({ relevance: "order", order_number: sure(ORDER) }) },
        { id: "x-b", user_id: USER, email_id: "m-b", parcel_id: "p-b", result: reading({ relevance: "shipped", shop_name: null, tracking_number: sure(T_RAW) }) },
      ],
    });
  }
  // A mail sent before every decision, naming both the order and the tracking number, joins the two.
  const joining = reading({ relevance: "shipped", order_number: sure(ORDER), tracking_number: sure(T_RAW), category: null });

  it("T1: the status of the parcel the person decided last stays after the merge", async () => {
    const db = twoParcels({ status: "ordered", status_set_by_person_at: T2 }, { status: "shipped", status_set_by_person_at: T3 });
    await run(db, joining, SENT);
    expect(db.find("parcels", "p-b")).toBeUndefined();
    expect(db.find("parcels", "p-a")!.status).toBe("shipped");
    // The latest time is not carried yet: the mail gateway's column allowlist (SQL) lacks the column until the migration.
  });

  it("T2: a status the kept parcel's person decided later beats the absorbed one", async () => {
    const db = twoParcels({ status: "ordered", status_set_by_person_at: T3 }, { status: "shipped", status_set_by_person_at: T2 });
    await run(db, joining, SENT);
    expect(db.find("parcels", "p-a")).toMatchObject({ status: "ordered" });
  });

  it("T3: with no decision time on either parcel, the merge is as before", async () => {
    const db = twoParcels({}, {});
    await run(db, joining, SENT);
    expect(db.find("parcels", "p-b")).toBeUndefined();
    expect(db.find("parcels", "p-a")!.status).toBe("shipped");
    expect(db.find("parcels", "p-a")!.status_set_by_person_at ?? null).toBeNull();
  });
});
