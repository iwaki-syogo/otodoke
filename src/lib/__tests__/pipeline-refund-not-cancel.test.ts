import { describe, expect, it } from "vitest";
import { withDefaults } from "@/lib/extract/schema";
import { verifyEvidence } from "@/lib/extract/verify-evidence";
import { buildParcelUpdate, isPartialCancel, mergeIntoManual, rebuildParcel, splitOrders, startsParcel } from "@/lib/match";
import { processInboundEmail } from "@/lib/pipeline";
import { FakeDb, type Row } from "./fake-db";
import { USER, asConsentingAdmin, mailOf, none, precomputed, reading, sure } from "./pipeline-fixtures";

/**
 * A refund or a partial cancellation is not the cancellation of a whole order. Only an order cancelled
 * as a whole (or one whose extent is unknown) cancels the parcel, and a parcel that arrived is never
 * cancelled by a mail. All shops, numbers and amounts here are made up.
 */

const T = "123456789012";
const T_RAW = "1234-5678-9012";
const WHEN = "2026-11-03T01:00:00Z";
const BEFORE = "2026-11-01T00:00:00Z";

const partial = () => sure(true);
const whole = () => sure(false);

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

const run = (db: FakeDb, x: ReturnType<typeof reading>, sentAt = WHEN) => processInboundEmail(asConsentingAdmin(db), mailOf(sentAt), { precomputed: precomputed(x) });
const statusOf = (db: FakeDb, id = "p-existing") => db.find("parcels", id)!.status;
const cancelMail = (over: Partial<ReturnType<typeof reading>> = {}) => reading({ relevance: "cancelled", tracking_number: sure(T_RAW), ...over });

describe("the table of refund and cancellation mails", () => {
  it("row 1: an order cancelled as a whole stays a cancellation (stated whole, and extent unknown)", async () => {
    for (const cancel_partial of [whole(), none]) {
      const db = new FakeDb({ parcels: [parcelRow({ status: "ordered" })], emails: [], extractions: [] });
      await run(db, cancelMail({ cancel_partial }));
      expect(statusOf(db)).toBe("cancelled");
    }
  });

  it("row 2: a partial cancellation leaves the status alone and opens no parcel", async () => {
    const db = new FakeDb({ parcels: [parcelRow({ status: "shipped" })], emails: [], extractions: [] });
    await run(db, cancelMail({ cancel_partial: partial() }));
    expect(statusOf(db)).toBe("shipped");
    const empty = new FakeDb({ parcels: [], emails: [], extractions: [] });
    await run(empty, cancelMail({ cancel_partial: partial() }));
    expect(empty.rows("parcels")).toEqual([]);
  });

  it("row 3: a full refund before the parcel arrived cancels it", async () => {
    const db = new FakeDb({ parcels: [parcelRow({ status: "shipped" })], emails: [], extractions: [] });
    await run(db, cancelMail({ cancel_partial: none }));
    expect(statusOf(db)).toBe("cancelled");
  });

  it("row 4: a full refund after the parcel arrived leaves it delivered (a delivered parcel is never cancelled by a mail)", async () => {
    const db = new FakeDb({ parcels: [parcelRow({ status: "delivered" })], emails: [], extractions: [] });
    await run(db, cancelMail({ cancel_partial: none }));
    expect(statusOf(db)).toBe("delivered");
  });

  it("row 5: a partial refund (read as another purchase mail) leaves the status alone", async () => {
    const db = new FakeDb({ parcels: [parcelRow({ status: "shipped" })], emails: [], extractions: [] });
    await run(db, reading({ relevance: "other_purchase", tracking_number: sure(T_RAW) }));
    expect(statusOf(db)).toBe("shipped");
  });

  it("row 6: the refund of a return leaves a delivered parcel delivered", async () => {
    const db = new FakeDb({ parcels: [parcelRow({ status: "delivered" })], emails: [], extractions: [] });
    await run(db, reading({ relevance: "other_purchase", tracking_number: sure(T_RAW) }));
    expect(statusOf(db)).toBe("delivered");
  });

  it("row 7: a points or price-difference refund changes nothing and opens no parcel", async () => {
    const db = new FakeDb({ parcels: [], emails: [], extractions: [] });
    await run(db, reading({ relevance: "other_purchase", total_amount: sure(300) }));
    expect(db.rows("parcels")).toEqual([]);
  });

  it("row 8: a refund with no parcel behind it opens no parcel", async () => {
    const db = new FakeDb({ parcels: [], emails: [], extractions: [] });
    await run(db, reading({ relevance: "other_purchase", order_number: sure("ORD-00000001") }));
    expect(db.rows("parcels")).toEqual([]);
  });
});

describe("what the guard must not reject", () => {
  it("1: an order that really was cancelled as a whole still cancels (startsParcel keeps today's behavior too)", () => {
    expect(startsParcel(cancelMail({ cancel_partial: whole() }))).toBe(true);
    expect(startsParcel(cancelMail({ cancel_partial: none }))).toBe(true);
    expect(startsParcel(cancelMail({ cancel_partial: partial() }))).toBe(false);
  });

  it("2: a cancellation after the shipment still cancels (only delivered is guarded)", async () => {
    for (const status of ["shipped", "out_for_delivery", "attempted"]) {
      const db = new FakeDb({ parcels: [parcelRow({ status })], emails: [], extractions: [] });
      await run(db, cancelMail({ cancel_partial: whole() }));
      expect(statusOf(db)).toBe("cancelled");
    }
  });

  it("3: delivered is guarded, and a typed-in parcel is guarded the same way (the exit is the person's own edit)", () => {
    const delivered = parcelRow({ status: "delivered" }) as unknown as Parameters<typeof buildParcelUpdate>[0];
    expect(buildParcelUpdate(delivered, cancelMail({ cancel_partial: none }), WHEN).status).toBeUndefined();
    const manual = { ...delivered, source: "manual" } as unknown as Parameters<typeof mergeIntoManual>[0];
    expect(mergeIntoManual(manual, cancelMail({ cancel_partial: none }), WHEN).status).toBeUndefined();
  });

  it("4: a parcel already cancelled is not rewritten by a later partial cancellation", async () => {
    const db = new FakeDb({ parcels: [parcelRow({ status: "cancelled" })], emails: [], extractions: [] });
    await run(db, cancelMail({ cancel_partial: partial() }));
    expect(statusOf(db)).toBe("cancelled");
  });

  it("5: a reading saved before the field existed reads as unknown extent and cancels as it did", () => {
    const old = { ...cancelMail() } as Partial<ReturnType<typeof reading>>;
    delete old.cancel_partial;
    const filled = withDefaults(old as ReturnType<typeof reading>);
    expect(filled.cancel_partial).toEqual({ value: null, evidence: null, confidence: 0 });
    expect(isPartialCancel(filled)).toBe(false);
    expect(isPartialCancel(old as ReturnType<typeof reading>)).toBe(false);
    expect(buildParcelUpdate(parcelRow({ status: "shipped" }) as unknown as Parameters<typeof buildParcelUpdate>[0], filled, WHEN).status).toBe("cancelled");
  });

  it("a partial that is not sure, or is not a cancellation, does not count", () => {
    expect(isPartialCancel(cancelMail({ cancel_partial: { value: true, evidence: "根拠の行", confidence: 0.4 } }))).toBe(false);
    expect(isPartialCancel(reading({ relevance: "shipped", cancel_partial: partial() }))).toBe(false);
  });

  it("a true quoting a line the mail does not contain is dropped to null; a false or null adds no review flag", () => {
    const mail = { subject: "テストのお知らせ", text: "テスト本文\n根拠の行" };
    const bad = verifyEvidence(cancelMail({ cancel_partial: { value: true, evidence: "メールに無い行", confidence: 0.95 } }), mail);
    expect(bad.cancel_partial.value).toBeNull();
    expect(bad.evidence_review).toContain("cancel_partial");
    const fine = verifyEvidence(cancelMail({ cancel_partial: { value: false, evidence: "メールに無い行", confidence: 0.95 } }), mail);
    expect(fine.evidence_review ?? []).not.toContain("cancel_partial");
  });
});

describe("the same state from one mail at a time and from a rebuild", () => {
  const existing = (status: string, last: string) => parcelRow({ status, last_email_at: last }) as unknown as Parameters<typeof buildParcelUpdate>[0];
  const T1 = "2026-11-02T00:00:00Z";
  const T2 = "2026-11-04T00:00:00Z";
  const delivered = () => reading({ relevance: "delivered", tracking_number: sure(T_RAW) });
  const shipped = () => reading({ relevance: "shipped", tracking_number: sure(T_RAW) });

  it("a delivered mail, then a cancellation sent earlier: delivered both ways", () => {
    const live = buildParcelUpdate(existing("delivered", T2), cancelMail({ cancel_partial: none }), T1);
    expect(live.status).toBeUndefined();
    const rebuilt = rebuildParcel(USER, [
      { x: cancelMail({ cancel_partial: none }), sentAt: T1 },
      { x: delivered(), sentAt: T2 },
    ]);
    expect(rebuilt.status).toBe("delivered");
  });

  it("a delivered mail, then a cancellation sent later: delivered both ways", () => {
    expect(buildParcelUpdate(existing("delivered", T1), cancelMail({ cancel_partial: none }), T2).status).toBeUndefined();
    expect(rebuildParcel(USER, [{ x: delivered(), sentAt: T1 }, { x: cancelMail({ cancel_partial: none }), sentAt: T2 }]).status).toBe("delivered");
  });

  it("scope-extension: an old cancellation, then a newer delivery: delivered, one mail at a time and rebuilt", () => {
    expect(buildParcelUpdate(existing("cancelled", T1), delivered(), T2).status).toBe("delivered");
    expect(rebuildParcel(USER, [{ x: cancelMail({ cancel_partial: none }), sentAt: T1 }, { x: delivered(), sentAt: T2 }]).status).toBe("delivered");
    // The delivery sent before the cancellation does not undo it.
    expect(buildParcelUpdate(existing("cancelled", T2), delivered(), T1).status).toBeUndefined();
  });

  it("a typed-in parcel that is cancelled stays cancelled when a newer delivery mail comes; a delivered one is not cancelled by a mail", () => {
    const manual = (status: string, last: string) => ({ ...parcelRow({ status, last_email_at: last }), source: "manual" }) as unknown as Parameters<typeof mergeIntoManual>[0];
    const afterCancel = mergeIntoManual(manual("cancelled", T1), delivered(), T2);
    expect(afterCancel.status).toBeUndefined();
    expect(mergeIntoManual(manual("delivered", T2), cancelMail({ cancel_partial: none }), T1).status).toBeUndefined();
  });

  it("known difference: a newer cancellation read first, then an older delivery, stays cancelled one mail at a time but is delivered when rebuilt (the delivered guard wins there)", () => {
    // Parcel is already cancelled (T2); the older delivery mail arrives late and does not undo it.
    expect(buildParcelUpdate(existing("cancelled", T2), delivered(), T1).status).toBeUndefined();
    // Rebuilt oldest first, the delivery comes before the cancellation, which the guard then refuses.
    expect(rebuildParcel(USER, [{ x: delivered(), sentAt: T1 }, { x: cancelMail({ cancel_partial: none }), sentAt: T2 }]).status).toBe("delivered");
  });

  it("a shipment, then a later cancellation: cancelled both ways; an earlier cancellation does not win over the later shipment either way", () => {
    expect(buildParcelUpdate(existing("shipped", T1), cancelMail({ cancel_partial: none }), T2).status).toBe("cancelled");
    expect(rebuildParcel(USER, [{ x: shipped(), sentAt: T1 }, { x: cancelMail({ cancel_partial: none }), sentAt: T2 }]).status).toBe("cancelled");
    // The shipment is the later word here: a cancellation sent earlier does not reach it.
    expect(buildParcelUpdate(existing("shipped", T2), cancelMail({ cancel_partial: none }), T1).status).toBeUndefined();
  });
});

describe("a mail that lists several orders", () => {
  const other = (n: string) => ({ order_number: sure(n), items: [], category: null, total_amount: none, expected_date: none, expected_date_end: none, expected_text: null });

  it("a cancellation goes to the first order only; the others are read as other purchase mail", () => {
    const [first, second] = splitOrders(cancelMail({ order_number: sure("ORD-A"), other_orders: [other("ORD-B")] }));
    expect(first.relevance).toBe("cancelled");
    expect(second.relevance).toBe("other_purchase");
    expect(startsParcel(second)).toBe(false);
  });

  it("other mails still pass their relevance to every order", () => {
    const parts = splitOrders(reading({ relevance: "shipped", order_number: sure("ORD-A"), other_orders: [other("ORD-B")] }));
    expect(parts.map((p) => p.relevance)).toEqual(["shipped", "shipped"]);
  });

  it("filed: the order the mail names is cancelled, the second order's parcel is not", async () => {
    const a = parcelRow({ id: "p-a", order_number: "ORD-20261103-0001", tracking_number: null, status: "ordered" });
    const b = parcelRow({ id: "p-b", order_number: "ORD-20261103-0002", tracking_number: null, status: "ordered" });
    const db = new FakeDb({ parcels: [a, b], emails: [], extractions: [] });
    await run(db, reading({ relevance: "cancelled", order_number: sure("ORD-20261103-0001"), other_orders: [other("ORD-20261103-0002")] }));
    expect(statusOf(db, "p-a")).toBe("cancelled");
    expect(statusOf(db, "p-b")).toBe("ordered");
  });
});
