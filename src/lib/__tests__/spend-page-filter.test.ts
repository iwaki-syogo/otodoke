import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { categoryLabel } from "@/lib/category";
import { todayJst, yen } from "@/lib/format";
import { expand, fakeEvent, findHosts, forced, type Host } from "./element-tree";
import { FakeDb } from "./fake-db";
import { ancestorsOf, classesOf, findAll, parseHtml, textOf, type HtmlNode } from "./html-tree";

/**
 * The spend page with ?s= and the order list over the whole period (task 3).
 *
 * - Order: total -> bars (whole period) -> 分類ごと -> 店ごと -> 注文.
 * - Each 店ごと row is a link adding ?s=<shop> (the selected row has aria-current="true" and
 *   takes ?s= off again). ?s= is kept by here(), MonthBars' query, the 月／全期間 switch and
 *   前月／翌月; category rows and their chip keep ?s=, shop rows and their chip keep ?c=.
 * - A chip 「◯◯だけ ×」 per condition takes off that condition only. With a condition and no
 *   order: 「この条件の注文はありません」; a month with no orders at all: 「この月の注文はありません」.
 * - The whole period lists every order too, under groupByOrderMonth's headings (undated last).
 *
 * Client part: src/app/app/spend/filter-link.tsx ("use client") exports
 *   FilterArea({ children })  - holds the one useTransition; while pending its contents get an
 *                               opacity class below 100;
 *   FilterLink({ href, children, className?, "aria-current"? }) - an <a href={href}> (next/link
 *                               or a plain anchor) used inside FilterArea for the category rows,
 *                               the shop rows and the chips. A click prevents the default and
 *                               calls router.push(href) in startTransition; while pending it is
 *                               aria-disabled="true" and a click does nothing but prevent the
 *                               default. The page builds every href (here()); the link never
 *                               builds a URL itself.
 */

const USER = "00000000-0000-4000-8000-00000000000a";

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
  usePathname: () => "/app/spend",
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

const A1 = parcel({ shop: "Amazon.co.jp", shop_key: "amazon", ordered_at: "2026-10-05", total_amount: 1000, category: "food" });
const A2 = parcel({ shop: "アマゾン", shop_key: "amazon", ordered_at: "2026-10-10", total_amount: 2000, category: null });
const Y = parcel({ shop: "テスト電機", shop_key: "other", ordered_at: "2026-10-12", total_amount: 5000, category: "electronics" });
const OLD = parcel({ shop: "テスト電機", shop_key: "other", ordered_at: "2026-09-01", total_amount: 700, category: "food" });
const U = parcel({ shop: "テスト電機", shop_key: "other", ordered_at: null, total_amount: 300, category: "food" });
const SEED = [A1, A2, Y, OLD, U];

let db: FakeDb;
beforeEach(() => {
  db = new FakeDb({ parcels: SEED });
  mocks.state.db = db;
  mocks.router.push = vi.fn();
  forced.pending = false;
});
afterEach(() => {
  forced.pending = false;
});

async function render(params: Record<string, string>) {
  const Page = (await import("@/app/app/spend/page")).default;
  return parseHtml(renderToStaticMarkup(await Page({ searchParams: Promise.resolve(params) } as never)));
}

const parse = (href: string) => {
  const u = new URL(href, "http://localhost");
  return { path: u.pathname, params: Object.fromEntries(u.searchParams) as Record<string, string> };
};
const spendLinks = (root: HtmlNode) => findAll(root, (n) => n.tag === "a" && (n.attrs.href ?? "").startsWith("/app/spend"));
const orderLinks = (root: HtmlNode) => findAll(root, (n) => n.tag === "a" && (n.attrs.href ?? "").startsWith("/app/parcels/"));
const orderIds = (root: HtmlNode) => orderLinks(root).map((n) => n.attrs.href.slice("/app/parcels/".length));
const chips = (root: HtmlNode) => spendLinks(root).filter((n) => /だけ\s*×/.test(textOf(n)));
/** The 店ごと row for a shop: a /app/spend link whose text starts with the shop's name, not a chip. */
const shopRow = (root: HtmlNode, shop: string) => {
  const rows = spendLinks(root).filter((n) => textOf(n).trim().startsWith(shop) && !/だけ\s*×/.test(textOf(n)));
  expect(rows, shop).toHaveLength(1);
  return rows[0];
};
/** Category rows: /app/spend links that carry a category label and are not chips. */
const categoryRows = (root: HtmlNode, labels: string[]) =>
  spendLinks(root).filter((n) => labels.some((l) => textOf(n).trim().startsWith(l)) && !/だけ\s*×/.test(textOf(n)));
const faint = (n: HtmlNode) => classesOf(n).some((c) => /^opacity-(\d+)$/.test(c) && Number(c.slice(8)) < 100);
/** The amount in the total card: the element right after the label that ends in 「合計」. */
const totalOf = (root: HtmlNode) => {
  const label = findAll(root, (n) => n.tag === "p" && /合計$/.test(textOf(n).trim()))[0];
  if (!label?.parent) return undefined;
  const siblings = label.parent.children.filter((c): c is HtmlNode => typeof c !== "string");
  const next = siblings[siblings.indexOf(label) + 1];
  return next ? textOf(next).trim() : undefined;
};

describe("spend page: order of the parts", () => {
  const positions = (root: HtmlNode) => {
    const all = findAll(root, () => true);
    const at = (pred: (n: HtmlNode) => boolean) => all.findIndex(pred);
    return {
      total: at((n) => n.tag === "p" && /合計$/.test(textOf(n).trim())),
      bars: at((n) => n.tag === "figure"),
      categories: at((n) => /^h[1-6]$/.test(n.tag) && textOf(n).trim() === "分類ごと"),
      shops: at((n) => /^h[1-6]$/.test(n.tag) && textOf(n).trim() === "店ごと"),
      orders: at((n) => /^h[1-6]$/.test(n.tag) && textOf(n).trim().startsWith("注文")),
    };
  };

  it("is total -> bars -> 分類ごと -> 店ごと -> 注文 over the whole period", async () => {
    const p = positions(await render({ m: "all" }));
    for (const v of Object.values(p)) expect(v).toBeGreaterThan(-1);
    expect(p.total).toBeLessThan(p.bars);
    expect(p.bars).toBeLessThan(p.categories);
    expect(p.categories).toBeLessThan(p.shops);
    expect(p.shops).toBeLessThan(p.orders);
  });

  it("is total -> 分類ごと -> 店ごと -> 注文 for a month", async () => {
    const p = positions(await render({ m: "2026-10" }));
    expect(p.total).toBeGreaterThan(-1);
    expect(p.total).toBeLessThan(p.categories);
    expect(p.categories).toBeLessThan(p.shops);
    expect(p.shops).toBeLessThan(p.orders);
  });
});

describe("spend page: the order list over the whole period", () => {
  it("lists every order, under order-month headings, newest first, undated last", async () => {
    const root = await render({ m: "all" });
    expect(orderIds(root)).toEqual([Y.id, A2.id, A1.id, OLD.id, U.id]);
    const text = textOf(root);
    const oct = text.indexOf("2026年10月に注文");
    const sep = text.indexOf("2026年9月に注文");
    const undated = text.indexOf("注文日不明");
    expect(oct).toBeGreaterThan(-1);
    expect(sep).toBeGreaterThan(oct);
    expect(undated).toBeGreaterThan(sep);
  });

  it("narrows the list and the figures by ?c= and ?s=, the undated note too", async () => {
    const root = await render({ m: "all", c: "food", s: "テスト電機" });
    expect(orderIds(root)).toEqual([OLD.id, U.id]);
    expect(totalOf(root)).toBe(yen(700));
    expect(textOf(root)).toMatch(/・\s*注文日の無い\s*1\s*件は除く/);
    // No brackets on a screen.
    expect(textOf(root)).not.toMatch(/[（）]/);
  });

  it("says 「この条件の注文はありません」 when narrowed to nothing", async () => {
    const root = await render({ m: "all", s: "どこにも無い店" });
    expect(orderLinks(root)).toHaveLength(0);
    expect(textOf(root)).toContain("この条件の注文はありません");
    expect(chips(root)).toHaveLength(1);
  });
});

describe("spend page: ?c= and ?s= for a month", () => {
  it("narrows the month's total by ?c= (an intended change) and by ?s=", async () => {
    expect(totalOf(await render({ m: "2026-10" }))).toBe(yen(8000));
    expect(totalOf(await render({ m: "2026-10", c: "food" }))).toBe(yen(1000));
    expect(totalOf(await render({ m: "2026-10", s: "Amazon" }))).toBe(yen(3000));
    expect(totalOf(await render({ m: "2026-10", c: "food", s: "Amazon" }))).toBe(yen(1000));
  });

  it("lists the orders both narrow", async () => {
    expect(orderIds(await render({ m: "2026-10", s: "Amazon" })).sort()).toEqual([A1.id, A2.id].sort());
    expect(orderIds(await render({ m: "2026-10", c: "food", s: "Amazon" }))).toEqual([A1.id]);
  });

  it("narrows the category rows by ?s= only and the shop rows by ?c= only", async () => {
    const root = await render({ m: "2026-10", c: "food", s: "テスト電機" });
    const labels = [categoryLabel("food"), categoryLabel("electronics"), categoryLabel(null)];
    // テスト電機 in October: electronics only (October's food is A1, Amazon's).
    const rows = categoryRows(root, labels);
    expect(rows).toHaveLength(1);
    expect(textOf(rows[0]).trim().startsWith(categoryLabel("electronics"))).toBe(true);
    // Food in October: only A1, so the shop rows read Amazon at ¥1,000.
    const text = textOf(root);
    const from = text.indexOf("店ごと");
    expect(text.slice(from, text.indexOf("注文", from))).toContain(`Amazon${yen(1000)}`);
  });

  it("keeps the chips and says 「この条件の注文はありません」 in a month with nothing that passes", async () => {
    const root = await render({ m: "2026-08", c: "food", s: "Amazon" });
    expect(textOf(root)).toContain("この条件の注文はありません");
    expect(chips(root)).toHaveLength(2);
  });

  it("says 「この月の注文はありません」 for an empty month with no condition, with no chip", async () => {
    const root = await render({ m: "2026-08" });
    expect(textOf(root)).toContain("この月の注文はありません");
    expect(chips(root)).toHaveLength(0);
  });

  it("narrows to nothing for a shop not in the data, with its chip to take it off", async () => {
    const root = await render({ m: "2026-10", s: "どこにも無い店" });
    expect(orderLinks(root)).toHaveLength(0);
    expect(textOf(root)).toContain("この条件の注文はありません");
    const c = chips(root);
    expect(c).toHaveLength(1);
    expect(textOf(c[0])).toContain("どこにも無い店");
    expect(parse(c[0].attrs.href)).toEqual({ path: "/app/spend", params: { m: "2026-10" } });
  });
});

describe("spend page: links keep ?c= and ?s=", () => {
  it("makes each 店ごと row a link adding ?s=, keeping ?c=", async () => {
    const root = await render({ m: "2026-10" });
    expect(parse(shopRow(root, "Amazon").attrs.href)).toEqual({ path: "/app/spend", params: { m: "2026-10", s: "Amazon" } });
    expect(parse(shopRow(root, "テスト電機").attrs.href)).toEqual({ path: "/app/spend", params: { m: "2026-10", s: "テスト電機" } });
    const withC = await render({ m: "2026-10", c: "food" });
    expect(parse(shopRow(withC, "Amazon").attrs.href)).toEqual({ path: "/app/spend", params: { m: "2026-10", c: "food", s: "Amazon" } });
  });

  it("takes ?s= off from the selected row, which reads as selected", async () => {
    const root = await render({ m: "all", c: "food", s: "Amazon" });
    const row = shopRow(root, "Amazon");
    expect(row.attrs["aria-current"]).toBe("true");
    expect(parse(row.attrs.href)).toEqual({ path: "/app/spend", params: { m: "all", c: "food" } });
  });

  it("keeps ?s= on the category rows", async () => {
    const root = await render({ m: "2026-10", s: "Amazon" });
    const rows = categoryRows(root, [categoryLabel("food"), categoryLabel(null)]);
    expect(rows.length).toBe(2);
    for (const r of rows) expect(parse(r.attrs.href).params.s, r.attrs.href).toBe("Amazon");
  });

  it("offers one chip per condition, each taking off only its own", async () => {
    const root = await render({ m: "2026-10", c: "food", s: "Amazon" });
    const c = chips(root);
    expect(c).toHaveLength(2);
    const category = c.find((x) => textOf(x).includes(categoryLabel("food")));
    const shop = c.find((x) => textOf(x).includes("Amazon"));
    expect(parse(category!.attrs.href)).toEqual({ path: "/app/spend", params: { m: "2026-10", s: "Amazon" } });
    expect(parse(shop!.attrs.href)).toEqual({ path: "/app/spend", params: { m: "2026-10", c: "food" } });
  });

  it("keeps ?c= and ?s= on 前月 and 翌月", async () => {
    const root = await render({ m: "2026-10", c: "food", s: "Amazon" });
    const prev = spendLinks(root).find((n) => textOf(n).includes("前月"));
    const next = spendLinks(root).find((n) => textOf(n).includes("翌月"));
    expect(parse(prev!.attrs.href)).toEqual({ path: "/app/spend", params: { m: "2026-09", c: "food", s: "Amazon" } });
    expect(parse(next!.attrs.href)).toEqual({ path: "/app/spend", params: { m: "2026-11", c: "food", s: "Amazon" } });
  });

  it("keeps ?s= on the 月／全期間 switch", async () => {
    const month = await render({ m: "2026-10", s: "Amazon" });
    const toAll = spendLinks(month).find((n) => textOf(n).trim() === "全期間");
    expect(parse(toAll!.attrs.href).params).toMatchObject({ m: "all", s: "Amazon" });
    const all = await render({ m: "all", s: "Amazon" });
    const toMonth = spendLinks(all).find((n) => textOf(n).trim() === "月");
    expect(parse(toMonth!.attrs.href).params).toMatchObject({ m: todayJst().slice(0, 7), s: "Amazon" });
  });

  it("keeps ?c= and ?s= on the bars", async () => {
    const root = await render({ m: "all", c: "food", s: "テスト電機" });
    const bars = findAll(root, (n) => n.tag === "figure").flatMap((f) => findAll(f, (n) => n.tag === "a"));
    expect(bars.length).toBeGreaterThan(0);
    for (const b of bars) expect(parse(b.attrs.href).params, b.attrs.href).toMatchObject({ c: "food", s: "テスト電機" });
  });

  it("[Codex-P3] carries a shop name over 100 characters whole, through the link and back", async () => {
    const nameA = `${"長".repeat(100)}A店`;
    const nameB = `${"長".repeat(100)}B店`;
    const a = parcel({ shop: nameA, shop_key: "other", ordered_at: "2026-10-01", total_amount: 10, category: "food" });
    const b = parcel({ shop: nameB, shop_key: "other", ordered_at: "2026-10-02", total_amount: 20, category: "food" });
    db = new FakeDb({ parcels: [...SEED, a, b] });
    mocks.state.db = db;
    const rows = spendLinks(await render({ m: "all" })).filter((n) => parse(n.attrs.href).params.s === nameA);
    expect(rows).toHaveLength(1);
    const s = parse(rows[0].attrs.href).params.s;
    expect(orderIds(await render({ m: "all", s }))).toEqual([a.id]);
  });
});

describe("spend page: right after a filter is pressed", () => {
  it("draws the figures and the orders faint and disables the filter links while pending", async () => {
    forced.pending = true;
    const root = await render({ m: "2026-10", c: "food" });
    const orders = orderLinks(root);
    expect(orders.length).toBeGreaterThan(0);
    for (const o of orders) expect(ancestorsOf(o).some(faint), o.attrs.href).toBe(true);
    const filters = [shopRow(root, "Amazon"), ...chips(root), ...categoryRows(root, [categoryLabel("food")])];
    expect(filters.length).toBeGreaterThanOrEqual(3);
    for (const f of filters) expect(f.attrs["aria-disabled"], f.attrs.href).toBe("true");
  });

  it("draws them plainly otherwise", async () => {
    const root = await render({ m: "2026-10", c: "food" });
    for (const o of orderLinks(root)) expect(ancestorsOf(o).some(faint), o.attrs.href).toBe(false);
    for (const f of [shopRow(root, "Amazon"), ...chips(root)]) expect(f.attrs["aria-disabled"]).not.toBe("true");
  });
});

describe("FilterArea / FilterLink (client part)", () => {
  type LinkProps = { href: string; children?: unknown; className?: string };
  const load = async () =>
    (await import("@/app/app/spend/filter-link")) as unknown as { FilterArea: (p: { children?: unknown }) => unknown; FilterLink: (p: LinkProps) => unknown };
  const HREF = "/app/spend?m=all&s=Amazon";
  const anchor = async () => {
    const { FilterArea, FilterLink } = await load();
    const nodes = expand(createElement(FilterArea as never, null, createElement(FilterLink as never, { href: HREF } as never, "Amazon")));
    const a = findHosts(nodes, (h) => h.type === "a" && h.props.href === HREF);
    expect(a).toHaveLength(1);
    return a[0];
  };
  const click = (a: Host) => {
    const ev = fakeEvent({ href: HREF });
    (a.props.onClick as (e: unknown) => void)(ev);
    return ev;
  };
  const pushed = () => (mocks.router.push as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0] as string);

  it("is a client component with the spinner of the other screens", () => {
    const source = readFileSync(path.resolve(__dirname, "../../app/app/spend/filter-link.tsx"), "utf8");
    expect(source.startsWith('"use client";')).toBe(true);
    expect(source).toContain("useTransition");
    expect(source).toContain("inline-block h-3 w-3 animate-spin rounded-full border-2 border-neutral-300 border-t-neutral-700");
  });

  it("goes to its href in a transition on a click", async () => {
    const ev = click(await anchor());
    expect(ev.defaultPrevented).toBe(true);
    expect(pushed()).toEqual([HREF]);
  });

  it("[Codex-P2] ignores a click while pending, and is marked disabled", async () => {
    forced.pending = true;
    const a = await anchor();
    expect(String(a.props["aria-disabled"])).toBe("true");
    const ev = click(a);
    expect(ev.defaultPrevented).toBe(true);
    expect(pushed()).toEqual([]);
  });
});

describe("spend page wiring", () => {
  const page = readFileSync(path.resolve(__dirname, "../../app/app/spend/page.tsx"), "utf8");

  it("draws the orders with OrderList and the filters with FilterArea / FilterLink", () => {
    expect(page).toMatch(/import\s*\{[^}]*\bOrderList\b[^}]*\}\s*from\s*["']\.\/order-list["']/);
    expect(page).toMatch(/<OrderList\b/);
    expect(page).toMatch(/import\s*\{[^}]*\bFilterLink\b[^}]*\}\s*from\s*["']\.\/filter-link["']/);
    expect(page).toMatch(/<FilterArea\b/);
    const list = readFileSync(path.resolve(__dirname, "../../app/app/spend/order-list.tsx"), "utf8");
    expect(page + list).toContain("groupByOrderMonth");
    expect(list).toContain("CategorySheet");
    expect(page).toContain("この条件の注文はありません");
  });
});
