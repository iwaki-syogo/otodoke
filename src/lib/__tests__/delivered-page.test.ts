import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CATEGORIES } from "@/lib/category";
import { deliveredFilterOptions } from "@/lib/delivered";
import type { ParcelRow } from "@/lib/match";
import { NONE } from "@/lib/shop";
import { expand, fakeEvent, findHosts, forced, hostText, type Host } from "./element-tree";
import { FakeDb, describeQuery, type Query } from "./fake-db";
import { ancestorsOf, classesOf, findAll, hasClasses, linksTo, parseHtml, textOf, type HtmlNode } from "./html-tree";

/**
 * /app/delivered with search and filters (task 2).
 *
 * Page: DeliveredPage({ searchParams: Promise<{ q?, s?, c?, m?: string | string[] }> }).
 * - getUser() (no user -> redirect("/login")); both reads add user_id = the user's id.
 * - parcels: the delivered ones through readAll, as before.
 * - items: parcel_items through readAll, select("parcel_id,name", { count: "exact" }), no .in().
 * - either read failing -> 「読み込めませんでした」 only. 0 delivered -> 「届いた荷物はありません」;
 *   0 after filtering -> 「見つかりません」.
 *
 * Client part: DeliveredFilter({ q, s, c, m, options, children }) from
 * src/app/app/delivered/filter-form.tsx ("use client"). q/s/c/m are the URL's values ("" when
 * absent), options = deliveredFilterOptions(all delivered parcels), children = the results the
 * server drew. It holds the one useTransition: the results get an opacity class and a spinner
 * shows while pending; while pending the selects are disabled and every filter action (select
 * change, search submit, クリア) is ignored. Otherwise each action calls
 * router.push(deliveredHref(...)) inside startTransition, from the component's own state (no
 * FormData / DOM reads).
 */

const USER = "00000000-0000-4000-8000-00000000000a";
const OTHER = "00000000-0000-4000-8000-00000000000b";

const mocks = vi.hoisted(() => ({
  state: { db: null as unknown },
  router: { push: (() => {}) as (href: string) => void, refresh: () => {}, replace: () => {}, back: () => {}, prefetch: () => {} },
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { forcedHooks } = await import("./element-tree");
  return forcedHooks(actual);
});
vi.mock("next/link", async () => {
  const { createElement: h } = await import("react");
  const { forced: f } = await import("./element-tree");
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const Link = ({ href, children, prefetch, scroll, replace, ...rest }: Record<string, unknown>) => h("a", { href: String(href), ...rest }, children as never);
  return { default: Link, useLinkStatus: () => ({ pending: f.pending }) };
});
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: vi.fn(),
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
  useRouter: () => mocks.router,
  usePathname: () => "/app/delivered",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => Object.assign(mocks.state.db as FakeDb, { auth: { getUser: async () => ({ data: { user: { id: USER } }, error: null }) } }),
  getUser: async () => ({ id: USER }),
}));

let seq = 0;
const parcel = (over: Record<string, unknown>) => ({
  id: `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`,
  user_id: USER,
  shop: "テスト店",
  title: `品名${seq}`,
  status: "delivered",
  updated_at: "2026-11-01T00:00:00Z",
  ...over,
});
let itemSeq = 0;
const item = (parcel_id: string, name: string, user_id = USER) => ({ id: `10000000-0000-4000-8000-${String(++itemSeq).padStart(12, "0")}`, parcel_id, user_id, name });

const D1 = parcel({ shop: "テスト雑貨", shop_key: "other", title: "ノート", ordered_at: "2026-10-30", category: null });
const D2 = parcel({ shop: "Amazon.co.jp", shop_key: "amazon", title: "USBケーブル", ordered_at: "2026-10-05", category: "electronics" });
const D3 = parcel({ shop: "アマゾン", shop_key: "amazon", title: "洗剤", ordered_at: "2026-09-20", category: "daily" });
const D4 = parcel({ shop: "テスト雑貨", shop_key: "other", title: "ペン", ordered_at: null, category: null });
const SHIPPED = parcel({ shop: "テスト雑貨", title: "まだのノート", status: "shipped", ordered_at: "2026-10-29" });
const THEIRS = parcel({ user_id: OTHER, shop: "テスト雑貨", title: "他人のノート", ordered_at: "2026-10-01" });
const MINE = [D1, D2, D3, D4];

const seedItems = () => [item(D2.id, "変換アダプタ"), item(D1.id, "秘密の品目", OTHER), item(THEIRS.id, "他人の品目", OTHER)];

let db: FakeDb;
beforeEach(() => {
  db = new FakeDb({ parcels: [...MINE, SHIPPED, THEIRS], parcel_items: seedItems() });
  mocks.state.db = db;
  mocks.router.push = vi.fn();
  forced.pending = false;
});
afterEach(() => {
  forced.pending = false;
});

type Params = Record<string, string | string[]>;
async function render(params: Params = {}) {
  const Page = (await import("@/app/app/delivered/page")).default as unknown as (p: { searchParams: Promise<Params> }) => Promise<Parameters<typeof renderToStaticMarkup>[0]>;
  return parseHtml(renderToStaticMarkup(await Page({ searchParams: Promise.resolve(params) })));
}

const parcelLinks = (root: HtmlNode) => findAll(root, (n) => n.tag === "a" && (n.attrs.href ?? "").startsWith("/app/parcels/"));
const shown = (root: HtmlNode) => parcelLinks(root).map((n) => n.attrs.href.slice("/app/parcels/".length));
const askedForUser = (q: Query) => q.filters.some((f) => f.method === "eq" && f.args[0] === "user_id" && f.args[1] === USER);
const fail = { data: null, error: { message: "boom" }, count: null };
/** An opacity below 100 (opacity-50, opacity-60, ...): the results drawn faint. */
const faint = (n: HtmlNode) => classesOf(n).some((c) => /^opacity-(\d+)$/.test(c) && Number(c.slice(8)) < 100);
const attr = (n: HtmlNode, name: string) => Object.entries(n.attrs).find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1];

describe("delivered page: reads", () => {
  it("[SEC-N1] adds user_id to the parcels read and the items read", async () => {
    await render({ q: "テスト" });
    const parcelsReads = db.callsOn("parcels", "select");
    const itemReads = db.callsOn("parcel_items", "select");
    expect(parcelsReads.length).toBeGreaterThan(0);
    expect(itemReads.length).toBeGreaterThan(0);
    for (const q of [...parcelsReads, ...itemReads]) expect(askedForUser(q), describeQuery(q)).toBe(true);
  });

  it("reads parcel_id,name of every item through readAll, never with .in()", async () => {
    await render({ q: "変換" });
    for (const q of db.callsOn("parcel_items", "select")) {
      expect((q.columns ?? "").replace(/\s/g, "")).toBe("parcel_id,name");
      expect(q.count).toBe("exact");
      expect(q.range, describeQuery(q)).not.toBeNull();
      expect(q.filters.some((f) => f.method === "in"), describeQuery(q)).toBe(false);
    }
  });

  it("finds a parcel by an item past the first 1,000 items", async () => {
    const many = Array.from({ length: 1000 }, (_, i) => item(D1.id, `部品${i}`));
    db = new FakeDb({ parcels: [...MINE], parcel_items: [...many, item(D3.id, "目印の品目")] });
    mocks.state.db = db;
    expect(shown(await render({ q: "目印" }))).toEqual([D3.id]);
  });

  it("says only 「読み込めませんでした」 when the items read fails", async () => {
    db.hooks.push((q) => (q.table === "parcel_items" ? fail : undefined));
    const root = await render({ q: "変換アダプタ" });
    const text = textOf(root);
    expect(text).toContain("読み込めませんでした");
    expect(text).not.toContain("見つかりません");
    expect(text).not.toContain("届いた荷物はありません");
    expect(parcelLinks(root)).toHaveLength(0);
  });

  it("says only 「読み込めませんでした」 when the parcels read fails", async () => {
    db.hooks.push((q) => (q.table === "parcels" ? fail : undefined));
    const root = await render();
    const text = textOf(root);
    expect(text).toContain("読み込めませんでした");
    expect(text).not.toContain("見つかりません");
    expect(text).not.toContain("届いた荷物はありません");
  });
});

describe("delivered page: results", () => {
  it("lists every delivered parcel, newest first, under order-month headings, undated last", async () => {
    const root = await render();
    expect(shown(root)).toEqual([D1.id, D2.id, D3.id, D4.id]);
    const text = textOf(root);
    const oct = text.indexOf("2026年10月に注文");
    const sep = text.indexOf("2026年9月に注文");
    const undated = text.indexOf("注文日不明");
    expect(oct).toBeGreaterThan(-1);
    expect(sep).toBeGreaterThan(oct);
    expect(undated).toBeGreaterThan(sep);
  });

  it("shows only the parcel an item name matches for ?q=", async () => {
    expect(shown(await render({ q: "変換アダプタ" }))).toEqual([D2.id]);
  });

  it("narrows by shop (Amazon's names as one), category and month together", async () => {
    expect(shown(await render({ s: "Amazon" }))).toEqual([D2.id, D3.id]);
    expect(shown(await render({ s: "Amazon", m: "2026-10" }))).toEqual([D2.id]);
    expect(shown(await render({ c: NONE }))).toEqual([D1.id, D4.id]);
    expect(shown(await render({ c: "daily" }))).toEqual([D3.id]);
  });

  it("says 「見つかりません」 when nothing passes, apart from having no delivered parcels", async () => {
    const root = await render({ q: "どこにも無い語" });
    expect(textOf(root)).toContain("見つかりません");
    expect(textOf(root)).not.toContain("届いた荷物はありません");
    expect(parcelLinks(root)).toHaveLength(0);
  });

  it("says 「届いた荷物はありません」 when there are none at all", async () => {
    db = new FakeDb({ parcels: [SHIPPED], parcel_items: [] });
    mocks.state.db = db;
    const text = textOf(await render({ q: "ノート" }));
    expect(text).toContain("届いた荷物はありません");
    expect(text).not.toContain("見つかりません");
  });

  it("[SEC-N1] shows no other user's parcel, and no other user's item makes a match", async () => {
    expect(shown(await render({ q: "ノート" }))).toEqual([D1.id]);
    const root = await render({ q: "秘密" });
    expect(parcelLinks(root)).toHaveLength(0);
    expect(textOf(root)).toContain("見つかりません");
    expect(textOf(await render())).not.toContain("他人");
  });

  it("takes the first of an array, ignores bad values and does not break on a long word", async () => {
    expect(shown(await render({ q: ["変換アダプタ", "ノート"], c: "toys", m: "2026-13", s: "無い店" }))).toEqual([D2.id]);
    expect(shown(await render({ m: "all" }))).toEqual([D1.id, D2.id, D3.id, D4.id]);
    const root = await render({ q: "x".repeat(500) });
    expect(textOf(root)).toContain("見つかりません");
  });
});

describe("delivered page: the form", () => {
  const formOf = (root: HtmlNode) => {
    const forms = findAll(root, (n) => n.tag === "form");
    expect(forms).toHaveLength(1);
    return forms[0];
  };
  const selectNamed = (root: HtmlNode, name: string) => {
    const s = findAll(root, (n) => n.tag === "select" && n.attrs.name === name);
    expect(s, name).toHaveLength(1);
    return s[0];
  };
  const values = (select: HtmlNode) => findAll(select, (n) => n.tag === "option").map((o) => o.attrs.value ?? "");

  it("is a GET form to /app/delivered with a 16px search box q", async () => {
    const root = await render({ q: "ノート" });
    const form = formOf(root);
    expect(form.attrs.action).toBe("/app/delivered");
    expect((form.attrs.method ?? "get").toLowerCase()).toBe("get");
    const inputs = findAll(form, (n) => n.tag === "input" && n.attrs.name === "q");
    expect(inputs).toHaveLength(1);
    expect(inputs[0].attrs.type).toBe("search");
    expect(attr(inputs[0], "enterKeyHint")).toBe("search");
    expect(hasClasses(inputs[0], "text-base"), inputs[0].attrs.class).toBe(true);
    expect(inputs[0].attrs.value).toBe("ノート");
  });

  it("offers s, c and m as selects built from the data, with the URL's choice selected", async () => {
    const root = await render({ s: "Amazon", c: NONE, m: "2026-10" });
    const form = formOf(root);
    const s = selectNamed(form, "s");
    const c = selectNamed(form, "c");
    const m = selectNamed(form, "m");
    expect(values(s).filter(Boolean)).toEqual(["Amazon", "テスト雑貨"]);
    expect(values(c).filter(Boolean)).toEqual([...CATEGORIES, NONE]);
    expect(values(m).filter(Boolean)).toEqual(["2026-10", "2026-09"]);
    const selected = (sel: HtmlNode) => findAll(sel, (n) => n.tag === "option" && "selected" in n.attrs).map((o) => o.attrs.value);
    expect(selected(s)).toEqual(["Amazon"]);
    expect(selected(c)).toEqual([NONE]);
    expect(selected(m)).toEqual(["2026-10"]);
  });

  it("offers 「クリア」 back to /app/delivered while narrowed", async () => {
    const root = await render({ q: "ノート" });
    const clear = findAll(root, (n) => n.tag === "a" && textOf(n).trim() === "クリア");
    expect(clear).toHaveLength(1);
    expect(clear[0].attrs.href).toBe("/app/delivered");
  });

  it("keeps the back link to 荷物", async () => {
    expect(linksTo(await render(), "/app")).toHaveLength(1);
  });
});

describe("delivered page: right after a filter is changed", () => {
  it("draws the results faint with a spinner and disables the selects while pending", async () => {
    forced.pending = true;
    const root = await render({ q: "ノート" });
    const links = parcelLinks(root);
    expect(links.length).toBeGreaterThan(0);
    for (const l of links) expect(ancestorsOf(l).some(faint), l.attrs.href).toBe(true);
    expect(findAll(root, (n) => hasClasses(n, "animate-spin")).length).toBeGreaterThan(0);
    for (const s of findAll(root, (n) => n.tag === "select")) expect("disabled" in s.attrs, s.attrs.name).toBe(true);
  });

  it("draws them plainly with no spinner otherwise", async () => {
    const root = await render({ q: "ノート" });
    for (const l of parcelLinks(root)) expect(ancestorsOf(l).some(faint), l.attrs.href).toBe(false);
    expect(findAll(root, (n) => hasClasses(n, "animate-spin"))).toHaveLength(0);
    for (const s of findAll(root, (n) => n.tag === "select")) expect("disabled" in s.attrs, s.attrs.name).toBe(false);
  });
});

describe("DeliveredFilter (client part)", () => {
  type Props = { q: string; s: string; c: string; m: string; options: ReturnType<typeof deliveredFilterOptions>; children?: unknown };
  const load = async () => (await import("@/app/app/delivered/filter-form")) as unknown as { DeliveredFilter: (p: Props) => unknown };
  const props = (over: Partial<Props> = {}): Props => ({
    q: "ノート",
    s: "",
    c: "",
    m: "",
    options: deliveredFilterOptions(MINE as unknown as ParcelRow[]),
    children: createElement("div", { id: "results" }, "結果"),
    ...over,
  });
  const tree = async (over: Partial<Props> = {}) => {
    const { DeliveredFilter } = await load();
    return expand(createElement(DeliveredFilter as never, props(over) as never));
  };
  const select = (nodes: Array<Host | string>, name: string) => {
    const s = findHosts(nodes, (h) => h.type === "select" && h.props.name === name);
    expect(s, name).toHaveLength(1);
    return s[0];
  };
  const form = (nodes: Array<Host | string>) => {
    const f = findHosts(nodes, (h) => h.type === "form");
    expect(f).toHaveLength(1);
    return f[0];
  };
  const clear = (nodes: Array<Host | string>) => {
    const c = findHosts(nodes, (h) => h.type === "a" && hostText(h).trim() === "クリア");
    expect(c).toHaveLength(1);
    return c[0];
  };
  const pushed = () => (mocks.router.push as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0] as string);
  const parse = (href: string) => {
    const u = new URL(href, "http://localhost");
    return { path: u.pathname, params: Object.fromEntries(u.searchParams) };
  };
  const call = (h: Host, handler: string, ev: ReturnType<typeof fakeEvent>) => (h.props[handler] as (e: unknown) => void)(ev);

  it("is a client component", async () => {
    const { readFileSync } = await import("node:fs");
    const path = await import("node:path");
    const source = readFileSync(path.resolve(__dirname, "../../app/app/delivered/filter-form.tsx"), "utf8");
    expect(source.startsWith('"use client";')).toBe(true);
    expect(source).toContain("useTransition");
  });

  it("goes to the new URL as soon as a select changes, keeping the other values", async () => {
    const nodes = await tree();
    call(select(nodes, "c"), "onChange", fakeEvent({ name: "c", value: "daily" }));
    expect(pushed().map(parse)).toEqual([{ path: "/app/delivered", params: { q: "ノート", c: "daily" } }]);
  });

  it("sends the search on submit, without the browser's own submit", async () => {
    const nodes = await tree({ s: "Amazon" });
    const ev = fakeEvent();
    call(form(nodes), "onSubmit", ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(pushed().map(parse)).toEqual([{ path: "/app/delivered", params: { q: "ノート", s: "Amazon" } }]);
  });

  it("clears every value with 「クリア」", async () => {
    const nodes = await tree({ s: "Amazon", c: NONE, m: "2026-10" });
    const ev = fakeEvent({ href: "/app/delivered" });
    call(clear(nodes), "onClick", ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(pushed()).toEqual(["/app/delivered"]);
  });

  it("[Codex-P2] ignores every filter action while pending", async () => {
    forced.pending = true;
    const nodes = await tree({ s: "Amazon" });
    call(select(nodes, "c"), "onChange", fakeEvent({ name: "c", value: "daily" }));
    call(select(nodes, "s"), "onChange", fakeEvent({ name: "s", value: "テスト雑貨" }));
    call(select(nodes, "m"), "onChange", fakeEvent({ name: "m", value: "2026-09" }));
    const submit = fakeEvent();
    call(form(nodes), "onSubmit", submit);
    const click = fakeEvent({ href: "/app/delivered" });
    call(clear(nodes), "onClick", click);
    expect(pushed()).toEqual([]);
    // The browser must not send the form or follow the link on its own either.
    expect(submit.defaultPrevented).toBe(true);
    expect(click.defaultPrevented).toBe(true);
  });

  it("[Codex-P2] disables the selects and the 「クリア」 link while pending", async () => {
    forced.pending = true;
    const nodes = await tree({ s: "Amazon" });
    for (const name of ["s", "c", "m"]) expect(select(nodes, name).props.disabled, name).toBe(true);
    expect(String(clear(nodes).props["aria-disabled"])).toBe("true");
  });

  it("wraps the results it is given, faint with a spinner while pending", async () => {
    forced.pending = true;
    const root = parseHtml(renderToStaticMarkup(createElement((await load()).DeliveredFilter as never, props() as never)));
    const results = findAll(root, (n) => n.attrs.id === "results");
    expect(results).toHaveLength(1);
    expect(ancestorsOf(results[0]).some(faint)).toBe(true);
    expect(findAll(root, (n) => hasClasses(n, "animate-spin", "rounded-full", "border-2", "border-neutral-300", "border-t-neutral-700")).length).toBeGreaterThan(0);
  });
});
