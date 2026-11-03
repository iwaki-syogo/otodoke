import { describe, expect, it } from "vitest";
import { processInboundEmail } from "@/lib/pipeline";
import { categoryForTwins } from "@/lib/match/category";
import { FakeDb, type Hook, type Query, type Row } from "./fake-db";
import { USER, asAdmin, item, mailOf, precomputed, reading, sure } from "./pipeline-fixtures";

/**
 * The person saves in the app while a mail is being merged (in-memory database, no API call).
 * [S2] absorbTwins keeps what they saved on either parcel; [Codex-H1] the newer of two user
 * categories wins; [Codex-M3] a typed-in parcel that keeps changing fails the mail for a retry;
 * [SEC-S1] the embedded mails of the twin merge are limited to the user.
 */

const T = "123456789012";
const T_RAW = "1234-5678-9012";
const SENT = "2026-11-03T01:00:00Z";

function parcel(over: Row): Row {
  return { user_id: USER, shop_key: "other", status: "ordered", created_at: "2026-11-01T00:00:00Z", updated_at: "2026-11-01T00:00:00Z", last_email_at: "2026-11-01T00:00:00Z", ...over };
}

function run(db: FakeDb, x: ReturnType<typeof reading>, mail = mailOf(SENT)) {
  return processInboundEmail(asAdmin(db), mail, { precomputed: precomputed(x) });
}

/** Runs `change` once, when the twin merge reads the mails of the parcels: after it read the parcels. */
function afterTwinsAreRead(change: (db: FakeDb) => void): Hook {
  let fired = false;
  return (q, db) => {
    if (!fired && q.table === "extractions" && q.op === "select" && /emails/.test(q.columns ?? "")) {
      fired = true;
      change(db);
    }
  };
}

/** Runs `change` once, right before the first delete on parcels. */
function beforeFirstParcelDelete(change: (db: FakeDb) => void): Hook {
  let fired = false;
  return (q, db) => {
    if (!fired && q.table === "parcels" && q.op === "delete") {
      fired = true;
      change(db);
    }
  };
}

describe("[S2] the person saves while twins are being merged", () => {
  it("keeps a date they saved on the typed-in parcel that stays", async () => {
    const db = new FakeDb({
      emails: [{ id: "m-carrier", user_id: USER, sent_at: "2026-11-02T00:00:00Z" }],
      parcels: [
        parcel({ id: "p-manual", source: "manual", shop: "手入力の店", title: "手入力の品名", total_amount: 5000, category: "hobby", category_source: "user", tracking_number: T }),
        parcel({ id: "p-carrier", shop: "送り主不明", status: "shipped", tracking_number: T, expected_date: "2026-11-06", created_at: "2026-11-02T00:00:00Z" }),
      ],
      extractions: [
        { id: "x-carrier", user_id: USER, email_id: "m-carrier", parcel_id: "p-carrier", result: reading({ relevance: "shipped", shop_name: null, tracking_number: sure(T_RAW), expected_date: sure("2026-11-06") }) },
      ],
    });
    db.hooks.push(
      afterTwinsAreRead((d) => {
        Object.assign(d.find("parcels", "p-manual")!, { expected_date: "2026-11-20", updated_at: d.tick() });
      }),
    );
    await run(db, reading({ relevance: "out_for_delivery", shop_name: null, tracking_number: sure(T_RAW) }));

    const kept = db.find("parcels", "p-manual")!;
    expect(kept.expected_date).toBe("2026-11-20");
    expect(kept.title).toBe("手入力の品名");
    expect(kept.status).toBe("out_for_delivery");
    // The retry still merged them.
    expect(db.find("parcels", "p-carrier")).toBeUndefined();
    expect(db.rows("extractions").every((e) => e.parcel_id === "p-manual")).toBe(true);
  });

  it("does not delete a parcel the person gave a category after it was read, and carries it over on the retry", async () => {
    const db = twoMailParcels({});
    db.hooks.push(
      afterTwinsAreRead((d) => {
        Object.assign(d.find("parcels", "p-b")!, { category: "hobby", category_source: "user", updated_at: d.tick() });
      }),
    );
    await run(db, bothNumbers);
    expect(db.find("parcels", "p-b")).toBeUndefined();
    const a = db.find("parcels", "p-a")!;
    expect(a.category).toBe("hobby");
    expect(a.category_source).toBe("user");
  });
});

/** A has the order number and stays; B was opened by the carrier mail and is folded in. */
function twoMailParcels(b: Row) {
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
      { id: "x-a", user_id: USER, email_id: "m-a", parcel_id: "p-a", result: reading({ relevance: "order", order_number: sure("ORD-12345678") }) },
      { id: "x-b", user_id: USER, email_id: "m-b", parcel_id: "p-b", result: reading({ relevance: "shipped", shop_name: null, tracking_number: sure(T_RAW) }) },
    ],
  });
}
const bothNumbers = reading({ relevance: "shipped", order_number: sure("ORD-12345678"), tracking_number: sure(T_RAW), category: null });

describe("[Codex-H1] two user categories on twins", () => {
  it("keeps the one the person picked last when they change the absorbed parcel after its category was carried over", async () => {
    const db = twoMailParcels({ category: "hobby", category_source: "user" });
    // The carry-over of hobby has landed on A; now, before B is deleted, the person picks beauty on B.
    db.hooks.push(
      beforeFirstParcelDelete((d) => {
        Object.assign(d.find("parcels", "p-b")!, { category: "beauty", category_source: "user", updated_at: d.tick() });
      }),
    );
    await run(db, bothNumbers);
    expect(db.find("parcels", "p-b")).toBeUndefined();
    const a = db.find("parcels", "p-a")!;
    expect(a.category).toBe("beauty");
    expect(a.category_source).toBe("user");
  });

  // [N6] updated_at says when a row last changed, not when its category was picked.
  const T1 = "2026-11-03T00:00:01.000Z";
  const T2 = "2026-11-03T00:00:02.000Z";
  const T3 = "2026-11-03T00:00:03.000Z";
  const user = (id: string, category: string, updated_at?: string) => ({ id, category, category_source: "user", updated_at });
  const none = { category: null, category_source: null };

  it("[N6] (a) prefers the kept parcel's choice on a first try, even when the absorbed row changed later", () => {
    expect(categoryForTwins(user("a", "hobby", T1), [user("b", "beauty", T2)], none).category).toBe("hobby");
    expect(categoryForTwins(user("a", "hobby"), [user("b", "beauty")], none).category).toBe("hobby");
    expect(categoryForTwins({ id: "a", category: "food", category_source: "auto", updated_at: T3 }, [user("b", "beauty", T1)], none)).toEqual({
      category: "beauty",
      category_source: "user",
    });
  });

  it("[N6] (b) on a retry prefers a row that moved since the merge last saw it", () => {
    // [Codex-F1] What the merge knew is each row's category, not its time.
    const knew = (a: string, b: string) =>
      new Map([
        ["a", { category: a, category_source: "user" }],
        ["b", { category: b, category_source: "user" }],
      ]);
    // Only the absorbed row's category changed: the person changed it while it was being merged.
    expect(categoryForTwins(user("a", "hobby", T1), [user("b", "beauty", T2)], none, knew("hobby", "food")).category).toBe("beauty");
    // Neither changed: the kept parcel's, as on a first try.
    expect(categoryForTwins(user("a", "hobby", T1), [user("b", "beauty", T1)], none, knew("hobby", "beauty")).category).toBe("hobby");
    // Both changed: the row changed later.
    expect(categoryForTwins(user("a", "hobby", T3), [user("b", "beauty", T2)], none, knew("food", "food")).category).toBe("hobby");
    expect(categoryForTwins(user("a", "hobby", T2), [user("b", "beauty", T3)], none, knew("food", "food")).category).toBe("beauty");
  });

  it("[Codex-F1] on a retry does not count a row whose status and time moved but whose category did not", () => {
    const knew = new Map([
      ["a", { category: "hobby", category_source: "user" }],
      ["b", { category: "beauty", category_source: "user" }],
    ]);
    // B was marked delivered meanwhile: newer, with the category the merge knew.
    expect(categoryForTwins(user("a", "hobby", T1), [user("b", "beauty", T3)], none, knew).category).toBe("hobby");
  });

  it("[Codex-F1] keeps the kept parcel's user category when the absorbed one only changed its status before being deleted", async () => {
    const db = twoMailParcels({ category: "beauty", category_source: "user" });
    Object.assign(db.find("parcels", "p-a")!, { category: "hobby", category_source: "user" });
    // After the first read, B is marked delivered: its delete misses and the merge retries.
    db.hooks.push(
      afterTwinsAreRead((d) => {
        Object.assign(d.find("parcels", "p-b")!, { status: "delivered", updated_at: d.tick() });
      }),
    );
    await run(db, bothNumbers);
    expect(db.callsOn("parcels", "delete").length).toBeGreaterThanOrEqual(2);
    expect(db.find("parcels", "p-b")).toBeUndefined();
    const a = db.find("parcels", "p-a")!;
    expect(a.category).toBe("hobby");
    expect(a.category_source).toBe("user");
  });

  it("[N6] (a) keeps the kept parcel's user category when the mail lands on the other twin first", async () => {
    const db = twoMailParcels({ category: "beauty", category_source: "user", updated_at: "2026-11-02T00:00:00Z" });
    Object.assign(db.find("parcels", "p-a")!, { category: "hobby", category_source: "user", tracking_number: T });
    await run(db, reading({ relevance: "out_for_delivery", shop_name: null, tracking_number: sure(T_RAW), category: null }));
    expect(db.find("parcels", "p-b")).toBeUndefined();
    const a = db.find("parcels", "p-a")!;
    expect(a.category).toBe("hobby");
    expect(a.category_source).toBe("user");
  });
});

describe("[Codex-M3] a typed-in parcel that changes on both tries", () => {
  const shopMail = reading({
    relevance: "shipped",
    shop_name: "メールの店",
    order_number: sure("ORD-77770000"),
    tracking_number: sure(T_RAW),
    items: [item("メールの品名", 9999)],
    expected_date: sure("2026-11-05"),
  });
  const typedIn = () => parcel({ id: "p-manual", source: "manual", shop: "手入力の店", title: "手入力の品名", total_amount: 5000, tracking_number: T });
  /** The person saves again right before each guarded write of the merge. */
  const alwaysSavingFirst: Hook = (q: Query, d: FakeDb) => {
    if (q.table === "parcels" && q.op === "update" && q.filters.some((f) => f.method === "eq" && f.args[0] === "updated_at")) {
      d.find("parcels", "p-manual")!.updated_at = d.tick();
    }
  };

  it("fails the mail instead of marking it processed, and leaves the parcel as saved", async () => {
    const db = new FakeDb({ parcels: [typedIn()] });
    db.hooks.push(alwaysSavingFirst);
    await expect(run(db, shopMail)).rejects.toThrow();
    expect(db.rows("emails").map((e) => e.processing_status)).toEqual(["failed"]);
    const p = db.find("parcels", "p-manual")!;
    expect(p.expected_date).toBeNull();
    expect(p.status).toBe("ordered");
  });

  it("merges on the retry once the parcel holds still", async () => {
    const mail = { ...mailOf(SENT), messageId: "<retry@example.test>" };
    const db = new FakeDb({ parcels: [typedIn()] });
    db.hooks.push(alwaysSavingFirst);
    await expect(run(db, shopMail, mail)).rejects.toThrow();
    db.hooks.length = 0;
    const out = await run(db, shopMail, mail);
    expect(out.kind).toBe("processed");
    expect(db.rows("emails").map((e) => e.processing_status)).toEqual(["processed"]);
    const p = db.find("parcels", "p-manual")!;
    expect(p.expected_date).toBe("2026-11-05");
    expect(p.status).toBe("shipped");
    expect(p.title).toBe("手入力の品名");
  });
});

describe("[SEC-S1] the twin merge reads only the user's mails", () => {
  it("limits the embedded mails to the user", async () => {
    const db = twoMailParcels({});
    await run(db, bothNumbers);
    const reads = db.callsOn("extractions", "select").filter((q) => /emails/.test(q.columns ?? ""));
    expect(reads.length).toBeGreaterThan(0);
    for (const q of reads) expect(q.filters).toContainEqual({ method: "eq", args: ["emails.user_id", USER] });
  });
});
