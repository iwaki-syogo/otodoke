import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { monthLabel, todayJst } from "@/lib/format";
import { MONTH_MIN, monthHref, monthMax } from "@/lib/month-url";
import { expand, fakeEvent, findHosts, forced, type Host } from "./element-tree";
import { findAll, hasClasses, parseHtml, textOf } from "./html-tree";

/**
 * The month picker on the calendar and the spend page (task 4).
 *
 * src/lib/month-url.ts:
 * - monthHref(basePath, month, keep = {}, today = todayJst()) -> `${basePath}?m=<month>` plus each
 *   non-empty value of keep. The month goes through monthParam / spendMonthParam first (a bad one
 *   becomes this month).
 * - MONTH_MIN = "2020-01"; monthMax(today = todayJst()) -> December of next year.
 *
 * src/app/app/month-picker.tsx ("use client"): MonthPicker({ value, basePath, keep? }).
 * - The first render (the server's too) draws monthLabel(value) with 「▾」 and, over it, an
 *   <input type="month"> with opacity-0, text-base, min / max / value and no pointer-events-none.
 *   (Hiding the input where the browser has no type=month happens after mounting.)
 * - The input's onChange: "" does nothing; otherwise router.push(monthHref(basePath, value, keep))
 *   inside startTransition; a spinner shows while pending.
 * - The input's onClick calls e.currentTarget.showPicker() at once (no await before it), in
 *   try / catch.
 */

const mocks = vi.hoisted(() => ({
  router: { push: (() => {}) as (href: string) => void, refresh: () => {}, replace: () => {}, back: () => {}, prefetch: () => {} },
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { forcedHooks } = await import("./element-tree");
  return forcedHooks(actual);
});
vi.mock("next/navigation", () => ({
  redirect: vi.fn(),
  useRouter: () => mocks.router,
  usePathname: () => "/app/calendar",
  useSearchParams: () => new URLSearchParams(),
}));

beforeEach(() => {
  mocks.router.push = vi.fn();
  forced.pending = false;
});
afterEach(() => {
  forced.pending = false;
});

const parse = (href: string) => {
  const u = new URL(href, "http://localhost");
  return { path: u.pathname, params: Object.fromEntries(u.searchParams) };
};

describe("monthHref", () => {
  it("puts the month in ?m=", () => {
    expect(parse(monthHref("/app/calendar", "2026-05", {}, "2026-11-04"))).toEqual({ path: "/app/calendar", params: { m: "2026-05" } });
  });

  it("keeps the given values and leaves out empty ones", () => {
    expect(parse(monthHref("/app/spend", "2026-05", { c: "none", s: "Amazon" }, "2026-11-04"))).toEqual({ path: "/app/spend", params: { m: "2026-05", c: "none", s: "Amazon" } });
    expect(parse(monthHref("/app/spend", "2026-05", { c: undefined, s: "" }, "2026-11-04"))).toEqual({ path: "/app/spend", params: { m: "2026-05" } });
    expect(parse(monthHref("/app/calendar", "2026-05"))).toEqual({ path: "/app/calendar", params: { m: "2026-05" } });
  });

  it("escapes what it keeps", () => {
    expect(parse(monthHref("/app/spend", "2026-05", { s: "A&B=C 店" }, "2026-11-04")).params.s).toBe("A&B=C 店");
  });

  it("turns a bad month into this month, on the spend page as on the calendar", () => {
    for (const bad of ["2026-13", "2026-00", "all", "2026-1", "x"]) {
      expect(parse(monthHref("/app/spend", bad, { s: "Amazon" }, "2026-11-04")).params, bad).toEqual({ m: "2026-11", s: "Amazon" });
      expect(parse(monthHref("/app/calendar", bad, {}, "2026-11-04")).params.m, bad).toBe("2026-11");
    }
  });
});

describe("MONTH_MIN / monthMax", () => {
  it("starts at 2020-01", () => {
    expect(MONTH_MIN).toBe("2020-01");
  });

  it("ends in December of next year, across a new year", () => {
    expect(monthMax("2026-11-04")).toBe("2027-12");
    expect(monthMax("2026-12-31")).toBe("2027-12");
    expect(monthMax("2027-01-01")).toBe("2028-12");
    expect(monthMax()).toBe(`${Number(todayJst().slice(0, 4)) + 1}-12`);
  });
});

describe("MonthPicker", () => {
  type Props = { value: string; basePath: string; keep?: Record<string, string | undefined> };
  const load = async () => (await import("@/app/app/month-picker")) as unknown as { MonthPicker: (p: Props) => unknown };
  const VALUE = todayJst().slice(0, 7);
  const html = async (props: Props) => parseHtml(renderToStaticMarkup(createElement((await load()).MonthPicker as never, props as never)));
  const input = (nodes: Array<Host | string>) => {
    const i = findHosts(nodes, (h) => h.type === "input" && h.props.type === "month");
    expect(i).toHaveLength(1);
    return i[0];
  };
  const pushed = () => (mocks.router.push as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0] as string);

  it("is a client component using a transition", () => {
    const source = readFileSync(path.resolve(__dirname, "../../app/app/month-picker.tsx"), "utf8");
    expect(source.startsWith('"use client";')).toBe(true);
    expect(source).toContain("useTransition");
    expect(source).not.toMatch(/await[^;\n]*showPicker/);
  });

  it("draws the month name with 「▾」 and a see-through 16px month input over it", async () => {
    const root = await html({ value: VALUE, basePath: "/app/calendar" });
    expect(textOf(root)).toContain(monthLabel(VALUE));
    expect(textOf(root)).toContain("▾");
    const inputs = findAll(root, (n) => n.tag === "input");
    expect(inputs).toHaveLength(1);
    const i = inputs[0];
    expect(i.attrs.type).toBe("month");
    expect(hasClasses(i, "opacity-0", "text-base"), i.attrs.class).toBe(true);
    expect(i.attrs.class ?? "").not.toContain("pointer-events-none");
    expect(i.attrs.min).toBe("2020-01");
    expect(i.attrs.max).toBe(monthMax());
    expect(i.attrs.value).toBe(VALUE);
  });

  it("shows a spinner only while pending", async () => {
    expect(findAll(await html({ value: VALUE, basePath: "/app/calendar" }), (n) => hasClasses(n, "animate-spin"))).toHaveLength(0);
    forced.pending = true;
    expect(findAll(await html({ value: VALUE, basePath: "/app/calendar" }), (n) => hasClasses(n, "animate-spin")).length).toBeGreaterThan(0);
  });

  it("goes to the picked month, keeping the given values", async () => {
    const { MonthPicker } = await load();
    const nodes = expand(createElement(MonthPicker as never, { value: "2026-10", basePath: "/app/spend", keep: { c: "none", s: "Amazon", x: "" } } as never));
    (input(nodes).props.onChange as (e: unknown) => void)(fakeEvent({ value: "2026-05" }));
    expect(pushed().map(parse)).toEqual([{ path: "/app/spend", params: { m: "2026-05", c: "none", s: "Amazon" } }]);
  });

  it("does nothing when the value is cleared", async () => {
    const { MonthPicker } = await load();
    const nodes = expand(createElement(MonthPicker as never, { value: "2026-10", basePath: "/app/calendar" } as never));
    (input(nodes).props.onChange as (e: unknown) => void)(fakeEvent({ value: "" }));
    expect(pushed()).toEqual([]);
  });

  it("opens the picker on a click at once, and survives a browser that refuses", async () => {
    const { MonthPicker } = await load();
    const nodes = expand(createElement(MonthPicker as never, { value: "2026-10", basePath: "/app/calendar" } as never));
    const onClick = input(nodes).props.onClick as (e: unknown) => void;
    expect(typeof onClick).toBe("function");
    const showPicker = vi.fn();
    onClick(fakeEvent({ type: "month", value: "2026-10", showPicker }));
    // Called before onClick returns: nothing awaited in between.
    expect(showPicker).toHaveBeenCalledTimes(1);
    const refuse = vi.fn(() => {
      throw new Error("NotAllowedError");
    });
    expect(() => onClick(fakeEvent({ type: "month", value: "2026-10", showPicker: refuse }))).not.toThrow();
    expect(refuse).toHaveBeenCalledTimes(1);
  });
});
