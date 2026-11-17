import { describe, expect, it } from "vitest";
import { processInboundEmail } from "@/lib/pipeline";
import { FakeDb, type Row } from "./fake-db";
import { USER, asConsentingAdmin, mailOf, precomputed, reading, sure } from "./pipeline-fixtures";

/**
 * Two parcels that a mail joins, every one taken out of the list by the app itself (kind `rule`), one of them with a
 * status the person decided. A shipment mail sent BEFORE that decision brings the kept parcel back into the list,
 * and the decided status and its time do not move. All shops and numbers here are made up.
 */

const T = "123456789012";
const T_RAW = "1234-5678-9012";
const ORDER = "ORD-12345678";
const BEFORE = "2026-11-01T00:00:00Z";
const DECIDED = "2026-11-04T00:00:00Z";
const SENT = "2026-11-03T00:00:00Z";

function parcelRow(over: Row): Row {
  return {
    id: "p-a", user_id: USER, shop: "サンプル商店", shop_key: "other", title: "サンプルの品", status: "ordered", source: "mail",
    tracking_number: null, expected_date: "2026-11-05", requires_presence: null, created_at: BEFORE, updated_at: BEFORE, last_email_at: BEFORE,
    ...over,
  };
}

const ruleMark = (parcelId: string, over: Row = {}): Row => ({ parcel_id: parcelId, user_id: USER, kind: "rule", from_domain: "shop.example", relevance: "order", counted: 3, ...over });

function setup(marked: boolean, decidedAt: string | null): FakeDb {
  return new FakeDb({
    emails: [
      { id: "m-a", user_id: USER, sent_at: "2026-11-01T00:00:00Z" },
      { id: "m-b", user_id: USER, sent_at: "2026-11-02T00:00:00Z" },
    ],
    parcels: [
      parcelRow({ id: "p-a", order_number: ORDER, status: "ordered", status_set_by_person_at: decidedAt }),
      parcelRow({ id: "p-b", shop: "送り主不明", status: "shipped", tracking_number: T, created_at: "2026-11-02T00:00:00Z" }),
    ],
    parcel_exclusions: marked ? [ruleMark("p-a"), ruleMark("p-b")] : [],
    extractions: [
      { id: "x-a", user_id: USER, email_id: "m-a", parcel_id: "p-a", result: reading({ relevance: "order", order_number: sure(ORDER) }) },
      { id: "x-b", user_id: USER, email_id: "m-b", parcel_id: "p-b", result: reading({ relevance: "shipped", shop_name: null, tracking_number: sure(T_RAW) }) },
    ],
  });
}

// A shipment mail naming both the order and the tracking number, sent before the person's decision.
const joining = reading({ relevance: "shipped", order_number: sure(ORDER), tracking_number: sure(T_RAW), category: null });
const join = (db: FakeDb) => processInboundEmail(asConsentingAdmin(db), mailOf(SENT), { precomputed: precomputed(joining) });

describe("L2 hidden twins joined by a shipment mail sent before the person's decision", () => {
  it("shows the kept parcel again and leaves the decided status and its time alone", async () => {
    const db = setup(true, DECIDED);
    await join(db);
    expect(db.find("parcels", "p-b")).toBeUndefined();
    expect(db.find("parcels", "p-a")).toMatchObject({ status: "ordered", status_set_by_person_at: DECIDED });
    expect(db.rows("parcel_exclusions").filter((m) => m.parcel_id === "p-a")).toHaveLength(0);
  });

  it("control: without a decision time the same mail moves the status (the decision is what holds it)", async () => {
    const db = setup(true, null);
    await join(db);
    expect(db.find("parcels", "p-a")!.status).toBe("shipped");
  });

  it("control: with no marks there is nothing to take off, so the mark check is about the mail", async () => {
    const db = setup(false, DECIDED);
    await join(db);
    expect(db.rows("parcel_exclusions")).toHaveLength(0);
    expect(db.find("parcels", "p-a")).toMatchObject({ status: "ordered", status_set_by_person_at: DECIDED });
  });
});
