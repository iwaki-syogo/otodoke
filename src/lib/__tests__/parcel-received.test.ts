import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { STATUS_LABEL, addDays, parcelStatusLabel, todayJst } from "@/lib/format";
import { runLoadDemo } from "@/lib/demo-run";
import {
  buildParcelInsert,
  buildParcelUpdate,
  mergeIntoManual,
  needsCheck,
  rebuildParcel,
  receivedAfterMerge,
  startsParcel,
  type ParcelRow,
} from "@/lib/match";
import { parcelSections } from "@/lib/parcel-sections";
import { processInboundEmail } from "@/lib/pipeline";
import { FakeDb, type Query, type Row } from "./fake-db";
import { findAll, linksTo, parseHtml, textOf, type HtmlNode } from "./html-tree";
import { USER, asAdmin, mailOf, precomputed, reading, sure } from "./pipeline-fixtures";
import { appSourceFiles, read, withoutComments } from "./source-scan";

/**
 * 「受け取り済み」: status = delivered says the delivery is done (a mail or the person said so);
 * parcels.received_at says the person has it. The mail processing never writes received_at, a merge
 * of parcels never loses it, and the list shows a delivered parcel under 配達済み until the person
 * says 受け取った. The database side (the trigger that fills received_at for a build that does not
 * know the column) is in supabase/migrations/20261112100000_parcel_received_at.sql and its verify file.
 */

const R = "2026-11-02T00:00:00.000Z";
const T = "123456789012";
const T_RAW = "1234-5678-9012";

const mocks = vi.hoisted(() => ({ state: { db: null as unknown }, revalidatePath: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath, revalidateTag: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: vi.fn(),
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/app",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => Object.assign(mocks.state.db as FakeDb, { auth: { getUser: async () => ({ data: { user: { id: USER } }, error: null }) } }),
  getUser: async () => ({ id: USER, email: "qa@example.com" }),
}));

let seq = 0;
function parcel(over: Row = {}): Row {
  seq += 1;
  return {
    id: `p-${String(seq).padStart(4, "0")}`,
    user_id: USER,
    shop: "テスト店",
    shop_key: "other",
    title: `品名${seq}`,
    status: "shipped",
    created_at: "2026-11-01T00:00:00Z",
    updated_at: "2026-11-01T00:00:00Z",
    last_email_at: "2026-11-01T00:00:00Z",
    ...over,
  };
}

const keysOf = (v: unknown) => Object.keys(v as object);
const writes = (db: FakeDb, op: "insert" | "update") => db.callsOn("parcels", op).map((q) => q.values as Row);

function run(db: FakeDb, x: ReturnType<typeof reading>, sentAt = "2026-11-03T01:00:00Z") {
  return processInboundEmail(asAdmin(db), mailOf(sentAt), { precomputed: precomputed(x) });
}

/* ---------------------------------------------------------------------------------------------- */
describe("the mail processing never writes received_at", () => {
  const RELEVANCES = ["order", "payment", "shipped", "out_for_delivery", "attempted", "delivered", "cancelled", "other_purchase"] as const;
  const x = (relevance: (typeof RELEVANCES)[number]) => reading({ relevance, order_number: sure("ORD-12345678"), tracking_number: sure(T_RAW) });
  const existing = (over: Partial<ParcelRow> = {}) =>
    ({ ...parcel({ status: "shipped", order_number: "ORD-12345678", source: "mail", received_at: null, ...over }), itemNames: [] }) as unknown as ParcelRow & { itemNames: string[] };

  it.each(RELEVANCES)("buildParcelInsert, buildParcelUpdate and mergeIntoManual leave it out for a %s mail", (relevance) => {
    expect(keysOf(buildParcelInsert(USER, x(relevance), "2026-11-03T01:00:00Z"))).not.toContain("received_at");
    expect(keysOf(buildParcelUpdate(existing(), x(relevance), "2026-11-03T01:00:00Z"))).not.toContain("received_at");
    expect(keysOf(mergeIntoManual(existing({ source: "manual" }), x(relevance), "2026-11-03T01:00:00Z"))).not.toContain("received_at");
    // Nor on a parcel that is received already: a mail has no word on it.
    expect(keysOf(buildParcelUpdate(existing({ status: "delivered", received_at: R }), x(relevance), "2026-11-03T01:00:00Z"))).not.toContain("received_at");
    expect(keysOf(mergeIntoManual(existing({ source: "manual", status: "delivered", received_at: R }), x(relevance), "2026-11-03T01:00:00Z"))).not.toContain("received_at");
  });

  it("rebuildParcel leaves it out too", () => {
    const row = rebuildParcel(USER, [
      { x: x("order"), sentAt: "2026-11-01T00:00:00Z" },
      { x: x("delivered"), sentAt: "2026-11-02T00:00:00Z" },
    ]);
    expect(row.status).toBe("delivered");
    expect(keysOf(row)).not.toContain("received_at");
  });

  it("a delivery mail opens a delivered parcel with no received_at, and writes none", async () => {
    const db = new FakeDb({ parcels: [], emails: [], extractions: [] });
    await run(db, reading({ relevance: "delivered", order_number: sure("ORD-12345678") }));
    const [row] = db.rows("parcels");
    expect(row.status).toBe("delivered");
    expect(row.received_at).toBeNull();
    expect(writes(db, "insert").map(keysOf).flat()).not.toContain("received_at");
  });

  it("a delivery mail moves a shipped parcel to delivered and leaves received_at null", async () => {
    const db = new FakeDb({ parcels: [parcel({ id: "p-s", status: "shipped", tracking_number: T })], emails: [], extractions: [] });
    await run(db, reading({ relevance: "delivered", tracking_number: sure(T_RAW) }));
    expect(db.find("parcels", "p-s")!.status).toBe("delivered");
    expect(db.find("parcels", "p-s")!.received_at).toBeNull();
    expect(writes(db, "update").map(keysOf).flat()).not.toContain("received_at");
  });

  it("a later mail does not clear received_at of a parcel the person has received", async () => {
    const db = new FakeDb({ parcels: [parcel({ id: "p-r", status: "delivered", received_at: R, tracking_number: T })], emails: [], extractions: [] });
    await run(db, reading({ relevance: "delivered", tracking_number: sure(T_RAW), expected_date: sure("2026-11-03") }));
    await run(db, reading({ relevance: "shipped", tracking_number: sure(T_RAW) }), "2026-10-30T00:00:00Z");
    const row = db.find("parcels", "p-r")!;
    expect(row.status).toBe("delivered");
    expect(row.received_at).toBe(R);
    expect(writes(db, "update").map(keysOf).flat()).not.toContain("received_at");
  });

  it("a mail joining a typed-in parcel the person has received keeps its status and received_at", async () => {
    const db = new FakeDb({ parcels: [parcel({ id: "p-m", source: "manual", status: "delivered", received_at: R, tracking_number: T })], emails: [], extractions: [] });
    await run(db, reading({ relevance: "shipped", tracking_number: sure(T_RAW), expected_date: sure("2026-11-04") }));
    await run(db, reading({ relevance: "delivered", tracking_number: sure(T_RAW) }));
    const row = db.find("parcels", "p-m")!;
    expect(row.status).toBe("delivered");
    expect(row.received_at).toBe(R);
  });

  it("a delivery mail on a typed-in shipped parcel makes it delivered, not received", async () => {
    const db = new FakeDb({ parcels: [parcel({ id: "p-m", source: "manual", status: "shipped", tracking_number: T })], emails: [], extractions: [] });
    await run(db, reading({ relevance: "delivered", tracking_number: sure(T_RAW) }));
    expect(db.find("parcels", "p-m")!.status).toBe("delivered");
    expect(db.find("parcels", "p-m")!.received_at).toBeNull();
  });

  it("startsParcel is unchanged: a delivery mail opens a parcel", () => {
    expect(startsParcel(x("delivered"))).toBe(true);
  });
});

/* ---------------------------------------------------------------------------------------------- */
describe("receivedAfterMerge", () => {
  it.each([
    ["the kept parcel's, when it has one", R, ["2026-11-05T00:00:00Z"], "shipped", R],
    ["an absorbed parcel's, when the kept one has none", null, [null, R], "shipped", R],
    ["the first absorbed one's, when several have it", null, ["2026-11-05T00:00:00Z", R], "ordered", "2026-11-05T00:00:00Z"],
  ])("carries %s", (_name, keepAt, absorbed, status, want) => {
    expect(receivedAfterMerge({ received_at: keepAt }, absorbed.map((received_at) => ({ received_at })), status)).toEqual({ status: "delivered", received_at: want });
  });

  it("carries nothing when no parcel was received", () => {
    expect(receivedAfterMerge({ received_at: null }, [{ received_at: null }], "delivered")).toBeNull();
  });

  it("carries nothing into a cancelled parcel", () => {
    expect(receivedAfterMerge({ received_at: R }, [], "cancelled")).toBeNull();
  });
});

describe("a merge of twin parcels keeps received_at", () => {
  const SENT = "2026-11-03T01:00:00Z";
  /** A has the order number and stays; B was opened by the carrier mail and is folded in. */
  function twoParcels(a: Row, b: Row) {
    return new FakeDb({
      emails: [
        { id: "m-a", user_id: USER, sent_at: "2026-11-01T00:00:00Z" },
        { id: "m-b", user_id: USER, sent_at: "2026-11-02T00:00:00Z" },
      ],
      parcels: [
        parcel({ id: "p-a", order_number: "ORD-12345678", status: "ordered", ...a }),
        parcel({ id: "p-b", shop: "送り主不明", status: "shipped", tracking_number: T, created_at: "2026-11-02T00:00:00Z", ...b }),
      ],
      extractions: [
        { id: "x-a", user_id: USER, email_id: "m-a", parcel_id: "p-a", result: reading({ relevance: "order", order_number: sure("ORD-12345678") }) },
        { id: "x-b", user_id: USER, email_id: "m-b", parcel_id: "p-b", result: reading({ relevance: "shipped", shop_name: null, tracking_number: sure(T_RAW) }) },
      ],
    });
  }
  const both = reading({ relevance: "shipped", order_number: sure("ORD-12345678"), tracking_number: sure(T_RAW), category: null });

  it("keeps the received_at of the absorbed parcel when the kept one has none, and the status that goes with it", async () => {
    const db = twoParcels({}, { status: "delivered", received_at: R });
    await run(db, both, SENT);
    expect(db.find("parcels", "p-b")).toBeUndefined();
    expect(db.find("parcels", "p-a")!.received_at).toBe(R);
    expect(db.find("parcels", "p-a")!.status).toBe("delivered");
  });

  it("keeps the kept parcel's own received_at, even when the mails alone would say shipped", async () => {
    const db = twoParcels({ status: "delivered", received_at: R }, {});
    await run(db, both, SENT);
    expect(db.find("parcels", "p-b")).toBeUndefined();
    expect(db.find("parcels", "p-a")!.received_at).toBe(R);
    expect(db.find("parcels", "p-a")!.status).toBe("delivered");
  });

  it("prefers the kept parcel's received_at when both have one", async () => {
    const db = twoParcels({ status: "delivered", received_at: R }, { status: "delivered", received_at: "2026-11-02T12:00:00.000Z" });
    await run(db, both, SENT);
    expect(db.find("parcels", "p-a")!.received_at).toBe(R);
  });

  it("writes no received_at when neither parcel has one", async () => {
    const db = twoParcels({}, {});
    await run(db, both, SENT);
    expect(db.find("parcels", "p-b")).toBeUndefined();
    expect(db.find("parcels", "p-a")!.received_at).toBeNull();
    expect(writes(db, "update").map(keysOf).flat()).not.toContain("received_at");
  });

  it("keeps it on a typed-in parcel that absorbs a received twin", async () => {
    const db = new FakeDb({
      emails: [{ id: "m-c", user_id: USER, sent_at: "2026-11-02T00:00:00Z" }],
      parcels: [
        parcel({ id: "p-manual", source: "manual", status: "shipped", shop: "手入力の店", title: "手入力の品名", tracking_number: T }),
        parcel({ id: "p-carrier", shop: "送り主不明", status: "delivered", received_at: R, tracking_number: T, created_at: "2026-11-02T00:00:00Z" }),
      ],
      extractions: [{ id: "x-c", user_id: USER, email_id: "m-c", parcel_id: "p-carrier", result: reading({ relevance: "shipped", shop_name: null, tracking_number: sure(T_RAW) }) }],
    });
    await run(db, reading({ relevance: "out_for_delivery", shop_name: null, tracking_number: sure(T_RAW) }), SENT);
    expect(db.find("parcels", "p-carrier")).toBeUndefined();
    expect(db.find("parcels", "p-manual")!.received_at).toBe(R);
    expect(db.find("parcels", "p-manual")!.status).toBe("delivered");
    expect(db.find("parcels", "p-manual")!.title).toBe("手入力の品名");
  });
});

/* ---------------------------------------------------------------------------------------------- */
describe("受け取った and its undo", () => {
  const actions = () => import("@/app/app/parcel-actions");
  const ID = "11111111-1111-4111-8111-111111111111";
  const ID2 = "22222222-2222-4222-8222-222222222222";
  const READ_AT = "2026-11-01T00:00:00.000Z";
  let db: FakeDb;
  const row = (id: string, over: Row = {}): Row => ({ id, user_id: USER, shop: "テスト店", status: "shipped", received_at: null, tracking_number: null, carrier: null, updated_at: READ_AT, ...over });
  beforeEach(() => {
    db = new FakeDb({ parcels: [row(ID), row(ID2, { status: "delivered" })] });
    mocks.state.db = db;
    mocks.revalidatePath.mockClear();
  });

  it("markDelivered writes the status and received_at together, received_at as a time", async () => {
    const before = Date.now();
    expect(await (await actions()).markDelivered([ID])).toBe(1);
    const [values] = writes(db, "update");
    expect(Object.keys(values).sort()).toEqual(["received_at", "status"]);
    expect(values.status).toBe("delivered");
    expect(new Date(values.received_at as string).getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(db.find("parcels", ID)!.received_at).not.toBeNull();
  });

  it("markDelivered on a delivered parcel not yet received (配達済み) receives it", async () => {
    expect(await (await actions()).markDelivered([ID2])).toBe(1);
    expect(db.find("parcels", ID2)!.received_at).not.toBeNull();
  });

  it("markDelivered leaves a cancelled parcel alone", async () => {
    db.find("parcels", ID)!.status = "cancelled";
    expect(await (await actions()).markDelivered([ID])).toBe(0);
    expect(db.find("parcels", ID)!.received_at).toBeNull();
  });

  it("the undo puts back the status and the received_at it had", async () => {
    const { markDelivered, restoreStatuses } = await actions();
    await markDelivered([ID, ID2]);
    await restoreStatuses([
      { id: ID, status: "shipped", received_at: null },
      { id: ID2, status: "delivered", received_at: null },
    ]);
    expect(db.find("parcels", ID)).toMatchObject({ status: "shipped", received_at: null });
    // Back to 配達済み: still delivered, not received.
    expect(db.find("parcels", ID2)).toMatchObject({ status: "delivered", received_at: null });
  });

  it("the undo leaves a parcel the person changed since (no longer delivered and received)", async () => {
    const { markDelivered, restoreStatuses } = await actions();
    await markDelivered([ID]);
    // 受け取っていない pressed meanwhile: delivered, received_at cleared.
    db.find("parcels", ID)!.received_at = null;
    await restoreStatuses([{ id: ID, status: "shipped", received_at: null }]);
    expect(db.find("parcels", ID)).toMatchObject({ status: "delivered", received_at: null });
  });

  it.each([
    ["not a time", { id: ID, status: "shipped", received_at: "tomorrow" }],
    ["a received_at on a status that is not delivered", { id: ID, status: "shipped", received_at: R }],
    ["a status that cannot be put back to", { id: ID, status: "cancelled", received_at: null }],
  ])("the undo refuses %s without writing", async (_name, item) => {
    await (await actions()).markDelivered([ID]);
    const updates = writes(db, "update").length;
    await (await actions()).restoreStatuses([item]);
    expect(writes(db, "update")).toHaveLength(updates);
    expect(db.find("parcels", ID)).toMatchObject({ status: "delivered" });
  });

  describe("markNotReceived (受け取っていない)", () => {
    const received = (id: string, over: Row = {}) => Object.assign(db.find("parcels", id)!, { status: "delivered", received_at: R, ...over });

    it("clears received_at only, with the conditions of the other undo actions", async () => {
      received(ID);
      expect(await (await actions()).markNotReceived(ID)).toEqual({ ok: true });
      const [q]: Query[] = db.callsOn("parcels", "update");
      expect(q.values).toEqual({ received_at: null });
      const eq = (c: string) => q.filters.filter((f) => f.method === "eq" && f.args[0] === c).map((f) => f.args[1]);
      expect(eq("id")).toEqual([ID]);
      expect(eq("user_id")).toEqual([USER]);
      expect(eq("status")).toEqual(["delivered"]);
      expect(eq("updated_at")).toEqual([READ_AT]);
      expect(db.find("parcels", ID)).toMatchObject({ status: "delivered", received_at: null });
      expect(mocks.revalidatePath).toHaveBeenCalledWith("/app", "layout");
    });

    it.each([
      ["a parcel not received yet", { received_at: null }],
      ["a parcel not delivered", { status: "shipped" }],
      ["a cancelled parcel", { status: "cancelled" }],
    ])("refuses %s without writing", async (_name, over) => {
      received(ID, over);
      expect(await (await actions()).markNotReceived(ID)).toEqual({ ok: false, error: "更新できませんでした。開き直してください" });
      expect(writes(db, "update")).toHaveLength(0);
      expect(mocks.revalidatePath).not.toHaveBeenCalled();
    });

    it("writes nothing when a mail saved the parcel between the read and the update", async () => {
      received(ID);
      db.hooks.push((q, d) => {
        if (q.table === "parcels" && q.op === "update") d.find("parcels", ID)!.updated_at = d.tick();
      });
      expect(await (await actions()).markNotReceived(ID)).toMatchObject({ ok: false });
      expect(db.find("parcels", ID)!.received_at).toBe(R);
      expect(writes(db, "update")).toHaveLength(1);
    });

    it("refuses a bad id and a signed-out user before touching the database", async () => {
      expect(await (await actions()).markNotReceived("nope")).toMatchObject({ ok: false });
      expect(db.calls).toHaveLength(0);
    });
  });
});

/* ---------------------------------------------------------------------------------------------- */
describe("the parcel list", () => {
  const today = todayJst();
  let db: FakeDb;
  const seed = (rows: Row[]) => {
    db = new FakeDb({ parcels: rows, emails: [] });
    mocks.state.db = db;
  };
  const render = async () => {
    const Page = (await import("@/app/app/page")).default;
    return parseHtml(renderToStaticMarkup(await Page()));
  };
  const headings = (root: HtmlNode) => findAll(root, (n) => n.tag === "h2").map((h) => textOf(h).replace(/\d+$/, "").trim());
  const shown = (root: HtmlNode) => findAll(root, (n) => n.tag === "a" && (n.attrs.href ?? "").startsWith("/app/parcels/p-")).map((n) => n.attrs.href.slice("/app/parcels/".length));

  const arrived = parcel({ id: "p-arrived", status: "delivered", received_at: null, last_email_at: null, expected_date: addDays(today, -1) });
  const received = parcel({ id: "p-received", status: "delivered", received_at: R, expected_date: addDays(today, -1) });
  const cancelled = parcel({ id: "p-cancelled", status: "cancelled", expected_date: addDays(today, 3) });
  const coming = parcel({ id: "p-coming", status: "shipped", expected_date: addDays(today, 2) });
  const old = parcel({ id: "p-old", status: "delivered", received_at: null, last_email_at: null, expected_date: addDays(today, -14) });
  const oldShipped = parcel({ id: "p-old-shipped", status: "shipped", expected_date: addDays(today, -20) });

  it("puts 配達済み first, then 要確認, and keeps received and cancelled parcels off the list", async () => {
    seed([coming, arrived, received, cancelled, old, oldShipped]);
    const root = await render();
    expect(headings(root)).toEqual(["配達済み", "要確認", "もうすぐ届く", "注文中"]);
    expect(shown(root).sort()).toEqual(["p-arrived", "p-coming", "p-old", "p-old-shipped"].sort());
  });

  it("moves a delivered parcel to 要確認 on the 14th day, and not before", async () => {
    seed([parcel({ id: "p-13", status: "delivered", last_email_at: null, expected_date: addDays(today, -13) }), parcel({ id: "p-14", status: "delivered", last_email_at: null, expected_date: addDays(today, -14) })]);
    const root = await render();
    const sections = findAll(root, (n) => n.tag === "section");
    const idsIn = (title: string) => {
      const s = sections.find((n) => textOf(n).startsWith(title))!;
      return linksTo(s, "/app/parcels/p-13").length + linksTo(s, "/app/parcels/p-14").length * 10;
    };
    expect(idsIn("配達済み")).toBe(1);
    expect(idsIn("要確認")).toBe(10);
  });

  it("asks about delivered parcels in words of their own, and keeps the old words for the others", async () => {
    const oldWords = "届いた連絡がない荷物です";
    const deliveredWords = "配達済みから 2 週間以上たっています。受け取りましたか？";
    seed([old]);
    let text = textOf(await render());
    expect(text).toContain(deliveredWords);
    expect(text).not.toContain(oldWords);
    seed([oldShipped]);
    text = textOf(await render());
    expect(text).toContain(oldWords);
    expect(text).not.toContain(deliveredWords);
    seed([old, oldShipped]);
    text = textOf(await render());
    expect(text).toContain(oldWords);
    expect(text).toContain(deliveredWords);
  });

  it("offers the 要確認 button as 「すべて受け取り済みにする」, and swipes as 「受け取った」", async () => {
    seed([old, oldShipped, arrived]);
    const text = textOf(await render());
    expect(text).toContain("すべて受け取り済みにする");
    expect(text).toContain("受け取った");
    expect(text).not.toContain("受取済");
  });

  it("links to 受け取り済み without a count, and drops the swipe hint", async () => {
    seed([coming, arrived, received]);
    const root = await render();
    const link = linksTo(root, "/app/delivered");
    expect(link).toHaveLength(1);
    expect(textOf(link[0]).replace(/\s/g, "")).toBe("受け取り済み›");
    expect(textOf(link[0])).not.toMatch(/\d/);
    expect(textOf(root)).not.toContain("スワイプ");
    expect(textOf(root)).not.toContain("届いた荷物");
  });

  it("links to 受け取り済み without a count on the empty list too", async () => {
    seed([]);
    const link = linksTo(await render(), "/app/delivered");
    expect(textOf(link[0]).replace(/\s/g, "")).toBe("受け取り済み›");
  });

  it("shows the state on the card: 配達済み for a delivered parcel", async () => {
    seed([arrived]);
    expect(textOf(linksTo(await render(), "/app/parcels/p-arrived")[0])).toContain("配達済み");
  });
});

describe("the 受け取り済み page", () => {
  const render = async () => {
    const Page = (await import("@/app/app/delivered/page")).default as unknown as (p: { searchParams: Promise<Record<string, string>> }) => Promise<Parameters<typeof renderToStaticMarkup>[0]>;
    return parseHtml(renderToStaticMarkup(await Page({ searchParams: Promise.resolve({}) })));
  };
  const shown = (root: HtmlNode) => findAll(root, (n) => n.tag === "a" && (n.attrs.href ?? "").startsWith("/app/parcels/p-")).map((n) => n.attrs.href.slice("/app/parcels/".length));

  it("lists the parcels with received_at that are not cancelled, and no others", async () => {
    mocks.state.db = new FakeDb({
      parcels: [
        parcel({ id: "p-received", status: "delivered", received_at: R }),
        parcel({ id: "p-arrived", status: "delivered", received_at: null }),
        parcel({ id: "p-shipped", status: "shipped" }),
        parcel({ id: "p-cancelled", status: "cancelled", received_at: R }),
        parcel({ id: "p-theirs", status: "delivered", received_at: R, user_id: "00000000-0000-4000-8000-0000000000ff" }),
      ],
      parcel_items: [],
    });
    const root = await render();
    expect(shown(root)).toEqual(["p-received"]);
    expect(textOf(findAll(root, (n) => n.tag === "h1")[0])).toContain("受け取り済み");
    expect(textOf(linksTo(root, "/app/parcels/p-received")[0])).toContain("受け取り済み");
  });

  it("says 「受け取り済みの荷物はありません」 when there are none", async () => {
    mocks.state.db = new FakeDb({ parcels: [parcel({ id: "p-arrived", status: "delivered", received_at: null })], parcel_items: [] });
    expect(textOf(await render())).toContain("受け取り済みの荷物はありません");
  });
});

/* ---------------------------------------------------------------------------------------------- */
describe("the sample does not bring a year of deliveries back to the list", () => {
  it("marks the delivered parcels the sample made as received, and no other", async () => {
    // Two real delivered parcels of the account: one with no mail at all, one that a real (not sample) mail belongs to.
    const real = parcel({ id: "p-real", status: "delivered", received_at: null, expected_date: todayJst() });
    const realMail = parcel({ id: "p-real-mail", status: "delivered", received_at: null, expected_date: todayJst() });
    const db = new FakeDb(
      {
        parcels: [real, realMail],
        emails: [{ id: "m-real", user_id: USER, provider_email_id: "re_real_mail", sent_at: "2026-11-01T00:00:00Z" }],
        extractions: [{ id: "x-real", user_id: USER, email_id: "m-real", parcel_id: "p-real-mail", result: reading({ relevance: "delivered" }) }],
        parcel_items: [],
      },
      Date.now(),
    );
    const result = await runLoadDemo(() => asAdmin(db), USER);
    expect(result).toMatchObject({ ok: true });

    const parcels = db.rows("parcels");
    const own = ["p-real", "p-real-mail"];
    const delivered = parcels.filter((p) => p.status === "delivered" && !own.includes(p.id as string));
    // The made-up history alone is 80 delivered orders.
    expect(delivered.length).toBeGreaterThanOrEqual(80);
    expect(delivered.every((p) => p.received_at !== null)).toBe(true);
    // Parcels of the account that no sample mail belongs to are not touched.
    for (const id of own) expect(db.find("parcels", id)!.received_at, id).toBeNull();
    // Parcels that are not delivered get none.
    expect(parcels.filter((p) => p.status !== "delivered").every((p) => p.received_at === null)).toBe(true);

    const sections = parcelSections(parcels as unknown as ParcelRow[], todayJst());
    expect(sections.arrived.map((p) => p.id).sort()).toEqual(own);
    expect(sections.toCheck.filter((p) => p.status === "delivered")).toEqual([]);
  });

  it("marks them again on a second load, and still leaves the other parcel alone", async () => {
    const real = parcel({ id: "p-real", status: "delivered", received_at: null, expected_date: todayJst() });
    const db = new FakeDb({ parcels: [real], emails: [], extractions: [], parcel_items: [] }, Date.now());
    await runLoadDemo(() => asAdmin(db), USER);
    // A sample parcel the person sent back to 配達済み stays so when the same mails are read again: the load marks it only while it has no word.
    const mine = db.rows("parcels").find((p) => p.status === "delivered" && p.id !== "p-real")!;
    mine.received_at = null;
    await runLoadDemo(() => asAdmin(db), USER);
    expect(db.find("parcels", "p-real")!.received_at).toBeNull();
    expect(db.rows("parcels").filter((p) => p.status === "delivered" && p.id !== "p-real").every((p) => p.received_at !== null)).toBe(true);
  });
}, 60_000);

/* ---------------------------------------------------------------------------------------------- */
describe("the 14 days of a delivered parcel count from the later of its date and its last mail", () => {
  const TODAY = "2026-11-05";
  const base = { expected_date_end: null, received_at: null };

  it("does not ask about a typed-in parcel with an old date when a delivery mail came today", () => {
    const p = { ...base, status: "delivered", expected_date: "2026-09-01", last_email_at: "2026-11-05T01:00:00Z" };
    expect(needsCheck(p, TODAY)).toBe(false);
    expect(parcelSections([{ ...parcel({ id: "p-x" }), ...p } as unknown as ParcelRow], TODAY).arrived).toHaveLength(1);
  });

  it("asks once both the date and the last mail are 14 days back", () => {
    expect(needsCheck({ ...base, status: "delivered", expected_date: "2026-09-01", last_email_at: "2026-10-23T01:00:00Z" }, TODAY)).toBe(false);
    expect(needsCheck({ ...base, status: "delivered", expected_date: "2026-09-01", last_email_at: "2026-10-22T01:00:00Z" }, TODAY)).toBe(true);
    expect(needsCheck({ ...base, status: "delivered", expected_date: "2026-10-23", last_email_at: "2026-10-01T01:00:00Z" }, TODAY)).toBe(false);
  });

  it("uses the date alone for a delivered parcel with no mail, and the mail alone with no date", () => {
    expect(needsCheck({ ...base, status: "delivered", expected_date: "2026-10-21", last_email_at: null }, TODAY)).toBe(true);
    expect(needsCheck({ ...base, status: "delivered", expected_date: null, last_email_at: "2026-10-23T01:00:00Z" }, TODAY)).toBe(false);
    expect(needsCheck({ ...base, status: "delivered", expected_date: null, last_email_at: null }, TODAY)).toBe(false);
  });

  it("leaves the count of a parcel that is not delivered as it was (the date alone, however new the mail)", () => {
    expect(needsCheck({ ...base, status: "shipped", expected_date: "2026-09-01", last_email_at: "2026-11-05T01:00:00Z" }, TODAY)).toBe(true);
  });
});

describe("the card of a delivered parcel", () => {
  const card = async (over: Row) => {
    const { ParcelCard } = await import("@/app/app/parcel-card");
    return textOf(parseHtml(renderToStaticMarkup(createElement(ParcelCard, { parcel: parcel({ requires_presence: true, ...over }) as unknown as ParcelRow }))));
  };

  it("shows no at-home badge, delivered or received", async () => {
    expect(await card({ status: "delivered", received_at: null })).not.toContain("対面");
    expect(await card({ status: "delivered", received_at: R })).not.toContain("対面");
  });

  it("still shows it before delivery", async () => {
    expect(await card({ status: "shipped" })).toContain("対面受け取り");
  });
});

/* ---------------------------------------------------------------------------------------------- */
describe("the words", () => {
  it("names the two delivered states", () => {
    expect(parcelStatusLabel("delivered", null)).toBe("配達済み");
    expect(parcelStatusLabel("delivered", undefined)).toBe("配達済み");
    expect(parcelStatusLabel("delivered", R)).toBe("受け取り済み");
    expect(parcelStatusLabel("shipped", R)).toBe("発送済み");
    expect(parcelStatusLabel("cancelled", null)).toBe("キャンセル");
  });

  it("leaves STATUS_LABEL as the iOS app (build 13) copies it", () => {
    expect(STATUS_LABEL.delivered).toBe("届いた");
  });

  it("keeps the old words off every screen", () => {
    const old = ["受取済", "届いた荷物", "届いたにしました", "左にスワイプして"];
    for (const file of appSourceFiles()) {
      const code = withoutComments(read(file));
      for (const word of old) expect(code, `${file}: ${word}`).not.toContain(word);
    }
  });

  it("gives the entrance rows no count, on the list and the calendar", () => {
    for (const file of ["src/app/app/page.tsx", "src/app/app/calendar/page.tsx"]) {
      const code = withoutComments(read(`${process.cwd()}/${file}`));
      const links = [...code.matchAll(/<PageLink\b[^>]*>/g)].map((m) => m[0]);
      expect(links.some((l) => l.includes('href="/app/delivered"') && l.includes('label="受け取り済み"')), file).toBe(true);
      for (const l of links) expect(l, file).not.toMatch(/\bcount=/);
    }
  });
});
