import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { monthLabel } from "@/lib/format";
import { expand, fakeEvent, findHosts, forced, hostText, type Host } from "./element-tree";

/**
 * Review fixes on the second batch, iteration 4 (orch-20261104-024133-643b):
 * - [NEW-N3] dropping a held month (iOS / iPadOS) also puts the month input's own value back to the
 *   month shown, so the wheels open there again; and a change of the month shown (`value`) drops a
 *   held month, so nothing goes out for it on the next tap.
 *
 * Re-rendering works as in batch2-review-fixes-3.test.ts: with `store.on`, useState / useRef /
 * useEffect / useId keep their values across expand() calls by call order, and effects run after
 * each one (deps compared).
 */

const store = vi.hoisted(() => ({
  on: false,
  i: 0,
  slots: [] as unknown[],
  effects: [] as Array<{ i: number; run: () => unknown; deps?: unknown[] }>,
}));
const mocks = vi.hoisted(() => ({
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
vi.mock("next/navigation", () => ({
  useRouter: () => mocks.router,
  usePathname: () => "/app/calendar",
  useSearchParams: () => new URLSearchParams(),
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
    addEventListener: vi.fn((type: string, fn: Listener) => {
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

const DEVICES = {
  iPhone: { ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1", touch: 5, coarse: true },
  "Android Chrome": { ua: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36", touch: 5, coarse: true },
} as const;
const on = (name: keyof typeof DEVICES) => {
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

type PickerProps = { value: string; basePath: string };
const loadPicker = async () => (await import("@/app/app/month-picker")) as unknown as { MonthPicker: (p: PickerProps) => unknown };
const loadScope = async () => (await import("@/app/app/spend/filter-link")) as unknown as { FilterScope: (p: { children?: unknown }) => unknown };
const monthInput = (nodes: Array<Host | string>) => {
  const i = findHosts(nodes, (h) => h.type === "input" && h.props.type === "month");
  expect(i).toHaveLength(1);
  return i[0];
};
const name = (nodes: Array<Host | string>) => hostText(findHosts(nodes, (h) => h.type === "span")[0]);

/** A stand-in for the month input's DOM node, put behind the picker's ref. */
function domInput(nodes: Array<Host | string>, value: string) {
  const el = { type: "month", value };
  (monthInput(nodes).props.ref as { current: unknown }).current = el;
  return el;
}

/** The wheels turned to `month`: the DOM value moves first, then React's change comes. */
function turn(nodes: Array<Host | string>, el: { value: string }, month: string) {
  el.value = month;
  call(monthInput(nodes), "onChange", fakeEvent(el));
}

/** The picker alone; `render(value)` re-renders it (with a new `value` if given), state kept. */
async function picker(first = "2026-10") {
  store.on = true;
  const { MonthPicker } = await loadPicker();
  let value = first;
  return {
    render: (next?: string) => {
      if (next) value = next;
      return rerender(createElement(MonthPicker as never, { value, basePath: "/app/calendar" } as never));
    },
  };
}

describe("[NEW-N3] another move on the way: the input goes back too", () => {
  it("puts the input's own value back to the month shown, and sends nothing for it", async () => {
    on("iPhone");
    const d = fakeDocument();
    store.on = true;
    const { FilterScope } = await loadScope();
    const { MonthPicker } = await loadPicker();
    const el = createElement(FilterScope as never, null, createElement(MonthPicker as never, { value: "2026-10", basePath: "/app/calendar" } as never));
    let nodes = rerender(el);
    const input = domInput(nodes, "2026-10");
    turn(nodes, input, "2027-03");
    nodes = rerender(el);
    expect(name(nodes)).toContain(monthLabel("2027-03"));
    expect(input.value).toBe("2027-03");

    // A move this picker did not send is on the way: the held month is dropped.
    forced.pending = true;
    nodes = rerender(el);
    nodes = rerender(el);
    expect(name(nodes)).toContain(monthLabel("2026-10"));
    expect(input.value).toBe("2026-10");

    // It ends on the same month (only another parameter changed): the wheels open at the month shown.
    forced.pending = false;
    nodes = rerender(el);
    expect(input.value).toBe("2026-10");
    expect(d.count("pointerdown")).toBe(0);
    call(monthInput(nodes), "onBlur", fakeEvent(input));
    d.dispatch("pointerdown", { target: {} });
    expect(pushed()).toEqual([]);

    // Turned again, it is held and sent once as before.
    turn(nodes, input, "2027-05");
    nodes = rerender(el);
    d.dispatch("pointerdown", { target: {} });
    d.dispatch("pointerdown", { target: {} });
    expect(months()).toEqual(["2027-05"]);
  });
});

describe("[NEW-N3] the month shown changes: a held month is dropped", () => {
  it("shows the new month, puts the input to it, and sends nothing on the next tap", async () => {
    on("iPhone");
    const d = fakeDocument();
    const p = await picker("2026-10");
    let nodes = p.render();
    const input = domInput(nodes, "2026-10");
    turn(nodes, input, "2027-03");
    nodes = p.render();
    expect(name(nodes)).toContain(monthLabel("2027-03"));
    expect(d.count("pointerdown")).toBe(1);

    // Reached another way (say, swiping back): the month shown is now 2026-08, no move pending.
    nodes = p.render("2026-08");
    expect(name(nodes)).toContain(monthLabel("2026-08"));
    expect(name(nodes)).not.toContain(monthLabel("2027-03"));
    expect(input.value).toBe("2026-08");
    nodes = p.render();
    expect(name(nodes)).toContain(monthLabel("2026-08"));
    expect(d.count("pointerdown")).toBe(0);
    expect(d.count("visibilitychange")).toBe(0);

    d.dispatch("pointerdown", { target: {} });
    d.doc.visibilityState = "hidden";
    d.dispatch("visibilitychange");
    call(monthInput(nodes), "onBlur", fakeEvent(input));
    expect(pushed()).toEqual([]);
  });

  it("drops it even when the pointerdown listener is still on from the render before", async () => {
    on("iPhone");
    const d = fakeDocument();
    const p = await picker("2026-10");
    let nodes = p.render();
    const input = domInput(nodes, "2026-10");
    turn(nodes, input, "2027-03");
    p.render();
    // The month shown changes; a tap lands right after that render is committed.
    p.render("2026-08");
    d.dispatch("pointerdown", { target: {} });
    expect(pushed()).toEqual([]);
    nodes = p.render();
    expect(name(nodes)).toContain(monthLabel("2026-08"));
  });

  it("a month turned after the change is held and sent once as before", async () => {
    on("iPhone");
    const d = fakeDocument();
    const p = await picker("2026-10");
    let nodes = p.render();
    const input = domInput(nodes, "2026-10");
    turn(nodes, input, "2027-03");
    p.render();
    nodes = p.render("2026-08");
    nodes = p.render();
    turn(nodes, input, "2026-12");
    nodes = p.render();
    expect(name(nodes)).toContain(monthLabel("2026-12"));
    expect(pushed()).toEqual([]);
    call(monthInput(nodes), "onBlur", fakeEvent(input));
    d.dispatch("pointerdown", { target: {} });
    expect(months()).toEqual(["2026-12"]);
  });
});

describe("[NEW-N3] the wheels reset to empty: the input goes back to the month shown", () => {
  it("drops the held month and puts the input's value back", async () => {
    on("iPhone");
    const d = fakeDocument();
    const p = await picker("2026-10");
    let nodes = p.render();
    const input = domInput(nodes, "2026-10");
    turn(nodes, input, "2027-03");
    nodes = p.render();
    turn(nodes, input, "");
    nodes = p.render();
    expect(name(nodes)).toContain(monthLabel("2026-10"));
    expect(input.value).toBe("2026-10");
    p.render();
    expect(d.count("pointerdown")).toBe(0);
    call(monthInput(nodes), "onBlur", fakeEvent(input));
    expect(pushed()).toEqual([]);
  });
});

describe("[NEW-N3] Android: unchanged, a change moves at once", () => {
  it("sends on the change, and a later change of the month shown sends nothing", async () => {
    on("Android Chrome");
    const d = fakeDocument();
    const p = await picker("2026-10");
    let nodes = p.render();
    const input = domInput(nodes, "2026-10");
    turn(nodes, input, "2027-03");
    expect(months()).toEqual(["2027-03"]);
    nodes = p.render("2027-03");
    expect(name(nodes)).toContain(monthLabel("2027-03"));
    expect(d.count("pointerdown")).toBe(0);
    d.dispatch("pointerdown", { target: {} });
    call(monthInput(nodes), "onBlur", fakeEvent(input));
    expect(months()).toEqual(["2027-03"]);
  });
});
