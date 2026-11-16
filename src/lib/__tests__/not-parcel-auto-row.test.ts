import { readFileSync } from "node:fs";
import path from "node:path";
import { type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { todayJst } from "@/lib/format";
import { AUTO_EXCLUDED_ROW_LABEL, EXCLUDED_BY_RULE, EXCLUDED_BY_USER, EXCLUDED_TOAST, EXCLUDED_TOAST_AUTO, EXCLUDED_PAGE_LABEL } from "@/lib/not-parcel-text";
import { orderExcluded, seenUntilOf } from "@/lib/not-parcel-auto-view";
import { FakeDb } from "./fake-db";
import { findAll, parseHtml, textOf, type HtmlNode } from "./html-tree";

/**
 * The row under the list (「おとどけが自動で外した荷物があります ›」) and the "seen" write behind it, on the Web (stage 2, C1 to C13):
 * - the list: the row only when the database says so, no count, between キャンセルした荷物 and 外した荷物; a failed read is not "no";
 * - 外した荷物: the open automatic ones first, each says who took it out, and the "seen" time handed to the client part is the newest
 *   mark that is listed; none is handed over when none of them is listed or the read failed;
 * - the server part of the page and of the list never writes "seen" (render, prefetch); only the client part does, once;
 * - the second notice sentence is for a mark of the person's own, only when the app will really start doing it.
 */

const USER = "00000000-0000-4000-8000-00000000000a";
const ID = "10000000-0000-4000-8000-000000000001";
const mocks = vi.hoisted(() => ({ state: { client: null as unknown }, seen: vi.fn() }));

vi.mock("@/lib/ai-consent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ai-consent")>()),
  readAiReadingConsent: async () => "granted",
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
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
  createClient: async () => mocks.state.client,
  getUser: async () => ({ id: USER }),
}));
vi.mock("@/app/app/parcel-actions", () => ({
  markDeliveredForUndo: vi.fn(),
  restoreStatuses: vi.fn(),
  excludeParcel: vi.fn(),
  restoreExcluded: vi.fn(),
  markAutoExcludedSeen: (...args: unknown[]) => mocks.seen(...args),
}));

const { default: ListPage } = await import("@/app/app/page");
const { default: ExcludedPage } = await import("@/app/app/excluded/page");
const { ExcludedToast } = await import("@/app/app/delivered-controls");
const { MarkAutoSeen } = await import("@/app/app/excluded/mark-auto-seen");

type Answer = { data: unknown; error: unknown };
const ROOT = path.resolve(__dirname, "../../..");
const source = (p: string) => readFileSync(path.join(ROOT, p), "utf8");

let seq = 0;
const parcel = () => ({ id: `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`, user_id: USER, shop: "店", title: "品", status: "ordered", source: "mail", expected_date: todayJst() });
/** A signed-in client whose named functions answer as given; everything else is the fake database's. */
function client(parcels: Record<string, unknown>[], answers: Record<string, Answer>) {
  const db = new FakeDb({ parcels, emails: [] });
  const rpc = db.rpc.bind(db);
  mocks.state.client = Object.assign(db, {
    auth: { getUser: async () => ({ data: { user: { id: USER } }, error: null }) },
    rpc: (name: string, args?: unknown) => (name in answers ? Promise.resolve(answers[name]) : rpc(name, args)),
  });
}
const ok = (data: unknown): Answer => ({ data, error: null });
const failed: Answer = { data: null, error: { message: "boom" } };
const list = async (query?: string) => ListPage({ searchParams: Promise.resolve(query === undefined ? {} : { excluded: query }) });
const html = async (query?: string) => parseHtml(renderToStaticMarkup(await list(query)));
const rowLinks = (root: HtmlNode) => findAll(root, (n) => n.tag === "a" && textOf(n).includes(AUTO_EXCLUDED_ROW_LABEL));
const alerts = (root: HtmlNode) => findAll(root, (n) => n.tag === "p" && textOf(n).trim() === "読み込めませんでした");

function elementsOf<P>(node: unknown, type: unknown, out: ReactElement<P>[] = []) {
  if (Array.isArray(node)) node.forEach((n) => elementsOf(n, type, out));
  else if (node && typeof node === "object" && "props" in node) {
    const el = node as ReactElement<{ children?: unknown }>;
    if (el.type === type) out.push(el as unknown as ReactElement<P>);
    elementsOf(el.props.children, type, out);
  }
  return out;
}

beforeEach(() => {
  mocks.seen.mockReset();
  mocks.seen.mockResolvedValue({ ok: true });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("C1 to C5, C8: the row under the list", () => {
  it("C1 is there when the database says so, once, with no number, between キャンセルした荷物 and 外した荷物", async () => {
    client([parcel()], { has_open_auto_exclusion: ok(true) });
    const root = await html();
    const rows = rowLinks(root);
    expect(rows).toHaveLength(1);
    expect(rows[0].attrs.href).toBe("/app/excluded");
    expect(textOf(rows[0])).toContain("›");
    expect(textOf(rows[0])).not.toMatch(/\d|件/);
    const order = findAll(root, (n) => n.tag === "a" && ["/app/delivered", "/app/cancelled", "/app/excluded"].includes(n.attrs.href ?? "")).map((n) => textOf(n));
    expect(order).toHaveLength(4);
    expect(order[0]).toContain("受け取り済み");
    expect(order[1]).toContain("キャンセルした荷物");
    expect(order[2]).toContain(AUTO_EXCLUDED_ROW_LABEL);
    expect(order[3]).toContain(EXCLUDED_PAGE_LABEL);
  });

  it("C1 is also there on the empty list and on a list that could not be read", async () => {
    client([], { has_open_auto_exclusion: ok(true) });
    expect(rowLinks(await html())).toHaveLength(1);
    const db = new FakeDb({ parcels: [parcel()], emails: [] });
    db.hooks.push((q) => (q.table === "parcels" ? { data: null, error: { message: "boom" }, count: null } : undefined));
    const rpc = db.rpc.bind(db);
    mocks.state.client = Object.assign(db, {
      auth: { getUser: async () => ({ data: { user: { id: USER } }, error: null }) },
      rpc: (name: string, args?: unknown) => (name === "has_open_auto_exclusion" ? Promise.resolve(ok(true)) : rpc(name, args)),
    });
    const root = await html();
    expect(rowLinks(root)).toHaveLength(1);
    expect(alerts(root)).toHaveLength(1);
  });

  it("C2 (negative) is not there, not even as an empty row, when the database says no", async () => {
    client([parcel()], { has_open_auto_exclusion: ok(false) });
    const root = await html();
    expect(rowLinks(root)).toHaveLength(0);
    const toExcluded = findAll(root, (n) => n.tag === "a" && n.attrs.href === "/app/excluded");
    expect(toExcluded).toHaveLength(1);
    expect(textOf(toExcluded[0])).toContain(EXCLUDED_PAGE_LABEL);
    expect(findAll(root, (n) => n.tag === "a" && textOf(n).replace("›", "").trim() === "")).toHaveLength(0);
    expect(alerts(root)).toHaveLength(0);
  });

  it("C3 the sentence carries no number", () => {
    expect(AUTO_EXCLUDED_ROW_LABEL).not.toMatch(/\d|件/);
  });

  it("C5 the sentence is the one agreed with the iPhone (one definition, subject first)", () => {
    expect(AUTO_EXCLUDED_ROW_LABEL).toBe("おとどけが自動で外した荷物があります");
    // Defined once, and the list reads the constant: no second copy of the words.
    expect(source("src/app/app/page.tsx")).not.toContain("自動で外した");
    expect(source("src/app/app/page.tsx")).toContain("AUTO_EXCLUDED_ROW_LABEL");
  });

  it.each([["an error", failed], ["a thrown call", null], ["an answer that is not a yes or a no", ok("ok")], ["an empty answer", ok(null)]])("C8 %s draws no row and says 読み込めませんでした once (it is never read as no)", async (_name, answer) => {
    client([parcel()], { has_open_auto_exclusion: answer ?? failed });
    if (answer === null) {
      const db = mocks.state.client as FakeDb;
      Object.assign(db, { rpc: (name: string) => (name === "has_open_auto_exclusion" ? Promise.reject(new Error("network")) : Promise.resolve(ok("ok"))) });
    }
    const root = await html();
    expect(rowLinks(root)).toHaveLength(0);
    expect(alerts(root)).toHaveLength(1);
  });

  it("C8 an unreadable list and an unreadable row say it once, not twice", async () => {
    const db = new FakeDb({ parcels: [parcel()], emails: [] });
    db.hooks.push((q) => (q.table === "parcels" ? { data: null, error: { message: "boom" }, count: null } : undefined));
    mocks.state.client = Object.assign(db, { auth: { getUser: async () => ({ data: { user: { id: USER } }, error: null }) }, rpc: () => Promise.resolve(failed) });
    expect(alerts(await html())).toHaveLength(1);
  });
});

describe("C6, C10 to C13: 外した荷物", () => {
  const row = (over: Record<string, unknown>) => ({
    parcel_id: `20000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`,
    kind: "user", excluded_at: "2026-11-17T01:00:00Z", shop: "店", title: "題", status: "shipped", ordered_at: "2026-11-10",
    expected_date: null, total_amount: 1200, carrier: null, item_names: [], ...over,
  });
  // excluded_parcels answers the rows; excluded_parcels_unseen answers each mark's created_at (here: given by `at`, else excluded_at).
  const open = (answer: Answer, times?: Answer) => {
    const rows = Array.isArray(answer.data) ? (answer.data as { parcel_id: string; kind: string; excluded_at: string }[]) : [];
    const own: Answer = times ?? ok(rows.map((r) => ({ parcel_id: r.parcel_id, kind: r.kind, created_at: r.excluded_at, unseen: true })));
    mocks.state.client = { rpc: vi.fn(async (name: string) => (name === "excluded_parcels_unseen" ? own : answer)) };
  };
  const page = async () => ExcludedPage();
  const marks = async () => elementsOf<{ seenUntil: string }>(await page(), MarkAutoSeen);

  it("C6 the open automatic ones come first, then the others in the order the database gave", async () => {
    const userNewest = row({ kind: "user", shop: "押した店", excluded_at: "2026-11-17T05:00:00Z" });
    const arrived = row({ kind: "rule", shop: "届いた自動店", status: "delivered", excluded_at: "2026-11-17T04:00:00Z" });
    const autoOrdered = row({ kind: "rule", shop: "自動店A", status: "ordered", excluded_at: "2026-11-17T03:00:00Z" });
    const autoUnknown = row({ kind: "rule", shop: "自動店B", status: "unknown", excluded_at: "2026-11-17T02:00:00Z" });
    open(ok([userNewest, arrived, autoOrdered, autoUnknown]));
    const items = findAll(parseHtml(renderToStaticMarkup(await page())), (n) => n.tag === "li").map((n) => textOf(n));
    expect(items.map((t) => ["自動店A", "自動店B", "押した店", "届いた自動店"].find((s) => t.includes(s)))).toEqual(["自動店A", "自動店B", "押した店", "届いた自動店"]);
  });

  it("C11 each says who took it out: おとどけが自動で外しました on an automatic one, あなたが外しました on one pressed", async () => {
    open(ok([row({ kind: "rule", status: "ordered", shop: "自動店" }), row({ kind: "user", shop: "押した店" })]));
    const items = findAll(parseHtml(renderToStaticMarkup(await page())), (n) => n.tag === "li").map((n) => textOf(n));
    expect(items[0]).toContain(EXCLUDED_BY_RULE);
    expect(items[0]).not.toContain(EXCLUDED_BY_USER);
    expect(items[1]).toContain(EXCLUDED_BY_USER);
    expect(items[1]).not.toContain(EXCLUDED_BY_RULE);
  });

  it("C12 hands over the newest mark that is listed, not the time now and not a mark that is not listed", async () => {
    open(ok([
      row({ kind: "rule", status: "ordered", excluded_at: "2026-11-17T01:00:00+00:00" }),
      row({ kind: "rule", status: "unknown", excluded_at: "2026-11-17T03:30:00.123456+00:00" }),
      row({ kind: "rule", status: "ordered", excluded_at: "2026-11-17T02:00:00+00:00" }),
      row({ kind: "user", status: "ordered", excluded_at: "2026-11-17T09:00:00+00:00" }),
      row({ kind: "rule", status: "delivered", excluded_at: "2026-11-17T08:00:00+00:00" }),
      row({ kind: "rule", status: "cancelled", excluded_at: "2026-11-17T08:30:00+00:00" }),
    ]));
    const found = await marks();
    expect(found).toHaveLength(1);
    expect(found[0].props.seenUntil).toBe("2026-11-17T03:30:00.123456+00:00");
  });

  it.each([
    ["only a mark of the person's own", [{ kind: "user", status: "ordered" }]],
    ["automatic ones that have all arrived or been cancelled", [{ kind: "rule", status: "delivered" }, { kind: "rule", status: "cancelled" }]],
    ["nothing at all", []],
  ])("C10 (negative) opening with %s hands over no time, so nothing is written", async (_name, rows) => {
    open(ok(rows.map((r) => row(r))));
    expect(await marks()).toHaveLength(0);
  });

  it("C12 the time comes from the mark's created_at (excluded_parcels_unseen), and a failed read of it writes nothing", async () => {
    const a = row({ kind: "rule", status: "ordered", excluded_at: "2026-11-17T01:00:00Z" });
    const b = row({ kind: "rule", status: "ordered", excluded_at: "2026-11-17T01:00:00Z" });
    open(ok([a, b]), ok([{ parcel_id: a.parcel_id, kind: "rule", created_at: "2026-11-17T04:00:00+00:00", unseen: true }, { parcel_id: b.parcel_id, kind: "rule", created_at: "2026-11-17T06:00:00+00:00", unseen: true }]));
    expect((await marks())[0].props.seenUntil).toBe("2026-11-17T06:00:00+00:00");
    open(ok([a, b]), failed);
    expect(await marks()).toHaveLength(0);
    open(ok([a, b]), ok("ok"));
    expect(await marks()).toHaveLength(0);
  });

  it("C13 a read that failed hands over no time and says 読み込めませんでした", async () => {
    open(failed);
    const tree = await page();
    expect(elementsOf(tree, MarkAutoSeen)).toHaveLength(0);
    expect(textOf(parseHtml(renderToStaticMarkup(tree)))).toContain("読み込めませんでした");
  });

  it("C9 drawing the page and the list on the server writes nothing", async () => {
    open(ok([row({ kind: "rule", status: "ordered" })]));
    renderToStaticMarkup(await page());
    client([parcel()], { has_open_auto_exclusion: ok(true) });
    renderToStaticMarkup(await list());
    expect(mocks.seen).not.toHaveBeenCalled();
  });

  it("C9 the server parts of the two pages never import the write, and only the client part calls it", () => {
    for (const p of ["src/app/app/excluded/page.tsx", "src/app/app/page.tsx"]) {
      const src = source(p);
      expect(src, p).not.toMatch(/markAutoExcludedSeen|mark_auto_excluded_seen/);
      expect(src, p).not.toMatch(/from "\.\.?\/parcel-actions"|from "\.\/parcel-actions"/);
    }
    const client = source("src/app/app/excluded/mark-auto-seen.tsx");
    expect(client.startsWith('"use client";')).toBe(true);
    expect(client).toMatch(/useEffect\(/);
    expect(client).toContain("markAutoExcludedSeen(seenUntil)");
  });
});

describe("the pure parts", () => {
  it("seenUntilOf takes the newest open automatic mark, whatever the order, and null for none or for a time it cannot read", () => {
    let n = 0;
    const times: { parcel_id: string; created_at: string }[] = [];
    const r = (kind: string, status: string, excluded_at: string) => { const parcel_id = `p${++n}`; times.push({ parcel_id, created_at: excluded_at }); return { parcel_id, kind, status, excluded_at }; };
    expect(seenUntilOf([r("rule", "ordered", "2026-11-17T01:00:00Z"), r("rule", "ordered", "2026-11-17T02:00:00Z")], times)).toBe("2026-11-17T02:00:00Z");
    expect(seenUntilOf([r("rule", "ordered", "2026-11-17T02:00:00Z"), r("rule", "ordered", "2026-11-17T01:00:00Z")], times)).toBe("2026-11-17T02:00:00Z");
    expect(seenUntilOf([r("user", "ordered", "2026-11-17T02:00:00Z"), r("rule", "delivered", "2026-11-17T02:00:00Z")], times)).toBeNull();
    expect(seenUntilOf([r("rule", "ordered", "not a time")], times)).toBeNull();
    expect(seenUntilOf([], [])).toBeNull();
    expect(seenUntilOf([r("rule", "ordered", "2026-11-17T02:00:00Z")], null)).toBeNull();
  });

  it("orderExcluded keeps each group's order and moves no row away", () => {
    const rows = [{ kind: "user", status: "ordered", n: 1 }, { kind: "rule", status: "ordered", n: 2 }, { kind: "rule", status: "delivered", n: 3 }, { kind: "rule", status: "shipped", n: 4 }];
    expect(orderExcluded(rows).map((x) => x.n)).toEqual([2, 4, 1, 3]);
  });
});

describe("the notice sentence behind /app?excluded=<id>", () => {
  const mark = (kind: string) => ok([{ parcel_id: ID, kind }]);
  const text = async (answers: Record<string, Answer>) => {
    client([parcel()], { has_open_auto_exclusion: ok(false), ...answers });
    return elementsOf<{ id: string; text: string }>(await list(ID), ExcludedToast).map((el) => el.props.text);
  };

  it("is the second sentence when the app will start doing it by itself", async () => {
    expect(await text({ excluded_parcels: mark("user"), auto_exclusion_would_start: ok(true) })).toEqual([EXCLUDED_TOAST_AUTO]);
  });

  it.each([
    ["it will not start", { auto_exclusion_would_start: ok(false) }],
    ["the question failed", { auto_exclusion_would_start: failed }],
    ["the answer is not a clean yes", { auto_exclusion_would_start: ok("true") }],
  ])("is the plain sentence when %s", async (_name, answers) => {
    expect(await text({ excluded_parcels: mark("user"), ...answers })).toEqual([EXCLUDED_TOAST]);
  });

  it.each([
    ["a made-up id (no mark)", ok([])],
    ["a mark that the app made by itself", mark("rule")],
    ["a mark of another parcel", ok([{ parcel_id: "10000000-0000-4000-8000-0000000000ff", kind: "user" }])],
    ["a read that failed", failed],
    ["an answer that is not a list", ok("ok")],
  ])("is no notice for %s (it must not say it took out what it did not)", async (_name, answer) => {
    expect(await text({ excluded_parcels: answer, auto_exclusion_would_start: ok(true) })).toEqual([]);
  });

  it("asks nothing without the query", async () => {
    client([parcel()], { has_open_auto_exclusion: ok(false) });
    const db = mocks.state.client as FakeDb;
    await list();
    expect(db.rpcCalls.map((c) => c.name)).not.toContain("excluded_parcels");
  });
});
