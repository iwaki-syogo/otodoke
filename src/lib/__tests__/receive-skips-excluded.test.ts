import { describe, expect, it } from "vitest";
import { chooseParcel, type ParcelCandidate } from "@/lib/match";
import { processInboundEmail } from "@/lib/pipeline";
import { FakeDb, type Row } from "./fake-db";
import { OTHER, USER, asConsentingAdmin, item, mailOf, precomputed, reading, sure } from "./pipeline-fixtures";

/**
 * A parcel the person took out of the list (a row in parcel_exclusions) is found by its numbers only. A softer match
 * (the same day, or the same item from the same shop) must not file a new mail into it, or a real new order would
 * vanish into a parcel nobody sees. Shops, items and numbers are all made up.
 */

const NAME = "とても長い名前の商品ひとつ目";
const ORDER = "ORD-12345678";
const NOW = new Date("2026-11-10T00:00:00Z");

const mark = (parcelId: string, user = USER): Row => ({ parcel_id: parcelId, user_id: user, kind: "user", from_domain: "shop.example", relevance: "order", counted: true, created_at: "2026-11-09T00:00:00Z" });

function world(marks: Row[]): FakeDb {
  const at = new Date().toISOString();
  return new FakeDb({
    parcels: [{ id: "p-old", user_id: USER, shop: "テスト店", shop_key: "other", status: "ordered", source: "mail", order_number: ORDER, created_at: at, updated_at: at, last_email_at: at }],
    parcel_items: [{ id: "i-old", user_id: USER, parcel_id: "p-old", name: NAME }],
    parcel_exclusions: marks,
  });
}

/** A shipping mail with no number, naming the same item at the same shop: only the soft match can bring it to p-old. */
// The item's evidence is a line the test mail really contains, or the pipeline drops the item before matching.
const softMail = () =>
  reading({ relevance: "shipped", shop_key: "other", shop_name: "テスト店", items: [{ ...item(NAME), evidence: "根拠の行" }] });
const receive = (db: FakeDb, x: ReturnType<typeof reading>) => processInboundEmail(asConsentingAdmin(db), mailOf(new Date().toISOString()), { precomputed: precomputed(x) });

describe("receiving a mail: a parcel taken out of the list is not matched softly", () => {
  it("R1 a mail with the same item and shop opens a new parcel instead of joining the marked one", async () => {
    const db = world([mark("p-old")]);
    await receive(db, softMail());
    const parcels = db.rows("parcels");
    expect(parcels).toHaveLength(2);
    const fresh = parcels.find((p) => p.id !== "p-old")!;
    expect(fresh.order_number ?? null).toBeNull();
    expect(db.rows("extractions").every((e) => e.parcel_id === fresh.id)).toBe(true);
    expect(db.rows("parcel_items").filter((i) => i.parcel_id === "p-old")).toHaveLength(1);
  });

  it("R2 the same mail still joins a parcel that has no mark", async () => {
    const db = world([]);
    await receive(db, softMail());
    expect(db.rows("parcels")).toHaveLength(1);
    expect(db.rows("extractions").every((e) => e.parcel_id === "p-old")).toBe(true);
  });

  it("R2b another person's mark on the same parcel id does not hide it (only this user's marks are read)", async () => {
    const db = world([mark("p-old", OTHER)]);
    await receive(db, softMail());
    expect(db.rows("parcels")).toHaveLength(1);
  });

  it("R3 the order number still brings a mail to a parcel that has a mark", async () => {
    const db = world([mark("p-old")]);
    await receive(db, reading({ relevance: "shipped", shop_key: "other", shop_name: "テスト店", order_number: sure(ORDER) }));
    expect(db.rows("parcels")).toHaveLength(1);
    expect(db.rows("extractions").every((e) => e.parcel_id === "p-old")).toBe(true);
  });

  it("R4 a mail that matches nothing does not read the marks at all", async () => {
    const db = world([mark("p-old")]);
    await receive(db, reading({ relevance: "shipped", shop_key: "other", shop_name: "べつの店", items: [item("まったく別の商品の名前です")] }));
    expect(db.calls.filter((q) => q.table === "parcel_exclusions")).toHaveLength(0);
  });

  it("R5 when the marks cannot be read (the table is missing), the mail is not filed into a parcel", async () => {
    const db = world([mark("p-old")]);
    db.hooks.push((q) => (q.table === "parcel_exclusions" ? { data: null, error: { message: 'relation "public.parcel_exclusions" does not exist' } } : undefined));
    await expect(receive(db, softMail())).rejects.toThrow(/parcels lookup failed: parcel_exclusions lookup failed: relation "public.parcel_exclusions" does not exist/);
    expect(db.rows("parcels")).toHaveLength(1);
    expect(db.rows("extractions").filter((e) => e.parcel_id === "p-old")).toHaveLength(0);
  });
});

function candidate(over: Partial<ParcelCandidate> = {}): ParcelCandidate {
  return {
    id: "p1", user_id: "u", shop: "テスト店", shop_key: "amazon", status: "ordered", source: "mail", order_number: null, tracking_number: null,
    expected_date: null, created_at: "2026-11-09T00:00:00Z", updated_at: "2026-11-09T00:00:00Z", itemNames: [], excluded: null, ...over,
  } as unknown as ParcelCandidate;
}
const out = { kind: "rule", from_domain: "shop.example", relevance: "order", counted: false };

describe("chooseParcel: both soft matches skip a marked parcel, the numbers do not", () => {
  it("U1 the same shop and the same day does not find it", () => {
    const x = reading({ shop_key: "amazon", order_number: sure("ZZ-9999-0000"), expected_date: sure("2026-11-12") });
    const shown = candidate({ tracking_number: "123456789012", expected_date: "2026-11-12" });
    expect(chooseParcel([shown], x, NOW)?.id).toBe("p1");
    expect(chooseParcel([{ ...shown, excluded: out }], x, NOW)).toBeNull();
  });

  it("U2 a likely item name does not find it", () => {
    const x = reading({ relevance: "shipped", shop_key: "amazon", shop_name: "テスト店", items: [item(NAME)] });
    const shown = candidate({ itemNames: [NAME] });
    expect(chooseParcel([shown], x, NOW)?.id).toBe("p1");
    expect(chooseParcel([{ ...shown, excluded: out }], x, NOW)).toBeNull();
  });

  it("U3 the order number and the tracking number still find it", () => {
    expect(chooseParcel([candidate({ order_number: "A-1111-2222", excluded: out })], reading({ order_number: sure("A-1111-2222") }), NOW)?.id).toBe("p1");
    expect(chooseParcel([candidate({ tracking_number: "123456789012", excluded: out })], reading({ tracking_number: sure("1234-5678-9012") }), NOW)?.id).toBe("p1");
  });

  it("U4 a candidate with no mark field at all is matched as before", () => {
    const { excluded: _gone, ...bare } = candidate({ itemNames: [NAME] });
    void _gone;
    const x = reading({ relevance: "shipped", shop_key: "amazon", shop_name: "テスト店", items: [item(NAME)] });
    expect(chooseParcel([bare as ParcelCandidate], x, NOW)?.id).toBe("p1");
  });
});
