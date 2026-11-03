import { describe, expect, it } from "vitest";
import { processInboundEmail } from "@/lib/pipeline";
import { FakeDb, describeQuery, embedScopedToUser, scopedToUser, type Query } from "./fake-db";
import { OTHER, USER, asAdmin, item, mailOf, precomputed, reading, sure } from "./pipeline-fixtures";

/**
 * The pipeline runs with the service role, which bypasses row-level security. Every read and
 * write it makes on parcels, parcel_items and extractions must therefore name the user itself.
 * Inserts are left out: they put user_id into the row.
 */
const SCOPED_TABLES = ["parcels", "parcel_items", "extractions"];

function unscoped(db: FakeDb): string[] {
  return db.calls
    .filter((q: Query) => SCOPED_TABLES.includes(q.table) && q.op !== "insert" && q.op !== "upsert")
    .filter((q) => !scopedToUser(q, USER) || (q.table === "parcels" && /parcel_items/.test(q.columns ?? "") && !embedScopedToUser(q, "parcel_items", USER)))
    .map(describeQuery);
}

const TRACKING = "123456789012";
const ORDER = "ORD-12345678";

/**
 * A carrier mail opened parcel A (tracking only); the shop's order mail opened parcel B (order
 * number only). The shop's shipping mail now names both numbers, so B gets the tracking number
 * and A is folded into B. Another account has rows that point at A and B: rows a user can write
 * through the old `for all` policies.
 */
function twinsScenario() {
  return new FakeDb({
    emails: [
      { id: "m-carrier", user_id: USER, sent_at: "2026-11-02T01:00:00Z" },
      { id: "m-order", user_id: USER, sent_at: "2026-11-01T01:00:00Z" },
      { id: "m-other", user_id: OTHER, sent_at: "2026-11-02T02:00:00Z" },
    ],
    parcels: [
      { id: "p-carrier", user_id: USER, shop: "送り主不明", shop_key: "other", status: "shipped", tracking_number: TRACKING, created_at: "2026-11-02T01:00:00Z", updated_at: "2026-11-02T01:00:00Z", last_email_at: "2026-11-02T01:00:00Z" },
      { id: "p-order", user_id: USER, shop: "テスト店", shop_key: "other", status: "ordered", order_number: ORDER, total_amount: 5000, ordered_at: "2026-11-01", created_at: "2026-11-01T01:00:00Z", updated_at: "2026-11-01T01:00:00Z", last_email_at: "2026-11-01T01:00:00Z" },
    ],
    parcel_items: [
      // Another account's row pointing at A comes first, so an unscoped lookup would pick it.
      { id: "i-other", user_id: OTHER, parcel_id: "p-carrier", name: "他人の品目" },
      { id: "i-carrier", user_id: USER, parcel_id: "p-carrier", name: "テスト商品 ブルー" },
    ],
    extractions: [
      { id: "x-carrier", user_id: USER, email_id: "m-carrier", parcel_id: "p-carrier", result: reading({ relevance: "shipped", shop_name: null, tracking_number: sure(TRACKING) }) },
      { id: "x-order", user_id: USER, email_id: "m-order", parcel_id: "p-order", result: reading({ relevance: "order", order_number: sure(ORDER), total_amount: sure(5000) }) },
      { id: "x-other-a", user_id: OTHER, email_id: "m-other", parcel_id: "p-carrier", result: reading({ relevance: "shipped", items: [item("他人の品名")], total_amount: sure(999999) }) },
      { id: "x-other-b", user_id: OTHER, email_id: "m-other", parcel_id: "p-order", result: reading({ relevance: "shipped", total_amount: sure(999999) }) },
    ],
  });
}

const shippingMail = reading({ relevance: "shipped", order_number: sure(ORDER), tracking_number: sure("1234-5678-9012") });

describe("pipeline: every service-role query on parcels, parcel_items and extractions names the user", () => {
  it("when a mail folds a twin parcel into the one with the order number", async () => {
    const db = twinsScenario();
    const out = await processInboundEmail(asAdmin(db), mailOf("2026-11-03T01:00:00Z"), { precomputed: precomputed(shippingMail) });
    expect(out.kind).toBe("processed");
    expect(unscoped(db)).toEqual([]);

    // The scenario reaches every kind of query this test is about.
    expect(db.callsOn("parcels", "update").length).toBeGreaterThanOrEqual(2);
    expect(db.callsOn("parcels", "delete").length).toBeGreaterThanOrEqual(1);
    expect(db.callsOn("parcel_items", "select").length).toBeGreaterThanOrEqual(2);
    expect(db.callsOn("parcel_items", "update").length).toBeGreaterThanOrEqual(1);
    expect(db.callsOn("extractions", "update").length).toBeGreaterThanOrEqual(1);
    expect(db.callsOn("extractions", "select").length).toBeGreaterThanOrEqual(2);
  });

  it("when a mail opens a new parcel with items", async () => {
    const db = new FakeDb();
    const x = reading({ relevance: "order", order_number: sure("ORD-99990000"), items: [item("新しい商品", 1200)], total_amount: sure(1200) });
    const out = await processInboundEmail(asAdmin(db), mailOf("2026-11-03T01:00:00Z"), { precomputed: precomputed(x) });
    expect(out.kind).toBe("processed");
    expect(unscoped(db)).toEqual([]);
    expect(db.callsOn("parcel_items", "select").length).toBeGreaterThanOrEqual(1);
  });

  it("when a mail with items joins an existing parcel", async () => {
    const db = twinsScenario();
    const x = reading({ relevance: "shipped", order_number: sure(ORDER), items: [item("テスト商品 ブルー", 5000)] });
    const out = await processInboundEmail(asAdmin(db), mailOf("2026-11-03T01:00:00Z"), { precomputed: precomputed(x) });
    expect(out.kind).toBe("processed");
    expect(unscoped(db)).toEqual([]);
  });
});

describe("pipeline: another account's rows do not leak into the user's parcel", () => {
  it("leaves rows of another account where they are and out of the merge", async () => {
    const db = twinsScenario();
    await processInboundEmail(asAdmin(db), mailOf("2026-11-03T01:00:00Z"), { precomputed: precomputed(shippingMail) });

    const kept = db.find("parcels", "p-order")!;
    expect(db.find("parcels", "p-carrier")).toBeUndefined();
    // Only the user's own mails count toward the total.
    expect(kept.total_amount).toBe(5000);
    // The other account's rows were not moved onto the user's parcel.
    expect(db.find("extractions", "x-other-a")!.parcel_id).toBe("p-carrier");
    expect(db.find("parcel_items", "i-other")!.parcel_id).toBe("p-carrier");
    // The user's own item did move to the parcel that stays.
    expect(db.find("parcel_items", "i-carrier")!.parcel_id).toBe("p-order");
  });
});
