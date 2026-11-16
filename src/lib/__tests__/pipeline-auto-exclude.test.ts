import { afterEach, describe, expect, it, vi } from "vitest";
import { processInboundEmail } from "@/lib/pipeline";
import { FakeDb, type Row } from "./fake-db";
import { USER, asConsentingAdmin, mailOf, precomputed, reading, sure, none } from "./pipeline-fixtures";

/**
 * The app takes a parcel out of the list by itself (kind `rule`) only for an order or payment notice with no sign of
 * arrival, from a sender whose parcels the person took out by hand twice already, and puts it back as soon as a
 * mail shows it is on its way. Each row is one made-up scenario (H1-H14 of the design) that must never hide a
 * parcel that is coming. Shops, domains and numbers are all made up.
 */

const AMAZON = "amazon.example";
const FLEA = "flea.example";
const ORDER_A = "A-1111-2222";
const ORDER_B = "B-3333-4444";
const T = "123456789012";
const T_RAW = "1234-5678-9012";

const sent = (n: number) => `2026-11-03T0${n}:00:00Z`;

/** Marks the person made by hand: `count` hidden parcels of one sender and kind. */
function userMarks(count: number, over: Row = {}): { parcels: Row[]; parcel_exclusions: Row[] } {
  const base = { from_domain: AMAZON, relevance: "order", counted: true, ...over };
  const ids = Array.from({ length: count }, (_, i) => `hidden-${base.from_domain}-${i}`);
  return {
    parcels: ids.map((id, i) => ({ id, user_id: USER, shop: "むかしの店", shop_key: "other", status: "ordered", source: "mail", order_number: `OLD-${i}-${String(base.from_domain)}`, last_email_at: "2026-10-01T00:00:00Z" })),
    parcel_exclusions: ids.map((id) => ({ parcel_id: id, user_id: USER, kind: "user", created_at: "2026-10-02T00:00:00Z", ...base })),
  };
}

const order = (over: Parameters<typeof reading>[0] = {}) => reading({ relevance: "order", shop_key: "amazon", shop_name: "テスト店", order_number: sure(ORDER_A), ...over });
const shipment = (over: Parameters<typeof reading>[0] = {}) => reading({ relevance: "shipped", shop_key: "amazon", shop_name: "テスト店", order_number: sure(ORDER_A), ...over });

function run(db: FakeDb, x: ReturnType<typeof reading>, at: number, from = `shop@${AMAZON}`, subject?: string) {
  const mail = { ...mailOf(sent(at)), from, ...(subject ? { subject } : {}) };
  return processInboundEmail(asConsentingAdmin(db), mail, { precomputed: precomputed(x) });
}

const parcelOf = (db: FakeDb, orderNumber: string) => db.rows("parcels").find((p) => p.order_number === orderNumber)!;
const markOf = (db: FakeDb, parcel: Row | undefined) => db.rows("parcel_exclusions").find((m) => m.parcel_id === parcel?.id);
const markCalls = (db: FakeDb) => db.rpcCalls.filter((c) => c.name === "mark_rule_exclusion");

afterEach(() => vi.restoreAllMocks());

describe("H1 the Amazon way: taken out at the order, back at the shipment", () => {
  it("hides the order, shows it again at a shipment mail with no tracking number, and keeps it shown after delivery", async () => {
    const db = new FakeDb(userMarks(2));
    await run(db, order(), 1);
    expect(markOf(db, parcelOf(db, ORDER_A))?.kind).toBe("rule");

    await run(db, shipment(), 2);
    const parcel = parcelOf(db, ORDER_A);
    expect(markOf(db, parcel)).toBeUndefined();
    expect(parcel.status).toBe("shipped");

    await run(db, reading({ relevance: "delivered", shop_key: "amazon", order_number: sure(ORDER_A) }), 3);
    expect(markOf(db, parcelOf(db, ORDER_A))).toBeUndefined();
    expect(parcelOf(db, ORDER_A).status).toBe("delivered");
  });
});

describe("H2 a parcel coming to the person is not taken out by a shipment", () => {
  it("makes no mark for a shipment of a sender whose shipments were taken out twice", async () => {
    const db = new FakeDb(userMarks(2, { from_domain: FLEA, relevance: "shipped" }));
    await run(db, shipment({ order_number: sure("F-5555-6666"), shop_key: "other" }), 1, `seller@${FLEA}`);
    expect(db.rows("parcels").some((p) => p.order_number === "F-5555-6666")).toBe(true);
    expect(markCalls(db)).toHaveLength(0);
    expect(db.rows("parcel_exclusions").filter((m) => m.kind === "rule")).toHaveLength(0);
  });
});

describe("H3-H5b a sign of arrival keeps the order in the list", () => {
  const signs: Array<[string, Parameters<typeof reading>[0]]> = [
    ["H3 needs someone at home (cash on delivery)", { requires_presence: sure(true) }],
    ["H4 a delivery date it is sure of", { expected_date: sure("2026-11-20") }],
    ["H5 a tracking number whose quotation is not in the mail", { tracking_number: { value: T, evidence: "メールに無い行", confidence: 0.95 } }],
    ["H5b a carrier", { carrier: sure("テスト運輸") }],
    ["H5b a slip's item", { package_description: sure("衣料品") }],
    ["H5b the words of a delivery date", { expected_text: "根拠の行" }],
    ["H5b a time window the app is unsure of (0.3)", { expected_window_start: { value: "14:00", evidence: "根拠の行", confidence: 0.3 } }],
    ["H5b an unsure carrier (0.3)", { carrier: { value: "テスト運輸", evidence: "根拠の行", confidence: 0.3 } }],
  ];
  it.each(signs)("%s", async (_name, over) => {
    const db = new FakeDb(userMarks(2));
    await run(db, order(over), 1);
    expect(parcelOf(db, ORDER_A)).toBeDefined();
    expect(markOf(db, parcelOf(db, ORDER_A))).toBeUndefined();
  });

  it("H4b a delivery date it is unsure of (0.3) is not a sign: the order is taken out", async () => {
    const db = new FakeDb(userMarks(2));
    await run(db, order({ expected_date: { value: "2026-11-20", evidence: "根拠の行", confidence: 0.3 } }), 1);
    expect(markOf(db, parcelOf(db, ORDER_A))?.kind).toBe("rule");
  });
});

describe("H6 nothing says it is coming: taken out (the positive case)", () => {
  it("makes one rule mark, with the sender and kind it was counted by", async () => {
    const db = new FakeDb(userMarks(2));
    await run(db, order(), 1);
    expect(markCalls(db)).toHaveLength(1);
    expect(markCalls(db)[0].args).toEqual({ p_user: USER, p_parcel_id: parcelOf(db, ORDER_A).id, p_from_domain: AMAZON, p_relevance: "order" });
    expect(markOf(db, parcelOf(db, ORDER_A))).toMatchObject({ kind: "rule", from_domain: AMAZON, relevance: "order" });
  });
  it("also a payment notice, but not a shipment of the same sender", async () => {
    const db = new FakeDb(userMarks(2, { relevance: "payment" }));
    await run(db, order({ relevance: "payment" }), 1);
    expect(markOf(db, parcelOf(db, ORDER_A))?.kind).toBe("rule");
  });
});

describe("H7 only a mail to the reader brings it back", () => {
  it("H7 the sender's own copy (inbound false) leaves it hidden", async () => {
    const db = new FakeDb(userMarks(2));
    await run(db, order(), 1);
    await run(db, shipment({ tracking_number: sure(T_RAW), inbound: sure(false) }), 2);
    expect(markOf(db, parcelOf(db, ORDER_A))?.kind).toBe("rule");
  });
  it("H7b a later notice with a sure delivery date brings it back", async () => {
    const db = new FakeDb(userMarks(2));
    await run(db, order(), 1);
    await run(db, order({ relevance: "payment", expected_date: sure("2026-11-20") }), 2);
    expect(markOf(db, parcelOf(db, ORDER_A))).toBeUndefined();
  });
  it("a payment notice naming a tracking number brings it back", async () => {
    const db = new FakeDb(userMarks(2));
    await run(db, order(), 1);
    await run(db, order({ relevance: "payment", tracking_number: sure(T_RAW) }), 2);
    expect(markOf(db, parcelOf(db, ORDER_A))).toBeUndefined();
  });
  it("the mark comes off before the update: when the update then fails, the parcel is shown", async () => {
    const db = new FakeDb(userMarks(2));
    await run(db, order(), 1);
    const rpc = db.rpc.bind(db);
    db.rpc = ((name: string, args: unknown) => (name === "update_mail_parcel" ? Promise.resolve({ data: null, error: { message: "boom" } }) : rpc(name, args))) as typeof db.rpc;
    await expect(run(db, shipment(), 2)).rejects.toThrow();
    expect(markOf(db, parcelOf(db, ORDER_A))).toBeUndefined();
  });
  it("a person's own mark is never taken off by a mail", async () => {
    const db = new FakeDb({ ...userMarks(1, {}), parcels: [{ id: "mine", user_id: USER, shop: "店", shop_key: "other", status: "ordered", source: "mail", order_number: ORDER_A, last_email_at: "2026-10-01T00:00:00Z" }], parcel_exclusions: [{ parcel_id: "mine", user_id: USER, kind: "user", from_domain: AMAZON, relevance: "order", counted: true }] });
    await run(db, shipment({ tracking_number: sure(T_RAW) }), 2);
    expect(db.find("parcels", "mine")!.status).toBe("shipped");
    expect(markOf(db, { id: "mine" })?.kind).toBe("user");
  });
});

describe("H8 it takes out only where nothing of the sender is shown", () => {
  it("H8 a shown parcel of the same sender stops it", async () => {
    const seed = userMarks(2);
    const db = new FakeDb({
      ...seed,
      parcels: [...seed.parcels, { id: "shown", user_id: USER, shop: "店", shop_key: "other", status: "delivered", source: "mail", order_number: "SHOWN-1", last_email_at: "2026-10-05T00:00:00Z" }],
      emails: [{ id: "e-shown", user_id: USER, from_domain: AMAZON }],
      extractions: [{ id: "x-shown", user_id: USER, email_id: "e-shown", parcel_id: "shown", result: reading() }],
    });
    await run(db, order(), 1);
    expect(markCalls(db)).toHaveLength(0);
  });
  it("H8b a domain that stands for many shops is never taken out by itself", async () => {
    const db = new FakeDb(userMarks(2, { from_domain: "mail.yahoo.co.jp" }));
    await run(db, order(), 1, "store@mail.yahoo.co.jp");
    expect(markCalls(db)).toHaveLength(0);
  });
});

describe("H9 one mail, two orders", () => {
  it("hides both, and each comes back at its own shipment", async () => {
    const db = new FakeDb(userMarks(2));
    const other = { order_number: sure(ORDER_B), items: [], category: null, total_amount: none, expected_date: none, expected_date_end: none, expected_text: null };
    await run(db, order({ other_orders: [other] }), 1);
    expect(markOf(db, parcelOf(db, ORDER_A))?.kind).toBe("rule");
    expect(markOf(db, parcelOf(db, ORDER_B))?.kind).toBe("rule");

    await run(db, shipment(), 2);
    expect(markOf(db, parcelOf(db, ORDER_A))).toBeUndefined();
    expect(markOf(db, parcelOf(db, ORDER_B))?.kind).toBe("rule");

    await run(db, shipment({ order_number: sure(ORDER_B) }), 3);
    expect(markOf(db, parcelOf(db, ORDER_B))).toBeUndefined();
  });
});

describe("H10 an older cancellation read late does not bring it back", () => {
  it("leaves the mark, whatever the re-read says about the status", async () => {
    const db = new FakeDb(userMarks(2));
    await run(db, order(), 5);
    await run(db, reading({ relevance: "cancelled", shop_key: "amazon", order_number: sure(ORDER_A) }), 2);
    expect(markOf(db, parcelOf(db, ORDER_A))?.kind).toBe("rule");
  });
});

describe("H12 putting it back stops the sender", () => {
  it("makes no mark for the next order of a sender whose parcel the person put back", async () => {
    const db = new FakeDb(userMarks(2));
    await run(db, order(), 1);
    db.tables.parcel_exclusions = db.rows("parcel_exclusions").filter((m) => m.parcel_id !== parcelOf(db, ORDER_A).id);
    await run(db, order({ order_number: sure(ORDER_B) }), 2);
    expect(markOf(db, parcelOf(db, ORDER_B))).toBeUndefined();
  });
});

describe("H13 a shipment that lands between creating and marking (B-03br)", () => {
  it("(a) between the create and the mark: the mark's own statement sees the parcel as it is then, and puts none", async () => {
    const db = new FakeDb(userMarks(2));
    const rpc = db.rpc.bind(db);
    db.rpc = ((name: string, args: { p_parcel_id: string }) => {
      if (name === "mark_rule_exclusion") Object.assign(db.find("parcels", args.p_parcel_id)!, { status: "shipped", tracking_number: T, carrier: "テスト運輸" });
      return rpc(name, args);
    }) as typeof db.rpc;
    await run(db, order(), 1);
    expect(markOf(db, parcelOf(db, ORDER_A))).toBeUndefined();
    expect(parcelOf(db, ORDER_A).status).toBe("shipped");
  });
  it("(b) a mark that lands after the shipment mail's check and before its update is taken off after the update", async () => {
    const db = new FakeDb(userMarks(1));
    await run(db, order(), 1);
    expect(markOf(db, parcelOf(db, ORDER_A))).toBeUndefined();
    const rpc = db.rpc.bind(db);
    db.rpc = ((name: string, args: { p_parcel_id: string }) => {
      if (name === "update_mail_parcel") db.rows("parcel_exclusions").push({ parcel_id: args.p_parcel_id, user_id: USER, kind: "rule", from_domain: AMAZON, relevance: "order", counted: false });
      return rpc(name, args);
    }) as typeof db.rpc;
    await run(db, shipment(), 2);
    expect(markOf(db, parcelOf(db, ORDER_A))).toBeUndefined();
    expect(parcelOf(db, ORDER_A).status).toBe("shipped");
  });
});

describe("H14 a shipment whose kind was not quoted still brings it back", () => {
  it("shows the parcel without moving its status", async () => {
    const db = new FakeDb(userMarks(2));
    await run(db, order(), 1);
    await run(db, { ...shipment(), relevance_evidence: "メールに無い行" }, 2);
    expect(markOf(db, parcelOf(db, ORDER_A))).toBeUndefined();
    expect(parcelOf(db, ORDER_A).status).toBe("ordered");
  });
});

describe("the rest of the rule: one thing short of it and nothing is taken out", () => {
  const cases: Array<[string, () => { db: FakeDb; from?: string; subject?: string; x?: ReturnType<typeof reading> }]> = [
    ["only one mark by hand", () => ({ db: new FakeDb(userMarks(1)) })],
    ["the marks were of another kind of mail", () => ({ db: new FakeDb(userMarks(2, { relevance: "shipped" })) })],
    ["the marks were not counted (a sample, a sender with no domain)", () => ({ db: new FakeDb(userMarks(2, { counted: false })) })],
    ["a domain many people use", () => ({ db: new FakeDb(userMarks(2, { from_domain: "gmail.com" })), from: "someone@gmail.com" })],
    ["a mail forwarded by hand", () => ({ db: new FakeDb(userMarks(2)), subject: "Fwd: ご注文の確認" })],
    ["a shipment", () => ({ db: new FakeDb(userMarks(2)), x: shipment() })],
  ];
  it.each(cases)("%s", async (_name, make) => {
    const { db, from, subject, x } = make();
    await run(db, x ?? order(), 1, from ?? `shop@${AMAZON}`, subject);
    expect(markCalls(db)).toHaveLength(0);
  });

  it("the person's own domain", async () => {
    const db = new FakeDb(userMarks(2));
    (db as unknown as { auth: unknown }).auth = { admin: { getUserById: async () => ({ data: { user: { email: `me@${AMAZON}` } }, error: null }) } };
    await run(db, order(), 1);
    expect(markCalls(db)).toHaveLength(0);
  });

  it("a public sample mail", async () => {
    const db = new FakeDb(userMarks(2));
    await processInboundEmail(asConsentingAdmin(db), { ...mailOf(sent(1)), from: `shop@${AMAZON}` }, { precomputed: precomputed(order()), publicSample: true });
    expect(markCalls(db)).toHaveLength(0);
  });

  it("U19 a failed write leaves the parcel shown, logs one line and does not throw", async () => {
    const db = new FakeDb(userMarks(2));
    const rpc = db.rpc.bind(db);
    db.rpc = ((name: string, args: unknown) => (name === "mark_rule_exclusion" ? Promise.resolve({ data: null, error: { message: "boom" } }) : rpc(name, args))) as typeof db.rpc;
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const outcome = await run(db, order(), 1);
    expect(outcome.kind).toBe("processed");
    expect(markOf(db, parcelOf(db, ORDER_A))).toBeUndefined();
    expect(log.mock.calls.filter((c) => String(c[0]).startsWith("auto exclusion failed"))).toHaveLength(1);
  });
});

describe("merging two parcels of one tracking number", () => {
  const base = { user_id: USER, shop_key: "other", status: "shipped", created_at: "2026-11-01T00:00:00Z", updated_at: "2026-11-01T00:00:00Z", last_email_at: "2026-11-01T00:00:00Z", tracking_number: T };
  const mail = () => reading({ relevance: "out_for_delivery", shop_name: null, tracking_number: sure(T_RAW) });
  const user = (id: string, over: Row = {}) => ({ parcel_id: id, user_id: USER, kind: "user", from_domain: AMAZON, relevance: "order", counted: true, ...over });
  const rule = (id: string) => ({ parcel_id: id, user_id: USER, kind: "rule", from_domain: AMAZON, relevance: "order", counted: false });

  it("U17b a typed-in parcel that stays takes no mark, whether the folded one had the person's or the app's", async () => {
    for (const folded of [user("p-mail"), rule("p-mail")]) {
      const db = new FakeDb({
        parcels: [
          { ...base, id: "p-manual", source: "manual", shop: "手入力の店", status: "ordered" },
          { ...base, id: "p-mail", shop: "送り主不明", created_at: "2026-11-02T00:00:00Z" },
        ],
        parcel_exclusions: [folded],
      });
      await run(db, mail(), 1);
      expect(db.find("parcels", "p-mail")).toBeUndefined();
      expect(db.find("parcels", "p-manual")).toBeDefined();
      expect(db.rows("parcel_exclusions")).toHaveLength(0);
    }
  });

  it("U17 what the person said moves to the kept parcel before the other is deleted", async () => {
    const db = new FakeDb({
      parcels: [
        { ...base, id: "p-keep", shop: "テスト店", order_number: ORDER_A },
        { ...base, id: "p-fold", shop: "送り主不明", created_at: "2026-11-02T00:00:00Z" },
      ],
      parcel_exclusions: [user("p-fold", { from_domain: "shop.example", relevance: "payment" })],
    });
    await run(db, mail(), 1);
    expect(db.find("parcels", "p-fold")).toBeUndefined();
    expect(db.rows("parcel_exclusions")).toEqual([expect.objectContaining({ parcel_id: "p-keep", kind: "user", from_domain: "shop.example", relevance: "payment", counted: true })]);
    const written = db.calls.findIndex((q) => q.table === "parcel_exclusions" && q.op === "insert");
    const deleted = db.calls.findIndex((q) => q.table === "parcels" && q.op === "delete");
    expect(written).toBeGreaterThanOrEqual(0);
    expect(written).toBeLessThan(deleted);
  });

  it("U17c the person's word turns the kept parcel's automatic mark into theirs", async () => {
    const db = new FakeDb({
      parcels: [
        { ...base, id: "p-keep", shop: "テスト店", order_number: ORDER_A },
        { ...base, id: "p-fold", shop: "送り主不明", created_at: "2026-11-02T00:00:00Z" },
      ],
      parcel_exclusions: [rule("p-keep"), user("p-fold")],
    });
    await run(db, mail(), 1);
    expect(db.rows("parcel_exclusions")).toEqual([expect.objectContaining({ parcel_id: "p-keep", kind: "user", counted: true })]);
  });

  it("U18 the kept parcel's automatic mark comes off when a folded parcel was shown", async () => {
    const db = new FakeDb({
      parcels: [
        { ...base, id: "p-keep", shop: "テスト店", order_number: ORDER_A },
        { ...base, id: "p-fold", shop: "送り主不明", created_at: "2026-11-02T00:00:00Z" },
      ],
      parcel_exclusions: [rule("p-keep")],
    });
    await run(db, mail(), 1);
    expect(db.find("parcels", "p-fold")).toBeUndefined();
    expect(db.rows("parcel_exclusions")).toHaveLength(0);
  });

  it("a failed carry leaves both parcels apart and the person's mark on the parcel that goes", async () => {
    const db = new FakeDb({
      parcels: [
        { ...base, id: "p-keep", shop: "テスト店", order_number: ORDER_A },
        { ...base, id: "p-fold", shop: "送り主不明", created_at: "2026-11-02T00:00:00Z" },
      ],
      parcel_exclusions: [user("p-fold")],
    });
    db.hooks.push((q) => (q.table === "parcel_exclusions" && q.op === "insert" ? { data: null, error: { message: "boom" } } : undefined));
    vi.spyOn(console, "error").mockImplementation(() => {});
    await run(db, mail(), 1);
    expect(db.find("parcels", "p-fold")).toBeDefined();
    expect(db.rows("parcel_exclusions").map((m) => m.parcel_id)).toEqual(["p-fold"]);
  });
});
