import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { categoryLabel } from "@/lib/category";
import { deliveredFilterOptions, filterDelivered, monthChoices, searchWord } from "@/lib/delivered";
import type { ParcelRow } from "@/lib/match";
import { monthMax } from "@/lib/month-url";
import { SHOP_LABEL_MAX, shopLabel } from "@/lib/shop";
import { expand, fakeEvent, findHosts, forced, type Host } from "./element-tree";
import { FakeDb, describeQuery, type Query } from "./fake-db";
import { findAll, parseHtml, textOf, type HtmlNode } from "./html-tree";

/**
 * Review fixes on the second batch (orch-20261104-024133-643b, iteration 1):
 * - [S2][Codex-C1][Q4] every control that changes the spend screen's conditions (月／全期間,
 *   前月／翌月, the month picker, the bars, the rows, the chips) shares one transition: while it is
 *   pending each is aria-disabled and ignores a click; the picker's input is disabled. The
 *   calendar's 前月／翌月 and picker share one too.
 * - [S1] on a touch screen the picker sends on blur (the wheels closed), not on each change.
 * - [V1] min / max come from the page.
 * - [Codex-C2][N2] the delivered search box is read-only while pending.
 * - [Q1][N1] a well-formed ?m= the data lacks is offered and selected.
 * - [Q2] the page passes ?q= as given; searchWord trims and cuts it.
 * - [SEC-N1] ?s= is cut for display only. [SEC-N2] the spend read adds user_id.
 * - [N3] the total's label reads category then shop, as the chips do. [N4] shop rows do not prefetch.
 */

const USER = "00000000-0000-4000-8000-00000000000a";
const OTHER = "00000000-0000-4000-8000-00000000000b";

const mocks = vi.hoisted(() => ({
  state: { db: null as unknown, user: { id: "00000000-0000-4000-8000-00000000000a" } as { id: string } | null },
  router: { push: (() => {}) as (href: string) => void, refresh: () => {}, replace: () => {}, back: () => {}, prefetch: () => {} },
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { forcedHooks } = await import("./element-tree");
  return forcedHooks(actual);
});
vi.mock("next/link", async () => {
  const { createElement: h } = await import("react");
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const Link = ({ href, children, prefetch, scroll, replace, ...rest }: Record<string, unknown>) =>
    h("a", { href: String(href), "data-prefetch": prefetch === undefined ? undefined : String(prefetch), ...rest }, children as never);
  return { default: Link };
});
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`NEXT_REDIRECT ${to}`);
  },
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
  useRouter: () => mocks.router,
  usePathname: () => "/app/spend",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => Object.assign(mocks.state.db as FakeDb, { auth: { getUser: async () => ({ data: { user: mocks.state.user }, error: null }) } }),
  getUser: async () => mocks.state.user,
}));

let seq = 0;
const parcel = (over: Record<string, unknown>) => ({
  id: `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`,
  user_id: USER,
  shop: "テスト店",
  title: `品名${seq}`,
  status: "delivered",
  received_at: "2026-11-01T00:00:00Z",
  updated_at: "2026-11-01T00:00:00Z",
  ...over,
});

const A1 = parcel({ shop: "Amazon.co.jp", shop_key: "amazon", ordered_at: "2026-10-05", total_amount: 1000, category: "food" });
const Y = parcel({ shop: "テスト電機", shop_key: "other", ordered_at: "2026-10-12", total_amount: 5000, category: "electronics" });
const OLD = parcel({ shop: "テスト電機", shop_key: "other", ordered_at: "2026-09-01", total_amount: 700, category: "food" });
const THEIRS = parcel({ user_id: OTHER, shop: "他人の店", shop_key: "other", ordered_at: "2026-10-03", total_amount: 99999, category: "food" });
const SEED = [A1, Y, OLD, THEIRS];

let db: FakeDb;
beforeEach(() => {
  db = new FakeDb({ parcels: SEED });
  mocks.state.db = db;
  mocks.state.user = { id: USER };
  mocks.router.push = vi.fn();
  forced.pending = false;
});
afterEach(() => {
  forced.pending = false;
  vi.unstubAllGlobals();
});

const pushed = () => (mocks.router.push as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0] as string);
const parse = (href: string) => {
  const u = new URL(href, "http://localhost");
  return { path: u.pathname, params: Object.fromEntries(u.searchParams) as Record<string, string> };
};
const call = (h: Host, handler: string, ev: ReturnType<typeof fakeEvent>) => (h.props[handler] as (e: unknown) => void)(ev);

async function renderPage(mod: string, params: Record<string, string>) {
  const Page = (await import(mod)).default as (p: { searchParams: Promise<Record<string, string>> }) => Promise<Parameters<typeof renderToStaticMarkup>[0]>;
  return parseHtml(renderToStaticMarkup(await Page({ searchParams: Promise.resolve(params) })));
}
const spend = (params: Record<string, string>) => renderPage("@/app/app/spend/page", params);
const spendLinks = (root: HtmlNode) => findAll(root, (n) => n.tag === "a" && (n.attrs.href ?? "").startsWith("/app/spend"));
const chips = (root: HtmlNode) => spendLinks(root).filter((n) => /だけ\s*×/.test(textOf(n)));
const totalLabel = (root: HtmlNode) => textOf(findAll(root, (n) => n.tag === "p" && /合計$/.test(textOf(n).trim()))[0]).trim();
const monthInputs = (root: HtmlNode) => findAll(root, (n) => n.tag === "input" && n.attrs.type === "month");

type PickerProps = { value: string; basePath: string; keep?: Record<string, string | undefined>; min?: string; max?: string };
const loadPicker = async () => (await import("@/app/app/month-picker")) as unknown as { MonthPicker: (p: PickerProps) => unknown };
const loadFilter = async () =>
  (await import("@/app/app/spend/filter-link")) as unknown as {
    FilterScope: (p: { children?: unknown }) => unknown;
    FilterArea: (p: { children?: unknown }) => unknown;
    FilterLink: (p: { href: string; children?: unknown }) => unknown;
  };
const monthInput = (nodes: Array<Host | string>) => {
  const i = findHosts(nodes, (h) => h.type === "input" && h.props.type === "month");
  expect(i).toHaveLength(1);
  return i[0];
};

describe("[S2][Codex-C1] the spend screen: one transition for every condition", () => {
  it("disables every link that changes the conditions while pending: 月／全期間, 前月／翌月, rows, chips", async () => {
    forced.pending = true;
    const root = await spend({ m: "2026-10", c: "food", s: "Amazon" });
    const links = spendLinks(root);
    const texts = links.map((n) => textOf(n).trim());
    for (const t of ["月", "全期間", "‹ 前月", "翌月 ›"]) expect(texts, t).toContain(t);
    expect(chips(root)).toHaveLength(2);
    for (const l of links) expect(l.attrs["aria-disabled"], `${textOf(l).trim()} ${l.attrs.href}`).toBe("true");
  });

  it("disables the bars over the whole period while pending", async () => {
    forced.pending = true;
    const root = await spend({ m: "all", s: "テスト電機" });
    const bars = findAll(root, (n) => n.tag === "figure").flatMap((f) => findAll(f, (n) => n.tag === "a"));
    expect(bars.length).toBeGreaterThan(0);
    for (const b of bars) expect(b.attrs["aria-disabled"], b.attrs.href).toBe("true");
  });

  it("disables the month picker's input while pending", async () => {
    forced.pending = true;
    const inputs = monthInputs(await spend({ m: "2026-10" }));
    expect(inputs).toHaveLength(1);
    expect("disabled" in inputs[0].attrs).toBe(true);
  });

  it("leaves them all enabled otherwise", async () => {
    const root = await spend({ m: "2026-10", c: "food", s: "Amazon" });
    for (const l of spendLinks(root)) expect(l.attrs["aria-disabled"], l.attrs.href).toBeUndefined();
    expect("disabled" in monthInputs(root)[0].attrs).toBe(false);
    const all = await spend({ m: "all" });
    for (const l of spendLinks(all)) expect(l.attrs["aria-disabled"], l.attrs.href).toBeUndefined();
  });

  it("wires the period, the months and the bars through FilterScope / FilterLink", () => {
    const page = readFileSync(path.resolve(__dirname, "../../app/app/spend/page.tsx"), "utf8");
    expect(page).toMatch(/<FilterScope\b/);
    expect(page).not.toMatch(/<Link\b/);
    const bars = readFileSync(path.resolve(__dirname, "../../app/app/spend/month-bars.tsx"), "utf8");
    expect(bars).toMatch(/<FilterLink\b/);
    expect(bars).not.toMatch(/<Link\b/);
  });
});

describe("[S2][Codex-C1][Q4] FilterScope with the month picker and a link", () => {
  const tree = async () => {
    const { FilterScope, FilterLink } = await loadFilter();
    const { MonthPicker } = await loadPicker();
    return expand(
      createElement(
        FilterScope as never,
        null,
        createElement(MonthPicker as never, { value: "2026-10", basePath: "/app/spend", keep: { s: "Amazon" } } as never),
        createElement(FilterLink as never, { href: "/app/spend?m=2026-09&s=Amazon" } as never, "‹ 前月"),
      ),
    );
  };
  const link = (nodes: Array<Host | string>) => findHosts(nodes, (h) => h.type === "a")[0];

  it("sends the picked month through the scope's transition", async () => {
    call(monthInput(await tree()), "onChange", fakeEvent({ value: "2026-05" }));
    expect(pushed().map(parse)).toEqual([{ path: "/app/spend", params: { m: "2026-05", s: "Amazon" } }]);
  });

  it("ignores the picker and the link while the scope is pending", async () => {
    forced.pending = true;
    const nodes = await tree();
    const input = monthInput(nodes);
    expect(input.props.disabled).toBe(true);
    call(input, "onChange", fakeEvent({ value: "2026-05" }));
    call(input, "onBlur", fakeEvent({ value: "2026-05" }));
    const click = fakeEvent({ href: "/app/spend?m=2026-09&s=Amazon" });
    call(link(nodes), "onClick", click);
    expect(click.defaultPrevented).toBe(true);
    expect(String(link(nodes).props["aria-disabled"])).toBe("true");
    expect(pushed()).toEqual([]);
  });

  it("[Q4] ignores a second change on the picker alone while its own move is pending", async () => {
    forced.pending = true;
    const { MonthPicker } = await loadPicker();
    const input = monthInput(expand(createElement(MonthPicker as never, { value: "2026-10", basePath: "/app/calendar" } as never)));
    expect(input.props.disabled).toBe(true);
    call(input, "onChange", fakeEvent({ value: "2026-05" }));
    expect(pushed()).toEqual([]);
  });
});

describe("the calendar heading shares one transition", () => {
  it("disables 前月／翌月 and the picker while pending, not otherwise", async () => {
    forced.pending = true;
    const busy = await renderPage("@/app/app/calendar/page", { m: "2026-10" });
    const moves = findAll(busy, (n) => n.tag === "a" && (n.attrs.href ?? "").startsWith("/app/calendar?m="));
    expect(moves).toHaveLength(2);
    for (const a of moves) expect(a.attrs["aria-disabled"], a.attrs.href).toBe("true");
    expect("disabled" in monthInputs(busy)[0].attrs).toBe(true);

    forced.pending = false;
    const idle = await renderPage("@/app/app/calendar/page", { m: "2026-10" });
    for (const a of findAll(idle, (n) => n.tag === "a" && (n.attrs.href ?? "").startsWith("/app/calendar?m="))) expect(a.attrs["aria-disabled"]).toBeUndefined();
    expect("disabled" in monthInputs(idle)[0].attrs).toBe(false);
  });
});

describe("[S1] the month picker on a touch screen", () => {
  const input = async () => {
    const { MonthPicker } = await loadPicker();
    return monthInput(expand(createElement(MonthPicker as never, { value: "2026-10", basePath: "/app/calendar" } as never)));
  };

  it("holds the month while the wheels turn and sends it when the picker closes (blur)", async () => {
    vi.stubGlobal("window", { matchMedia: (q: string) => ({ matches: q === "(pointer: coarse)" }) });
    const i = await input();
    call(i, "onChange", fakeEvent({ value: "2027-10" }));
    call(i, "onChange", fakeEvent({ value: "2027-03" }));
    expect(pushed()).toEqual([]);
    call(i, "onBlur", fakeEvent({ value: "2027-03" }));
    expect(pushed().map(parse)).toEqual([{ path: "/app/calendar", params: { m: "2027-03" } }]);
  });

  it("sends nothing on a blur with nothing turned", async () => {
    vi.stubGlobal("window", { matchMedia: () => ({ matches: true }) });
    call(await input(), "onBlur", fakeEvent({ value: "2026-10" }));
    expect(pushed()).toEqual([]);
  });

  it("sends at once on a change with a mouse", async () => {
    vi.stubGlobal("window", { matchMedia: () => ({ matches: false }) });
    call(await input(), "onChange", fakeEvent({ value: "2026-05" }));
    expect(pushed().map(parse)).toEqual([{ path: "/app/calendar", params: { m: "2026-05" } }]);
  });

  it("does not move for the month already shown", async () => {
    call(await input(), "onChange", fakeEvent({ value: "2026-10" }));
    expect(pushed()).toEqual([]);
  });
});

describe("[V1] the picker's bounds come from the page", () => {
  it("draws the min / max it is given", async () => {
    const { MonthPicker } = await loadPicker();
    const root = parseHtml(renderToStaticMarkup(createElement(MonthPicker as never, { value: "2026-10", basePath: "/app/calendar", min: "2021-01", max: "2030-12" } as never)));
    const i = monthInputs(root)[0];
    expect(i.attrs.min).toBe("2021-01");
    expect(i.attrs.max).toBe("2030-12");
  });

  it("is given max = monthMax(today) by the calendar and the spend page", async () => {
    for (const mod of ["calendar", "spend"]) {
      const source = readFileSync(path.resolve(__dirname, `../../app/app/${mod}/page.tsx`), "utf8");
      expect(source, mod).toMatch(/<MonthPicker\b[^>]*\bmin=\{MONTH_MIN\}[^>]*\bmax=\{monthMax\(today\)\}/);
    }
    expect(monthInputs(await spend({ m: "2026-10" }))[0].attrs.max).toBe(monthMax());
  });
});

describe("[SEC-N1] ?s= is cut for display only", () => {
  it("shopLabel cuts past SHOP_LABEL_MAX characters with 「…」, by character", () => {
    expect(SHOP_LABEL_MAX).toBe(40);
    expect(shopLabel("Amazon")).toBe("Amazon");
    expect(shopLabel("あ".repeat(40))).toBe("あ".repeat(40));
    expect(shopLabel("あ".repeat(41))).toBe(`${"あ".repeat(40)}…`);
    expect(shopLabel("😀".repeat(41))).toBe(`${"😀".repeat(40)}…`);
  });

  it("shows a long ?s= cut in the chip and the total's label, and still narrows and links by the whole name", async () => {
    const long = "長".repeat(60);
    const mine = parcel({ shop: long, shop_key: "other", ordered_at: "2026-10-07", total_amount: 10, category: "food" });
    const near = parcel({ shop: `${"長".repeat(40)}別`, shop_key: "other", ordered_at: "2026-10-08", total_amount: 20, category: "food" });
    db = new FakeDb({ parcels: [...SEED, mine, near] });
    mocks.state.db = db;
    const root = await spend({ m: "2026-10", s: long });
    const c = chips(root);
    expect(c).toHaveLength(1);
    expect(textOf(c[0])).toContain(`${"長".repeat(40)}…だけ`);
    expect(textOf(c[0])).not.toContain("長".repeat(41));
    expect(totalLabel(root)).toBe(`${"長".repeat(40)}…の合計`);
    // Compared in full: the 40-character twin does not pass.
    const orders = findAll(root, (n) => n.tag === "a" && (n.attrs.href ?? "").startsWith("/app/parcels/")).map((n) => n.attrs.href.slice("/app/parcels/".length));
    expect(orders).toEqual([mine.id]);
    // The links that keep ?s= (period, months, the category rows) keep the name in full.
    const keepS = spendLinks(root).filter((n) => ["月", "全期間", "‹ 前月", "翌月 ›"].includes(textOf(n).trim()) || textOf(n).trim().startsWith(categoryLabel("food")));
    expect(keepS.length).toBe(5);
    for (const l of keepS) expect(parse(l.attrs.href).params.s, l.attrs.href).toBe(long);
  });
});

describe("[SEC-N2] the spend page reads the user's own parcels", () => {
  const askedForUser = (q: Query) => q.filters.some((f) => f.method === "eq" && f.args[0] === "user_id" && f.args[1] === USER);

  it("adds user_id to the parcels read, for a month and for the whole period", async () => {
    for (const m of ["2026-10", "all"]) {
      db = new FakeDb({ parcels: SEED });
      mocks.state.db = db;
      const root = await spend({ m });
      const reads = db.callsOn("parcels", "select");
      expect(reads.length, m).toBeGreaterThan(0);
      for (const q of reads) expect(askedForUser(q), describeQuery(q)).toBe(true);
      expect(textOf(root), m).not.toContain("他人の店");
    }
  });

  it("sends a signed-out visitor to /login", async () => {
    mocks.state.user = null;
    await expect(spend({ m: "2026-10" })).rejects.toThrow("NEXT_REDIRECT /login");
  });
});

describe("[N3] the total's label and the chips read category, then shop", () => {
  it("reads 「食品・Amazonの合計」 and the chips in the same order", async () => {
    const root = await spend({ m: "2026-10", c: "food", s: "Amazon" });
    expect(totalLabel(root)).toBe(`${categoryLabel("food")}・Amazonの合計`);
    const c = chips(root).map((n) => textOf(n));
    expect(c[0]).toContain(categoryLabel("food"));
    expect(c[1]).toContain("Amazon");
  });
});

describe("[N4] the shop rows do not prefetch", () => {
  it("marks each 店ごと row prefetch={false}", async () => {
    const root = await spend({ m: "2026-10" });
    const rows = spendLinks(root).filter((n) => parse(n.attrs.href).params.s !== undefined && !/だけ\s*×/.test(textOf(n)));
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.attrs["data-prefetch"], r.attrs.href).toBe("false");
  });
});

describe("[Codex-C2][N2] the delivered search box while pending", () => {
  const box = async () => {
    const { DeliveredFilter } = (await import("@/app/app/delivered/filter-form")) as unknown as { DeliveredFilter: (p: unknown) => unknown };
    const nodes = expand(createElement(DeliveredFilter as never, { q: "ノート", s: "", c: "", m: "", options: deliveredFilterOptions([]), children: null } as never));
    const q = findHosts(nodes, (h) => h.type === "input" && h.props.name === "q");
    expect(q).toHaveLength(1);
    return q[0];
  };

  it("is read-only while pending and editable otherwise", async () => {
    forced.pending = true;
    expect((await box()).props.readOnly).toBe(true);
    forced.pending = false;
    expect((await box()).props.readOnly).toBe(false);
  });
});

describe("[Q1][N1][Q2] the delivered page's ?m= and ?q=", () => {
  const D1 = parcel({ shop: "テスト雑貨", shop_key: "other", title: "ノート", ordered_at: "2026-10-30", category: null });
  const D2 = parcel({ shop: "テスト雑貨", shop_key: "other", title: "ペン", ordered_at: "2026-09-02", category: null });
  const delivered = async (params: Record<string, string>) => {
    db = new FakeDb({ parcels: [D1, D2], parcel_items: [] });
    mocks.state.db = db;
    return renderPage("@/app/app/delivered/page", params);
  };
  const monthSelect = (root: HtmlNode) => findAll(root, (n) => n.tag === "select" && n.attrs.name === "m")[0];
  const options = (sel: HtmlNode) => findAll(sel, (n) => n.tag === "option");

  it("monthChoices adds a well-formed month the data lacks, newest first, and nothing else", () => {
    expect(monthChoices(["2026-10", "2026-09"], "2026-03")).toEqual(["2026-10", "2026-09", "2026-03"]);
    expect(monthChoices(["2026-10", "2026-09"], "2027-01")).toEqual(["2027-01", "2026-10", "2026-09"]);
    expect(monthChoices(["2026-10"], "2026-10")).toEqual(["2026-10"]);
    for (const bad of ["", undefined, "2026-13", "all", "2026-1"]) expect(monthChoices(["2026-10"], bad), String(bad)).toEqual(["2026-10"]);
  });

  it("offers and selects a well-formed ?m= the data lacks, with nothing found", async () => {
    const root = await delivered({ m: "2025-01" });
    const opts = options(monthSelect(root));
    expect(opts.map((o) => o.attrs.value).filter(Boolean)).toEqual(["2026-10", "2026-09", "2025-01"]);
    expect(opts.filter((o) => "selected" in o.attrs).map((o) => o.attrs.value)).toEqual(["2025-01"]);
    expect(textOf(root)).toContain("見つかりません");
  });

  it("offers no extra month for a malformed ?m=", async () => {
    const opts = options(monthSelect(await delivered({ m: "2026-13" })));
    expect(opts.map((o) => o.attrs.value).filter(Boolean)).toEqual(["2026-10", "2026-09"]);
  });

  it("searchWord trims, then cuts to 100", () => {
    expect(searchWord(undefined)).toBe("");
    expect(searchWord("  ノート  ")).toBe("ノート");
    expect(searchWord(`${" ".repeat(98)}ノートX`)).toBe("ノートX");
    expect(searchWord("x".repeat(150))).toBe("x".repeat(100));
  });

  it("leaves ?q= to filterDelivered: leading spaces do not eat the word's end", async () => {
    // Cut before trimming, this would search 「ノー」 and find the ノート parcel.
    const q = `${" ".repeat(98)}ノートX`;
    expect(filterDelivered([D1, D2] as unknown as ParcelRow[], new Map(), { q })).toEqual([]);
    const root = await delivered({ q });
    expect(textOf(root)).toContain("見つかりません");
    const box = findAll(root, (n) => n.tag === "input" && n.attrs.name === "q")[0];
    expect(box.attrs.value).toBe("ノートX");
  });
});
