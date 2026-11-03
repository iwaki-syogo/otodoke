import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deliveredFilterOptions } from "@/lib/delivered";
import { todayJst } from "@/lib/format";
import { expand, fakeEvent, findHosts, forced, hostText, type Host } from "./element-tree";
import { FakeDb } from "./fake-db";
import { ancestorsOf, classesOf, findAll, parseHtml, textOf, type HtmlNode } from "./html-tree";

/**
 * Look fixes found on the phone-width check of batch 2:
 * - the delivered page's three selects no longer share one row at 390px: the shop takes a row of
 *   its own and the category and the month share the next, so 「2026年11月」 and 「家電・ガジェット」
 *   are not cut. The month options still name the year and the month; their values stay YYYY-MM.
 * - the spend page's 前月／翌月 and 月／全期間 show a FilterSpinner on the one pressed only, as the
 *   calendar's ‹ › do; their text stays 「‹ 前月」「翌月 ›」「月」「全期間」 otherwise.
 *
 * Re-rendering as in batch2-review-fixes-3.test.ts: with `store.on`, useState / useRef /
 * useEffect / useId keep their values across expand() calls by call order.
 */

const USER = "00000000-0000-4000-8000-00000000000a";

const store = vi.hoisted(() => ({
  on: false,
  i: 0,
  slots: [] as unknown[],
  effects: [] as Array<{ i: number; run: () => unknown; deps?: unknown[] }>,
}));
const mocks = vi.hoisted(() => ({
  state: { db: null as unknown },
  router: { push: (() => {}) as (href: string) => void, refresh: () => {}, replace: () => {}, back: () => {}, prefetch: () => {} },
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { forcedHooks, forced: f } = await import("./element-tree");
  const hooks = forcedHooks(actual);
  const kept = () => store.on && f.expanding;
  const slot = (make: () => unknown) => {
    const i = store.i++;
    if (!(i in store.slots)) store.slots[i] = make();
    return i;
  };
  return {
    ...hooks,
    useState: (init: unknown) => {
      if (!kept()) return hooks.useState(init);
      const i = slot(() => (typeof init === "function" ? (init as () => unknown)() : init));
      const set = (next: unknown) => {
        store.slots[i] = typeof next === "function" ? (next as (p: unknown) => unknown)(store.slots[i]) : next;
      };
      return [store.slots[i], set];
    },
    useRef: (init: unknown) => (kept() ? store.slots[slot(() => ({ current: init }))] : hooks.useRef(init)),
    // Effects are not run here: the tests below only press links.
    useEffect: (run: () => unknown, deps?: unknown[]) => {
      if (!kept()) return hooks.useEffect(run as never, deps);
      slot(() => null);
    },
    useId: () => (kept() ? `:k${slot(() => null)}:` : hooks.useId()),
  };
});
vi.mock("next/link", async () => {
  const { createElement: h } = await import("react");
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const Link = ({ href, children, prefetch, scroll, replace, ...rest }: Record<string, unknown>) => h("a", { href: String(href), ...rest }, children as never);
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
  createClient: async () => mocks.state.db,
  getUser: async () => ({ id: "00000000-0000-4000-8000-00000000000a" }),
}));

beforeEach(() => {
  mocks.router.push = vi.fn();
  forced.pending = false;
  store.on = false;
  store.i = 0;
  store.slots = [];
  store.effects = [];
});
afterEach(() => {
  store.on = false;
  forced.pending = false;
});

describe("delivered: the selects are not cut at phone width", () => {
  type Props = { q: string; s: string; c: string; m: string; options: ReturnType<typeof deliveredFilterOptions>; children?: unknown };
  const MONTHS = ["2026-11", "2026-10", "2026-01", "2025-12"];
  const render = async (over: Partial<Props> = {}) => {
    const { DeliveredFilter } = (await import("@/app/app/delivered/filter-form")) as unknown as { DeliveredFilter: (p: Props) => unknown };
    const options = { ...deliveredFilterOptions([]), shops: ["Amazon", "架空PCショップ"], months: MONTHS };
    const props: Props = { q: "", s: "", c: "", m: "", options, children: null, ...over };
    return parseHtml(renderToStaticMarkup(createElement(DeliveredFilter as never, props as never)));
  };
  const select = (root: HtmlNode, name: string) => {
    const s = findAll(root, (n) => n.tag === "select" && n.attrs.name === name);
    expect(s, name).toHaveLength(1);
    return s[0];
  };
  const options = (sel: HtmlNode) => findAll(sel, (n) => n.tag === "option");
  /** The nearest ancestor laid out as a grid. */
  const grid = (n: HtmlNode) => ancestorsOf(n).find((a) => classesOf(a).includes("grid"));

  it("names the year and the month in each month option, the values staying YYYY-MM", async () => {
    const root = await render({ m: "2026-01" });
    const opts = options(select(root, "m")).filter((o) => o.attrs.value);
    expect(opts.map((o) => o.attrs.value)).toEqual(MONTHS);
    for (const o of opts) {
      const [y, m] = (o.attrs.value ?? "").split("-").map(Number);
      const text = textOf(o).trim();
      expect(text, o.attrs.value).toContain(String(y));
      // The month number, not part of a longer number (11 is not 1).
      expect(text, o.attrs.value).toMatch(new RegExp(`(^|\\D)${m}(\\D|$)`));
      expect(text.replace(String(y), ""), o.attrs.value).toMatch(new RegExp(`(^|\\D)0?${m}(\\D|$)`));
    }
    const texts = opts.map((o) => textOf(o).trim());
    expect(new Set(texts).size).toBe(texts.length);
    expect(options(select(root, "m")).filter((o) => "selected" in o.attrs).map((o) => o.attrs.value)).toEqual(["2026-01"]);
  });

  it("puts no more than two selects in a row: the shop alone, then the category and the month", async () => {
    const root = await render();
    const [shop, category, month] = ["s", "c", "m"].map((name) => select(root, name));
    const g = grid(month);
    expect(g).toBeDefined();
    expect(grid(shop)).toBe(g);
    expect(grid(category)).toBe(g);
    const cols = classesOf(g as HtmlNode).filter((c) => /^grid-cols-\d+$/.test(c));
    expect(cols).toEqual(["grid-cols-2"]);
    // The shop spans the whole row; the category and the month take one column each.
    const span = (n: HtmlNode) => [n, ...ancestorsOf(n).slice(0, ancestorsOf(n).indexOf(g as HtmlNode))].flatMap(classesOf).filter((c) => /^col-span-/.test(c));
    expect(span(shop)).toEqual(["col-span-2"]);
    expect(span(category)).toEqual([]);
    expect(span(month)).toEqual([]);
  });

  it("keeps the text at 16px (text-base) on every select, so iOS does not zoom in", async () => {
    const root = await render();
    for (const name of ["s", "c", "m"]) expect(classesOf(select(root, name)), name).toContain("text-base");
  });
});

describe("spend: 前月／翌月 and 月／全期間 spin on the one pressed only", () => {
  const ym = todayJst().slice(0, 7);
  const spins = (nodes: Array<Host | string>) => findHosts(nodes, (h) => typeof h.props.className === "string" && h.props.className.includes("animate-spin"));
  const LABELS = ["‹ 前月", "翌月 ›", "月", "全期間"];

  /** The spend page expanded to host elements, re-rendered with its state kept. */
  async function page(params: Record<string, string>) {
    mocks.state.db = new FakeDb({ parcels: [{ id: "00000000-0000-4000-8000-000000000001", user_id: USER, shop: "テスト店", title: "品名", status: "delivered", ordered_at: `${ym}-01`, total_amount: 1000, category: "food", updated_at: "2026-11-01T00:00:00Z" }] });
    const Page = (await import("@/app/app/spend/page")).default;
    const el = await Page({ searchParams: Promise.resolve(params) } as never);
    store.on = true;
    const render = () => {
      store.i = 0;
      return expand(el);
    };
    const links = (nodes: Array<Host | string>) => findHosts(nodes, (h) => h.type === "a" && String(h.props.href).startsWith("/app/spend") && LABELS.includes(hostText(h).trim()));
    const link = (nodes: Array<Host | string>, label: string) => {
      const found = links(nodes).filter((h) => hostText(h).trim() === label);
      expect(found, label).toHaveLength(1);
      return found[0];
    };
    return { render, links, link };
  }

  const cases: Array<[string, Record<string, string>, string]> = [
    ["‹ 前月", { m: ym }, "a month"],
    ["翌月 ›", { m: ym }, "a month"],
    ["全期間", { m: ym }, "a month"],
    ["月", { m: "all" }, "the whole period"],
  ];

  for (const [label, params, where] of cases) {
    it(`shows a spinner in 「${label}」 only, pressed on ${where}`, async () => {
      const { render, links, link } = await page(params);
      let nodes = render();
      expect(spins(nodes)).toHaveLength(0);
      const pressed = link(nodes, label);
      const href = String(pressed.props.href);
      (pressed.props.onClick as (e: unknown) => void)(fakeEvent({ href }));
      expect((mocks.router.push as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])).toEqual([href]);

      // forced.pending answers every useTransition, so a control with a transition of its own
      // (an order's category button) spins too: count in the period switch and the month header.
      forced.pending = true;
      nodes = render();
      const bars = findHosts(nodes, (h) => h.type === "nav" || h.type === "header");
      const now = findHosts(bars, (h) => h.type === "a" && h.props.href === href);
      expect(now).toHaveLength(1);
      expect(spins(now)).toHaveLength(1);
      expect(spins(bars)).toHaveLength(1);
      for (const other of links(nodes).filter((h) => h.props.href !== href)) expect(spins([other]), hostText(other)).toHaveLength(0);
      // The word stays beside the spinner (only ‹ › give way to it).
      expect(hostText(now[0]).trim()).toBe(label.replace(/[‹›]/g, "").trim());
    });
  }

  it("keeps the text of each when nothing is on the way", async () => {
    const month = await page({ m: ym });
    const texts = month.links(month.render()).map((h) => hostText(h).trim());
    expect(texts).toEqual(expect.arrayContaining(["‹ 前月", "翌月 ›", "月", "全期間"]));
    const all = await page({ m: "all" });
    expect(all.links(all.render()).map((h) => hostText(h).trim())).toEqual(expect.arrayContaining(["月", "全期間"]));
  });
});
