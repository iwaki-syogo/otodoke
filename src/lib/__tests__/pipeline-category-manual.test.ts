import { describe, expect, it } from "vitest";
import { processInboundEmail } from "@/lib/pipeline";
import { FakeDb, describeQuery, embedScopedToUser, scopedToUser, type Hook, type Query, type Row } from "./fake-db";
import { USER, asConsentingAdmin, item, mailOf, precomputed, reading, sure } from "./pipeline-fixtures";

/**
 * The pipeline with categories and parcels typed in by hand (in-memory database, no API call).
 * A hook plays the user saving in the app between the pipeline's read and its write.
 */

const T = "123456789012";
const T_RAW = "1234-5678-9012";
const SENT = "2026-11-03T01:00:00Z";

const userParcels = (db: FakeDb) => db.rows("parcels").filter((r) => r.user_id === USER);

function parcel(over: Row): Row {
  return { user_id: USER, shop_key: "other", status: "ordered", created_at: "2026-11-01T00:00:00Z", updated_at: "2026-11-01T00:00:00Z", last_email_at: "2026-11-01T00:00:00Z", ...over };
}

const manual = (over: Row = {}) =>
  parcel({
    id: "p-manual",
    source: "manual",
    shop: "手入力の店",
    title: "手入力の品名",
    total_amount: 5000,
    category: "hobby",
    category_source: "user",
    ordered_at: "2026-11-01",
    tracking_number: T,
    ...over,
  });

/** The shop's shipping mail for the same parcel. */
const shopMail = reading({
  relevance: "shipped",
  shop_name: "メールの店",
  order_number: sure("ORD-77770000"),
  tracking_number: sure(T_RAW),
  items: [item("メールの品名", 9999)],
  total_amount: sure(9999),
  expected_date: sure("2026-11-05"),
  category: "food",
});

function run(db: FakeDb, x = shopMail, sentAt = SENT) {
  return processInboundEmail(asConsentingAdmin(db), mailOf(sentAt), { precomputed: precomputed(x) });
}

/** Runs `change` once, right before the first update on parcels: the user saves in between. */
function beforeFirstParcelUpdate(change: (db: FakeDb) => void): Hook {
  let fired = false;
  return (q, db) => {
    if (!fired && q.table === "parcels" && q.op === "update") {
      fired = true;
      change(db);
    }
  };
}

function unscoped(db: FakeDb): string[] {
  return db.calls
    .filter((q: Query) => ["parcels", "parcel_items", "extractions"].includes(q.table) && q.op !== "insert" && q.op !== "upsert")
    .filter((q) => !scopedToUser(q, USER) || (q.table === "parcels" && /parcel_items/.test(q.columns ?? "") && !embedScopedToUser(q, "parcel_items", USER)))
    .map(describeQuery);
}

/** `category_source is distinct from 'user'`, as PostgREST takes it. */
function guardsUserCategory(q: Query): boolean {
  return q.filters.some(
    (f) =>
      (f.method === "or" && /category_source\.is\.null/.test(String(f.args[0])) && /category_source\.neq\.user/.test(String(f.args[0]))) ||
      (f.method === "filter" && f.args[0] === "category_source" && f.args[1] === "isdistinct" && f.args[2] === "user"),
  );
}

const autoCategoryWrites = (db: FakeDb) =>
  db.callsOn("parcels", "update").filter((q) => {
    const v = q.values as Row | undefined;
    return !!v && "category" in v && v.category !== null && v.category_source === "auto";
  });

describe("a mail for a parcel typed in by hand", () => {
  it("joins it: still one parcel, the typed values stay, empty fields are filled", async () => {
    const db = new FakeDb({ parcels: [manual()] });
    await run(db);
    expect(userParcels(db)).toHaveLength(1);
    const m = db.find("parcels", "p-manual")!;
    expect(m.source).toBe("manual");
    expect(m.title).toBe("手入力の品名");
    expect(m.shop).toBe("手入力の店");
    expect(m.total_amount).toBe(5000);
    expect(m.category).toBe("hobby");
    expect(m.category_source).toBe("user");
    expect(m.expected_date).toBe("2026-11-05");
    expect(m.status).toBe("shipped");
    expect(m.order_number).toBe("ORD-77770000");
    expect(m.last_email_at).toBe(SENT);
    expect(db.rows("extractions").map((e) => e.parcel_id)).toEqual(["p-manual"]);
    expect(unscoped(db)).toEqual([]);
  });

  it("fills an empty amount from the mail", async () => {
    const db = new FakeDb({ parcels: [manual({ total_amount: null })] });
    await run(db);
    expect(db.find("parcels", "p-manual")!.total_amount).toBe(9999);
  });

  it("keeps what the user saved between the pipeline's read and its write", async () => {
    const db = new FakeDb({ parcels: [manual({ total_amount: null, category: null, category_source: null, expected_date: null })] });
    db.hooks.push(
      beforeFirstParcelUpdate((d) => {
        Object.assign(d.find("parcels", "p-manual")!, { expected_date: "2026-11-20", total_amount: 7000, category: "beauty", category_source: "user", updated_at: d.tick() });
      }),
    );
    await run(db);
    const m = db.find("parcels", "p-manual")!;
    expect(m.expected_date).toBe("2026-11-20");
    expect(m.total_amount).toBe(7000);
    expect(m.category).toBe("beauty");
    expect(m.category_source).toBe("user");
    // What the user did not touch is still filled in on the retry.
    expect(m.status).toBe("shipped");
  });

  it("finds the typed-in parcel by its number even past the first 1000 parcels", async () => {
    const many = Array.from({ length: 1000 }, (_, i) =>
      parcel({ id: `p-old-${i}`, shop: "過去の店", status: "delivered", tracking_number: `9${String(i).padStart(11, "0")}`, created_at: "2026-01-01T00:00:00Z" }),
    );
    // readAll orders by id: this id sorts after every "p-old-*", so the parcel is only on the second page.
    const ID = "p-zz-manual";
    const db = new FakeDb({ parcels: [...many, manual({ id: ID })] });
    // Record what each lookup page actually returned.
    const pages: Array<{ range: [number, number] | null; ids: unknown[] }> = [];
    const execute = db.execute.bind(db);
    db.execute = (q: Query) => {
      const result = execute(q);
      if (q.table === "parcels" && q.op === "select" && /parcel_items\(name\)/.test(q.columns ?? "")) {
        pages.push({ range: q.range, ids: Array.isArray(result.data) ? (result.data as Row[]).map((r) => r.id) : [] });
      }
      return result;
    };
    await run(db);
    expect(userParcels(db)).toHaveLength(1001);
    expect(db.find("parcels", ID)!.status).toBe("shipped");
    expect(userParcels(db).filter((r) => r.tracking_number === T).map((r) => r.id)).toEqual([ID]);
    // Found, not opened anew and then folded in as a twin (that ends in the same rows).
    expect(db.callsOn("parcels", "insert")).toHaveLength(0);
    // Two pages were read, and the parcel came back on the second one, not the first.
    expect(pages.map((p) => p.range)).toEqual([
      [0, 999],
      [1000, 1999],
    ]);
    expect(pages[0].ids).toHaveLength(1000);
    expect(pages[0].ids).not.toContain(ID);
    expect(pages[1].ids).toEqual([ID]);
  });
});

describe("twins when one of them was typed in by hand", () => {
  /** A carrier mail opened a parcel before the user typed the same number in. */
  function seed() {
    return new FakeDb({
      emails: [{ id: "m-carrier", user_id: USER, sent_at: "2026-11-02T00:00:00Z" }],
      parcels: [
        manual({ expected_date: null, created_at: "2026-11-01T00:00:00Z" }),
        parcel({ id: "p-carrier", shop: "送り主不明", status: "shipped", tracking_number: T, expected_date: "2026-11-06", created_at: "2026-11-02T00:00:00Z" }),
      ],
      extractions: [
        { id: "x-carrier", user_id: USER, email_id: "m-carrier", parcel_id: "p-carrier", result: reading({ relevance: "shipped", shop_name: null, tracking_number: sure(T_RAW), expected_date: sure("2026-11-06") }) },
      ],
    });
  }
  const outForDelivery = reading({ relevance: "out_for_delivery", shop_name: null, tracking_number: sure(T_RAW), expected_date: sure("2026-11-06"), category: null });

  it("keeps the typed-in parcel, moves the mails to it, fills its gaps and deletes the mail parcel", async () => {
    const db = seed();
    await run(db, outForDelivery);
    expect(userParcels(db).map((r) => r.id)).toEqual(["p-manual"]);
    const m = db.find("parcels", "p-manual")!;
    expect(m.source).toBe("manual");
    expect(m.title).toBe("手入力の品名");
    expect(m.shop).toBe("手入力の店");
    expect(m.total_amount).toBe(5000);
    expect(m.category).toBe("hobby");
    expect(m.expected_date).not.toBeNull();
    expect(m.status).toBe("out_for_delivery");
    expect(db.rows("extractions").every((e) => e.parcel_id === "p-manual")).toBe(true);
    expect(unscoped(db)).toEqual([]);
  });
});

describe("categories written by the pipeline", () => {
  const mailParcel = () => parcel({ id: "p-mail", shop: "テスト店", order_number: "ORD-12340000", status: "ordered" });
  const shipped = reading({ relevance: "shipped", order_number: sure("ORD-12340000"), items: [item("お米 5kg", 2000)], category: "food" });

  it("writes an automatic category with a condition that keeps a user's category", async () => {
    const db = new FakeDb({ parcels: [mailParcel()] });
    await run(db, shipped);
    const p = db.find("parcels", "p-mail")!;
    expect(p.category).toBe("food");
    expect(p.category_source).toBe("auto");
    const writes = autoCategoryWrites(db);
    expect(writes.length).toBeGreaterThan(0);
    expect(writes.filter((q) => !guardsUserCategory(q)).map(describeQuery)).toEqual([]);
  });

  it("does not overwrite a category the user picked after the pipeline read the parcel, and still updates the rest", async () => {
    const db = new FakeDb({ parcels: [mailParcel()] });
    db.hooks.push(
      beforeFirstParcelUpdate((d) => {
        Object.assign(d.find("parcels", "p-mail")!, { category: "hobby", category_source: "user", updated_at: d.tick() });
      }),
    );
    await run(db, shipped);
    const p = db.find("parcels", "p-mail")!;
    expect(p.category).toBe("hobby");
    expect(p.category_source).toBe("user");
    expect(p.status).toBe("shipped");
  });
});

describe("twins of two mail parcels: the category", () => {
  /** A has the order number and stays; B was opened by the carrier mail and is folded in. */
  function seed(b: Row) {
    return new FakeDb({
      emails: [
        { id: "m-a", user_id: USER, sent_at: "2026-11-01T00:00:00Z" },
        { id: "m-b", user_id: USER, sent_at: "2026-11-02T00:00:00Z" },
      ],
      parcels: [
        parcel({ id: "p-a", shop: "テスト店", order_number: "ORD-12345678", status: "ordered", created_at: "2026-11-01T00:00:00Z" }),
        parcel({ id: "p-b", shop: "送り主不明", status: "shipped", tracking_number: T, created_at: "2026-11-02T00:00:00Z", ...b }),
      ],
      extractions: [
        // Saved before category existed: no category key at all.
        { id: "x-a", user_id: USER, email_id: "m-a", parcel_id: "p-a", result: withoutCategory(reading({ relevance: "order", order_number: sure("ORD-12345678") })) },
        { id: "x-b", user_id: USER, email_id: "m-b", parcel_id: "p-b", result: withoutCategory(reading({ relevance: "shipped", shop_name: null, tracking_number: sure(T_RAW) })) },
      ],
    });
  }
  function withoutCategory(x: object) {
    const copy = { ...x } as Record<string, unknown>;
    delete copy.category;
    return copy;
  }
  const bothNumbers = reading({ relevance: "shipped", order_number: sure("ORD-12345678"), tracking_number: sure(T_RAW), category: null });

  it("carries the absorbed parcel's user category over to the one that stays", async () => {
    const db = seed({ category: "hobby", category_source: "user" });
    await run(db, bothNumbers);
    expect(db.find("parcels", "p-b")).toBeUndefined();
    const a = db.find("parcels", "p-a")!;
    expect(a.category).toBe("hobby");
    expect(a.category_source).toBe("user");
    expect(unscoped(db)).toEqual([]);
  });

  it("keeps an automatic category that only the absorbed parcel had", async () => {
    const db = seed({ category: "electronics", category_source: "auto" });
    await run(db, bothNumbers);
    const a = db.find("parcels", "p-a")!;
    expect(a.category).toBe("electronics");
    expect(a.category_source).toBe("auto");
  });

  it("does not delete the absorbed parcel when carrying its user category over fails", async () => {
    const db = seed({ category: "hobby", category_source: "user" });
    db.hooks.push((q) => {
      if (q.table === "parcels" && q.op === "update" && (q.values as Row | undefined)?.category_source === "user") return { data: null, error: { message: "update failed" } };
    });
    await expect(run(db, bothNumbers)).rejects.toThrow();
    expect(db.find("parcels", "p-b")).toBeDefined();
    expect(db.callsOn("parcels", "delete")).toHaveLength(0);
  });

  it("does not delete the absorbed parcel when carrying its user category over changes no row", async () => {
    const db = seed({ category: "hobby", category_source: "user" });
    db.hooks.push((q) => {
      if (q.table === "parcels" && q.op === "update" && (q.values as Row | undefined)?.category_source === "user") return { data: [], error: null, count: 0 };
    });
    await run(db, bothNumbers).catch(() => undefined);
    expect(db.find("parcels", "p-b")).toBeDefined();
    expect(db.find("parcels", "p-b")!.category_source).toBe("user");
  });
});
