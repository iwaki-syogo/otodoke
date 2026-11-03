import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deliveredFilterOptions } from "@/lib/delivered";
import { monthLabel } from "@/lib/format";
import { expand, fakeEvent, findHosts, forced, hostText, type Host } from "./element-tree";
import { FakeDb } from "./fake-db";
import { ancestorsOf, findAll, hasClasses, parseHtml, textOf, type HtmlNode } from "./html-tree";

/**
 * Review fixes on the second batch, iteration 3 (orch-20261104-024133-643b):
 * - [NEW-S1] the month picker holds a turned month until the picker closes on iOS / iPadOS WebKit
 *   only (by user agent); Android and desktops move at once on a change. While held, the name shows
 *   the held month, and besides blur a tap elsewhere (pointerdown) or the page going hidden sends
 *   it, once. Another move on the way drops the held month: the name goes back, nothing is sent.
 * - [N2b] the delivered count is drawn by DeliveredFilter, faint with the results while pending.
 * - [NEW-N2] the calendar's ‹ › carry a FilterSpinner: only the pressed one spins.
 *
 * Re-rendering: with `kept.on`, useState / useRef / useEffect / useId below keep their values
 * across expand() calls by call order and effects run after each one (deps compared), so a test
 * can render, act, and render again as React would.
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
    useEffect: (run: () => unknown, deps?: unknown[]) => {
      if (!kept()) return hooks.useEffect(run as never, deps);
      store.effects.push({ i: slot(() => ({ ran: false, deps: undefined, cleanup: undefined })), run, deps });
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
  usePathname: () => "/app/calendar",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => mocks.state.db,
  getUser: async () => ({ id: "00000000-0000-4000-8000-00000000000a" }),
}));

type EffectSlot = { ran: boolean; deps?: unknown[]; cleanup?: unknown };

/** Runs the effects of the last render whose deps changed, cleaning up their previous run first. */
function commit() {
  for (const e of store.effects) {
    const s = store.slots[e.i] as EffectSlot;
    const same = s.ran && e.deps !== undefined && s.deps !== undefined && e.deps.length === s.deps.length && e.deps.every((d, k) => Object.is(d, s.deps?.[k]));
    if (same) continue;
    if (typeof s.cleanup === "function") s.cleanup();
    s.cleanup = e.run();
    s.deps = e.deps;
    s.ran = true;
  }
  store.effects = [];
}

/** Renders `el` again, keeping the state of the previous render. */
function rerender(el: unknown) {
  store.i = 0;
  store.effects = [];
  const nodes = expand(el);
  commit();
  return nodes;
}

function unmount() {
  for (const s of store.slots) {
    const e = s as EffectSlot | null;
    if (e && typeof e === "object" && "ran" in e && typeof e.cleanup === "function") e.cleanup();
  }
  store.slots = [];
}

type Listener = (e: unknown) => void;
function fakeDocument() {
  const listeners = new Map<string, Set<Listener>>();
  const doc = {
    visibilityState: "visible",
    addEventListener: vi.fn((type: string, fn: Listener, capture?: boolean) => {
      void capture;
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)?.add(fn);
    }),
    removeEventListener: vi.fn((type: string, fn: Listener) => {
      listeners.get(type)?.delete(fn);
    }),
  };
  vi.stubGlobal("document", doc);
  return {
    doc,
    dispatch: (type: string, ev: Record<string, unknown> = {}) => [...(listeners.get(type) ?? [])].forEach((fn) => fn(ev)),
    count: (type: string) => listeners.get(type)?.size ?? 0,
  };
}

const SAFARI_MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";
const DEVICES = {
  iPhone: { ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1", touch: 5, coarse: true },
  "iPhone Chrome": { ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0.0.0 Mobile/15E148 Safari/604.1", touch: 5, coarse: true },
  "iPadOS (asks as a Mac)": { ua: SAFARI_MAC, touch: 5, coarse: true },
  "Android Chrome": { ua: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36", touch: 5, coarse: true },
  "Mac Safari": { ua: SAFARI_MAC, touch: 0, coarse: false },
  "Windows Chrome": { ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36", touch: 0, coarse: false },
} as const;
type Device = keyof typeof DEVICES;
const on = (name: Device) => {
  const d = DEVICES[name];
  vi.stubGlobal("window", { navigator: { userAgent: d.ua, maxTouchPoints: d.touch }, matchMedia: (q: string) => ({ matches: d.coarse && q === "(pointer: coarse)" }) });
};

beforeEach(() => {
  mocks.router.push = vi.fn();
  forced.pending = false;
  store.on = false;
  store.slots = [];
  store.effects = [];
});
afterEach(() => {
  unmount();
  store.on = false;
  forced.pending = false;
  vi.unstubAllGlobals();
});

const pushed = () => (mocks.router.push as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0] as string);
const months = () => pushed().map((h) => new URL(h, "http://localhost").searchParams.get("m"));
const call = (h: Host, handler: string, ev: unknown) => (h.props[handler] as (e: unknown) => void)(ev);

type PickerProps = { value: string; basePath: string; keep?: Record<string, string | undefined> };
const loadPicker = async () => (await import("@/app/app/month-picker")) as unknown as { MonthPicker: (p: PickerProps) => unknown };
const loadFilter = async () =>
  (await import("@/app/app/spend/filter-link")) as unknown as {
    FilterScope: (p: { children?: unknown }) => unknown;
    FilterLink: (p: { href: string; children?: unknown }) => unknown;
    FilterSpinner: (p: { children?: unknown }) => unknown;
  };
const monthInput = (nodes: Array<Host | string>) => {
  const i = findHosts(nodes, (h) => h.type === "input" && h.props.type === "month");
  expect(i).toHaveLength(1);
  return i[0];
};
const spins = (nodes: Array<Host | string>) => findHosts(nodes, (h) => typeof h.props.className === "string" && h.props.className.includes("animate-spin"));

/** The picker alone, re-rendered with its state kept. */
async function picker() {
  store.on = true;
  const { MonthPicker } = await loadPicker();
  const el = createElement(MonthPicker as never, { value: "2026-10", basePath: "/app/calendar" } as never);
  return { render: () => rerender(el) };
}

describe("[NEW-S1] iOS / iPadOS WebKit: held until the picker closes", () => {
  for (const name of ["iPhone", "iPhone Chrome", "iPadOS (asks as a Mac)"] as const) {
    it(`${name}: sends nothing on a change, then the last month once on blur`, async () => {
      on(name);
      fakeDocument();
      const p = await picker();
      let input = monthInput(p.render());
      call(input, "onChange", fakeEvent({ value: "2027-10" }));
      input = monthInput(p.render());
      call(input, "onChange", fakeEvent({ value: "2027-03" }));
      expect(pushed()).toEqual([]);
      input = monthInput(p.render());
      call(input, "onBlur", fakeEvent({ value: "2027-03" }));
      call(input, "onBlur", fakeEvent({ value: "2027-03" }));
      expect(months()).toEqual(["2027-03"]);
    });
  }

  it("shows the held month in the name, and the month shown before nothing is turned", async () => {
    on("iPhone");
    fakeDocument();
    const p = await picker();
    const before = p.render();
    expect(hostText(before[0])).toContain(monthLabel("2026-10"));
    call(monthInput(before), "onChange", fakeEvent({ value: "2027-03" }));
    const held = p.render();
    expect(hostText(held[0])).toContain(monthLabel("2027-03"));
    expect(hostText(held[0])).not.toContain(monthLabel("2026-10"));
  });

  it("sends once on a tap elsewhere (pointerdown) and then stops listening", async () => {
    on("iPhone");
    const d = fakeDocument();
    const p = await picker();
    call(monthInput(p.render()), "onChange", fakeEvent({ value: "2027-03" }));
    expect(d.count("pointerdown")).toBe(0);
    p.render();
    expect(d.count("pointerdown")).toBe(1);
    expect(d.count("visibilitychange")).toBe(1);
    // Listened for in the capture phase, so it runs before the tapped control's own handler.
    expect(d.doc.addEventListener.mock.calls.find((c) => c[0] === "pointerdown")?.[2]).toBe(true);
    d.dispatch("pointerdown", { target: {} });
    d.dispatch("pointerdown", { target: {} });
    expect(months()).toEqual(["2027-03"]);
    p.render();
    expect(d.count("pointerdown")).toBe(0);
    expect(d.count("visibilitychange")).toBe(0);
    d.dispatch("pointerdown", { target: {} });
    expect(months()).toEqual(["2027-03"]);
  });

  it("sends once when the page is hidden, not when it shows", async () => {
    on("iPhone");
    const d = fakeDocument();
    const p = await picker();
    call(monthInput(p.render()), "onChange", fakeEvent({ value: "2027-03" }));
    p.render();
    d.dispatch("visibilitychange");
    expect(pushed()).toEqual([]);
    d.doc.visibilityState = "hidden";
    d.dispatch("visibilitychange");
    d.dispatch("visibilitychange");
    expect(months()).toEqual(["2027-03"]);
    p.render();
    expect(d.count("visibilitychange")).toBe(0);
  });

  it("does not send on a tap on the picker itself (opening the wheels again)", async () => {
    on("iPhone");
    const d = fakeDocument();
    const p = await picker();
    const first = monthInput(p.render());
    call(first, "onChange", fakeEvent({ value: "2027-03" }));
    const input = monthInput(p.render());
    const el = {};
    (input.props.ref as { current: unknown }).current = el;
    d.dispatch("pointerdown", { target: el });
    expect(pushed()).toEqual([]);
    call(input, "onBlur", fakeEvent({ value: "2027-03" }));
    expect(months()).toEqual(["2027-03"]);
  });

  it("listens to nothing with nothing held, and stops listening when unmounted", async () => {
    on("iPhone");
    const d = fakeDocument();
    const p = await picker();
    p.render();
    expect(d.count("pointerdown")).toBe(0);
    call(monthInput(p.render()), "onChange", fakeEvent({ value: "2027-03" }));
    p.render();
    expect(d.count("pointerdown")).toBe(1);
    unmount();
    expect(d.count("pointerdown")).toBe(0);
    expect(d.count("visibilitychange")).toBe(0);
    expect(pushed()).toEqual([]);
  });
});

describe("[NEW-S1] Android and desktops: a change moves at once", () => {
  for (const name of ["Android Chrome", "Mac Safari", "Windows Chrome"] as const) {
    it(`${name}: sends on the change, holds nothing, listens to nothing`, async () => {
      on(name);
      const d = fakeDocument();
      const p = await picker();
      call(monthInput(p.render()), "onChange", fakeEvent({ value: "2027-03" }));
      expect(months()).toEqual(["2027-03"]);
      const after = p.render();
      expect(d.count("pointerdown")).toBe(0);
      call(monthInput(after), "onBlur", fakeEvent({ value: "2027-03" }));
      expect(months()).toEqual(["2027-03"]);
    });
  }
});

describe("[NEW-S1] another move on the way drops the held month", () => {
  async function scoped() {
    store.on = true;
    const { FilterScope } = await loadFilter();
    const { MonthPicker } = await loadPicker();
    const el = createElement(FilterScope as never, null, createElement(MonthPicker as never, { value: "2026-10", basePath: "/app/calendar" } as never));
    return { render: () => rerender(el) };
  }
  const name = (nodes: Array<Host | string>) => hostText(findHosts(nodes, (h) => h.type === "span")[0]);

  it("puts the name back, stops listening, and sends nothing then or after", async () => {
    on("iPhone");
    const d = fakeDocument();
    const p = await scoped();
    call(monthInput(p.render()), "onChange", fakeEvent({ value: "2027-03" }));
    expect(name(p.render())).toContain(monthLabel("2027-03"));
    expect(d.count("pointerdown")).toBe(1);

    // A move this picker did not send (say, from another control) is on the way.
    forced.pending = true;
    let nodes = p.render();
    expect(name(nodes)).toContain(monthLabel("2026-10"));
    nodes = p.render();
    expect(d.count("pointerdown")).toBe(0);
    call(monthInput(nodes), "onBlur", fakeEvent({ value: "2027-03" }));
    expect(pushed()).toEqual([]);

    // It arrives: the held month does not come back, and nothing goes out for it.
    forced.pending = false;
    nodes = p.render();
    expect(name(nodes)).toContain(monthLabel("2026-10"));
    expect(name(nodes)).not.toContain(monthLabel("2027-03"));
    expect(d.count("pointerdown")).toBe(0);
    call(monthInput(nodes), "onBlur", fakeEvent({ value: "2027-03" }));
    d.dispatch("pointerdown", { target: {} });
    expect(pushed()).toEqual([]);
  });

  it("a tap elsewhere sends the held month before the tapped link, which then waits", async () => {
    on("iPhone");
    const d = fakeDocument();
    store.on = true;
    const { FilterScope, FilterLink } = await loadFilter();
    const { MonthPicker } = await loadPicker();
    const PREV = "/app/calendar?m=2026-09";
    const el = createElement(
      FilterScope as never,
      null,
      createElement(MonthPicker as never, { value: "2026-10", basePath: "/app/calendar" } as never),
      createElement(FilterLink as never, { href: PREV } as never, "‹ 前月"),
    );
    call(monthInput(rerender(el)), "onChange", fakeEvent({ value: "2027-03" }));
    rerender(el);
    // pointerdown (capture) comes first, then the click on the link after the re-render.
    d.dispatch("pointerdown", { target: {} });
    expect(months()).toEqual(["2027-03"]);
    forced.pending = true;
    const nodes = rerender(el);
    const click = fakeEvent({ href: PREV });
    call(findHosts(nodes, (h) => h.type === "a")[0], "onClick", click);
    expect(click.defaultPrevented).toBe(true);
    expect(months()).toEqual(["2027-03"]);
    // The move on the way is the picker's: its name shows the month sent.
    expect(hostText(findHosts(nodes, (h) => h.type === "span")[0])).toContain(monthLabel("2027-03"));
  });
});

describe("[N2b] the delivered count fades with the results", () => {
  type Props = { q: string; s: string; c: string; m: string; options: ReturnType<typeof deliveredFilterOptions>; count?: number; children?: unknown };
  const html = async (over: Partial<Props>) => {
    const { DeliveredFilter } = (await import("@/app/app/delivered/filter-form")) as unknown as { DeliveredFilter: (p: Props) => unknown };
    const props: Props = { q: "", s: "", c: "", m: "", options: deliveredFilterOptions([]), children: createElement("div", { id: "results" }, "結果"), ...over };
    return parseHtml(renderToStaticMarkup(createElement(DeliveredFilter as never, props as never)));
  };
  const headings = (root: HtmlNode) => findAll(root, (n) => n.tag === "h1");
  const faint = (n: HtmlNode) => hasClasses(n, "opacity-50");
  const countNode = (h: HtmlNode) => findAll(h, (n) => n.tag === "span" && /^\s*[\d,]+\s*$/.test(textOf(n)))[0];

  it("draws 「届いた荷物」 with the count it is given, faint while pending", async () => {
    forced.pending = true;
    const busy = headings(await html({ count: 1234 }));
    expect(busy).toHaveLength(1);
    expect(textOf(busy[0])).toContain("届いた荷物");
    expect(textOf(countNode(busy[0]))).toBe((1234).toLocaleString("ja-JP"));
    expect([countNode(busy[0]), ...ancestorsOf(countNode(busy[0]))].some(faint)).toBe(true);

    forced.pending = false;
    const idle = headings(await html({ count: 1234 }));
    expect([countNode(idle[0]), ...ancestorsOf(countNode(idle[0]))].some(faint)).toBe(false);
  });

  it("draws no heading without a count", async () => {
    expect(headings(await html({}))).toHaveLength(0);
  });

  describe("the page", () => {
    let seq = 0;
    const parcel = (over: Record<string, unknown>) => ({
      id: `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`,
      user_id: USER,
      shop: "テスト店",
      shop_key: "other",
      title: `品名${seq}`,
      status: "delivered",
      category: null,
      updated_at: "2026-11-01T00:00:00Z",
      ...over,
    });
    const render = async (parcels: Array<Record<string, unknown>>, params: Record<string, string> = {}, fail = false) => {
      const db = new FakeDb({ parcels, parcel_items: [] });
      if (fail) db.hooks.push((q) => (q.table === "parcels" ? { data: null, error: { message: "boom" }, count: null } : undefined));
      mocks.state.db = db;
      const Page = (await import("@/app/app/delivered/page")).default as unknown as (p: { searchParams: Promise<Record<string, string>> }) => Promise<Parameters<typeof renderToStaticMarkup>[0]>;
      return parseHtml(renderToStaticMarkup(await Page({ searchParams: Promise.resolve(params) })));
    };

    it("has one heading with the count found, inside the filter's transition", async () => {
      const two = [parcel({ title: "ノート", ordered_at: "2026-10-30" }), parcel({ title: "ペン", ordered_at: "2026-09-02" })];
      const all = headings(await render(two));
      expect(all).toHaveLength(1);
      expect(textOf(countNode(all[0]))).toBe("2");
      expect(textOf(countNode(headings(await render(two, { q: "ノート" }))[0]))).toBe("1");

      forced.pending = true;
      const busy = headings(await render(two));
      expect(busy).toHaveLength(1);
      expect([countNode(busy[0]), ...ancestorsOf(countNode(busy[0]))].some(faint)).toBe(true);
    });

    it("keeps one heading when there are none (0) and when the read fails (no count)", async () => {
      const none = headings(await render([]));
      expect(none).toHaveLength(1);
      expect(textOf(countNode(none[0]))).toBe("0");
      const failed = await render([parcel({})], {}, true);
      expect(headings(failed)).toHaveLength(1);
      expect(textOf(headings(failed)[0]).trim()).toBe("届いた荷物");
      expect(textOf(failed)).toContain("読み込めませんでした");
    });
  });
});

describe("[NEW-N2] the calendar's ‹ › show a spinner on the one pressed", () => {
  it("puts a FilterSpinner in each, keeping 「‹ 前月」「翌月 ›」", () => {
    const source = readFileSync(path.resolve(__dirname, "../../app/app/calendar/page.tsx"), "utf8");
    expect(source).toMatch(/<FilterSpinner>‹<\/FilterSpinner> 前月/);
    expect(source).toMatch(/翌月 <FilterSpinner>›<\/FilterSpinner>/);
    expect(source).toMatch(/import\s*\{[^}]*\bFilterSpinner\b[^}]*\}\s*from/);
  });

  it("spins only the pressed one while its page is on the way", async () => {
    store.on = true;
    const { FilterScope, FilterLink, FilterSpinner } = await loadFilter();
    const PREV = "/app/calendar?m=2026-09";
    const NEXT = "/app/calendar?m=2026-11";
    const el = createElement(
      FilterScope as never,
      null,
      createElement(FilterLink as never, { href: PREV } as never, createElement(FilterSpinner as never, null, "‹"), " 前月"),
      createElement(FilterLink as never, { href: NEXT } as never, "翌月 ", createElement(FilterSpinner as never, null, "›")),
    );
    const link = (nodes: Array<Host | string>, href: string) => findHosts(nodes, (h) => h.type === "a" && h.props.href === href)[0];

    let nodes = rerender(el);
    expect(spins(nodes)).toHaveLength(0);
    expect(hostText(link(nodes, PREV))).toBe("‹ 前月");
    call(link(nodes, PREV), "onClick", fakeEvent({ href: PREV }));
    expect(pushed()).toEqual([PREV]);

    forced.pending = true;
    nodes = rerender(el);
    expect(spins([link(nodes, PREV)])).toHaveLength(1);
    expect(spins([link(nodes, NEXT)])).toHaveLength(0);
    expect(hostText(link(nodes, NEXT))).toBe("翌月 ›");
  });
});
