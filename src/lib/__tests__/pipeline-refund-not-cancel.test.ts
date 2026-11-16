import { describe, expect, it } from "vitest";
import { withDefaults } from "@/lib/extract/schema";
import { verifyEvidence } from "@/lib/extract/verify-evidence";
import { buildParcelUpdate, isOutbound, isPartialCancel, mergeIntoManual, rebuildParcel, splitOrders, startsParcel } from "@/lib/match";
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

  it("row 3: an order cancelled as a whole before the parcel arrived (its refund told in the same mail) cancels it", async () => {
    const db = new FakeDb({ parcels: [parcelRow({ status: "shipped" })], emails: [], extractions: [] });
    await run(db, cancelMail({ cancel_partial: none }));
    expect(statusOf(db)).toBe("cancelled");
  });

  it("row 3: a mail that only says a refund was made (read as another purchase mail) leaves a shipped parcel shipped", async () => {
    const db = new FakeDb({ parcels: [parcelRow({ status: "shipped" })], emails: [], extractions: [] });
    await run(db, reading({ relevance: "other_purchase", tracking_number: sure(T_RAW), total_amount: sure(1200) }));
    expect(statusOf(db)).toBe("shipped");
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

  it("a typed-in shipped parcel: a cancellation sent earlier than its last mail does nothing, a newer one cancels", () => {
    const manual = { ...parcelRow({ status: "shipped", last_email_at: T2 }), source: "manual" } as unknown as Parameters<typeof mergeIntoManual>[0];
    expect(mergeIntoManual(manual, cancelMail({ cancel_partial: none }), T1).status).toBeUndefined();
    expect(mergeIntoManual(manual, cancelMail({ cancel_partial: none }), "2026-11-05T00:00:00Z").status).toBe("cancelled");
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

  it("the newest mail by sent time decides, whichever order the mails arrive in and whether read one at a time or rebuilt", () => {
    const cancel = () => cancelMail({ cancel_partial: none });
    const later = (rel: "shipped" | "out_for_delivery" | "attempted") => reading({ relevance: rel, tracking_number: sure(T_RAW) });
    const live = (firstStatus: string, firstAt: string, x: ReturnType<typeof reading>, at: string) => buildParcelUpdate(existing(firstStatus, firstAt), x, at).status ?? firstStatus;
    for (const rel of ["shipped", "out_for_delivery", "attempted"] as const) {
      // A cancellation sent first, a later shipment-side mail: the parcel is back, on every road.
      expect(live("cancelled", T1, later(rel), T2)).toBe(rel); // cancellation arrives first
      expect(live(rel, T2, cancel(), T1)).toBe(rel); // the later mail arrives first
      expect(rebuildParcel(USER, [{ x: cancel(), sentAt: T1 }, { x: later(rel), sentAt: T2 }]).status).toBe(rel); // rebuilt, oldest first
      // A shipment-side mail sent first, a later cancellation: cancelled, on every road.
      expect(live(rel, T1, cancel(), T2)).toBe("cancelled"); // the shipment arrives first
      expect(live("cancelled", T2, later(rel), T1)).toBe("cancelled"); // the later cancellation arrives first
      expect(rebuildParcel(USER, [{ x: later(rel), sentAt: T1 }, { x: cancel(), sentAt: T2 }]).status).toBe("cancelled");
    }
  });
});

describe("a partial cancellation whose quotation does not hold", () => {
  const MAIL = { subject: "テストのお知らせ", text: "テスト本文\n根拠の行" };
  const existing = (status: string) => parcelRow({ status, last_email_at: BEFORE }) as unknown as Parameters<typeof buildParcelUpdate>[0];
  const unquotedPartial = () => verifyEvidence(cancelMail({ cancel_partial: { value: true, evidence: "メールに無い行", confidence: 0.95 } }), MAIL);
  const unknownExtent = () => verifyEvidence(cancelMail({ cancel_partial: none }), MAIL);

  it("positive: a dropped 「part」 moves no status, opens no parcel and flags the parcel for review (one mail at a time and rebuilt)", () => {
    const x = unquotedPartial();
    expect(x.evidence_review).toContain("cancel_partial");
    const update = buildParcelUpdate(existing("shipped"), x, WHEN);
    expect(update.status).toBeUndefined();
    expect(update.needs_review).toBe(true);
    expect(startsParcel(x)).toBe(false);
    const rebuilt = rebuildParcel(USER, [{ x: reading({ relevance: "shipped", tracking_number: sure(T_RAW) }), sentAt: "2026-11-02T00:00:00Z" }, { x, sentAt: WHEN }]);
    expect(rebuilt.status).toBe("shipped");
    expect(rebuilt.needs_review).toBe(true);
  });

  it("negative: an extent that was never stated (null from the start) still cancels the parcel (one mail at a time and rebuilt)", () => {
    const x = unknownExtent();
    expect(x.evidence_review ?? []).not.toContain("cancel_partial");
    expect(buildParcelUpdate(existing("shipped"), x, WHEN).status).toBe("cancelled");
    expect(startsParcel(x)).toBe(true);
    expect(rebuildParcel(USER, [{ x: reading({ relevance: "shipped", tracking_number: sure(T_RAW) }), sentAt: "2026-11-02T00:00:00Z" }, { x, sentAt: WHEN }]).status).toBe("cancelled");
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
    expect(db.rows("parcels")).toHaveLength(2);
  });
});

describe("a mail read out of order: the state is the one a rebuild gives", () => {
  const ORDER_NO = "ORD-20261103-0001";
  const T0 = "2026-11-01T00:00:00Z";
  const T1 = "2026-11-02T00:00:00Z";
  const T2 = "2026-11-04T00:00:00Z";
  const T3 = "2026-11-06T00:00:00Z";
  type Reading = ReturnType<typeof reading>;
  type Step = { x: Reading; at: string };
  const orderMail = (): Reading => reading({ relevance: "order", order_number: sure(ORDER_NO) });
  const refund = (): Reading => reading({ relevance: "other_purchase", order_number: sure(ORDER_NO) });
  const wholeCancel = (): Reading => reading({ relevance: "cancelled", order_number: sure(ORDER_NO), cancel_partial: whole() });
  const partialCancel = (): Reading => reading({ relevance: "cancelled", order_number: sure(ORDER_NO), cancel_partial: partial() });
  const shipment = (): Reading => reading({ relevance: "shipped", order_number: sure(ORDER_NO) });

  /** The state a rebuild (mail parcel) or an oldest-first merge (typed-in parcel) gives for the same mails. */
  function settled(steps: Step[], manual: boolean): string | null | undefined {
    const mails = steps.map((s) => ({ x: s.x, sentAt: s.at }));
    if (!manual) return rebuildParcel(USER, mails).status;
    const row = { ...parcelRow({ status: "ordered", last_email_at: null, order_number: ORDER_NO, tracking_number: null }), source: "manual" } as unknown as Parameters<typeof mergeIntoManual>[0];
    for (const m of [...mails].sort((a, b) => a.sentAt.localeCompare(b.sentAt))) Object.assign(row, mergeIntoManual(row, m.x, m.sentAt));
    return row.status;
  }

  async function arrive(steps: Step[], manual: boolean) {
    const db = new FakeDb({
      parcels: manual ? [parcelRow({ source: "manual", status: "ordered", order_number: ORDER_NO, tracking_number: null, last_email_at: null })] : [],
      emails: [],
      extractions: [],
    });
    for (const s of steps) await run(db, s.x, s.at);
    return db;
  }

  async function sameAsRebuilt(steps: Step[], manual: boolean, expected: string) {
    const db = await arrive(steps, manual);
    const parcels = db.rows("parcels");
    expect(parcels).toHaveLength(1);
    expect(parcels[0].status).toBe(expected);
    expect(settled(steps, manual)).toBe(expected);
  }

  it("a newer refund read first, then an older whole cancellation: cancelled, the same as rebuilt", async () => {
    await sameAsRebuilt([{ x: orderMail(), at: T0 }, { x: refund(), at: T2 }, { x: wholeCancel(), at: T1 }], false, "cancelled");
  });

  it("a newer sure partial cancellation read first, then an older whole cancellation: cancelled (the whole one wins)", async () => {
    await sameAsRebuilt([{ x: orderMail(), at: T0 }, { x: partialCancel(), at: T2 }, { x: wholeCancel(), at: T1 }], false, "cancelled");
  });

  it("a cancellation, a refund, then a shipment sent between them read last: same as rebuilt", async () => {
    const steps: Step[] = [{ x: wholeCancel(), at: T1 }, { x: refund(), at: T3 }, { x: shipment(), at: T2 }];
    const rebuilt = rebuildParcel(USER, steps.map((s) => ({ x: s.x, sentAt: s.at }))).status;
    expect(rebuilt).toBe("shipped");
    await sameAsRebuilt(steps, false, "shipped");
  });

  it("a typed-in parcel: the same pairs as above give the oldest-first merge's state", async () => {
    await sameAsRebuilt([{ x: orderMail(), at: T0 }, { x: refund(), at: T2 }, { x: wholeCancel(), at: T1 }], true, "cancelled");
    await sameAsRebuilt([{ x: orderMail(), at: T0 }, { x: partialCancel(), at: T2 }, { x: wholeCancel(), at: T1 }], true, "cancelled");
  });

  it("a sender's mail read as a whole cancellation neither cancels nor opens a parcel, mail or typed-in", async () => {
    const sender = () => cancelMail({ inbound: sure(false), cancel_partial: whole() });
    const mailParcel = parcelRow({ status: "shipped" }) as unknown as Parameters<typeof buildParcelUpdate>[0];
    const typedIn = { ...mailParcel, source: "manual" } as unknown as Parameters<typeof mergeIntoManual>[0];
    expect(buildParcelUpdate(mailParcel, sender(), WHEN)).toEqual({});
    expect(mergeIntoManual(typedIn, sender(), WHEN)).toEqual({});
    expect(startsParcel(sender())).toBe(false);
    for (const source of ["mail", "manual"]) {
      const db = new FakeDb({ parcels: [parcelRow({ status: "shipped", source })], emails: [], extractions: [] });
      await run(db, sender());
      expect(statusOf(db)).toBe("shipped");
      expect(db.find("parcels", "p-existing")!.last_email_at).toBe(BEFORE);
    }
    const empty = new FakeDb({ parcels: [], emails: [], extractions: [] });
    await run(empty, sender());
    expect(empty.rows("parcels")).toEqual([]);
  });

  it("splitOrders keeps a sender's reading on every order", () => {
    const other = (n: string) => ({ order_number: sure(n), items: [], category: null, total_amount: none, expected_date: none, expected_date_end: none, expected_text: null });
    const parts = splitOrders(cancelMail({ order_number: sure("ORD-A"), inbound: sure(false), cancel_partial: whole(), other_orders: [other("ORD-B"), other("ORD-C")] }));
    expect(parts).toHaveLength(3);
    expect(parts.every(isOutbound)).toBe(true);
  });
});
