import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { shiftMonth, todayJst } from "@/lib/format";
import { FakeDb, type Row } from "./fake-db";
import { findAll, hasClasses, linksTo, parseHtml, textOf, type HtmlNode } from "./html-tree";

/**
 * [Review 2026-11-06] On the calendar, a red cell counts the day's
 * face-to-face parcels only: a day with one parcel to be home for and one left at the door reads
 * 「🤝1件」, never 「🤝2件」 (read as two to be home for). 念のため対面 is face-to-face here, as it
 * turns the cell red. A blue cell (no face-to-face parcel) counts them all, as before.
 * The cell's name for screen readers gives both numbers (「11月6日、対面 1 件、ほか 1 件」), with
 * no text added on screen. The day's heading, its list and the badges stay as they were.
 *
 * [Review R3-19] The name words the face-to-face parcels as the day's heading does, by the same
 * decision: 「念のため対面 N 件」 when every one of them is so only by the default (the heading reads
 * 念のため対面), 「対面 N 件」 once one was said to be (the heading reads 対面受け取り).
 */

const USER = "00000000-0000-4000-8000-00000000000a";
const mocks = vi.hoisted(() => ({ state: { db: null as unknown } }));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: vi.fn(),
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/app/calendar",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => Object.assign(mocks.state.db as FakeDb, { auth: { getUser: async () => ({ data: { user: { id: USER } }, error: null }) } }),
  getUser: async () => ({ id: USER }),
}));

// Next month, so every day of it is still ahead whatever today is.
const next = shiftMonth(todayJst().slice(0, 7), 1);
const month = Number(next.slice(5));
const on = (d: number) => `${next}-${String(d).padStart(2, "0")}`;

// How a parcel is received, as stored.
const STATED = { requires_presence: true, presence_evidence: "対面での配達を希望" };
const AT_DOOR = { requires_presence: false, presence_evidence: "置き配" };
/** Nothing said, not Amazon: 念のため対面. */
const UNSAID = { requires_presence: null };
/** Nothing said, Amazon: unknown, not face-to-face. */
const AMAZON = { requires_presence: null, shop_key: "amazon" };

let seq = 0;
const parcel = (d: number, title: string, how: Row): Row => ({
  id: `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`,
  user_id: USER,
  shop: "テスト店",
  shop_key: "other",
  title,
  status: "shipped",
  expected_date: on(d),
  created_at: "2026-11-01T00:00:00Z",
  updated_at: "2026-11-01T00:00:00Z",
  ...how,
});

beforeEach(() => {
  mocks.state.db = new FakeDb({
    parcels: [
      parcel(6, "6日 対面", STATED),
      parcel(6, "6日 置き配", AT_DOOR),
      parcel(8, "8日 対面", STATED),
      parcel(8, "8日 念のため", UNSAID),
      parcel(10, "10日 置き配", AT_DOOR),
      parcel(10, "10日 Amazon", AMAZON),
      parcel(10, "10日 置き配 その2", AT_DOOR),
      parcel(12, "12日 念のため", UNSAID),
      parcel(14, "14日 念のため", UNSAID),
      parcel(14, "14日 Amazon", AMAZON),
    ],
    emails: [],
    parcel_items: [],
    extractions: [],
  });
});

async function render() {
  const Page = (await import("@/app/app/calendar/page")).default;
  return parseHtml(renderToStaticMarkup(await Page({ searchParams: Promise.resolve({ m: next }) })));
}

const grid = (root: HtmlNode) => {
  const found = findAll(root, (n) => hasClasses(n, "grid", "grid-cols-7", "gap-y-1"));
  expect(found).toHaveLength(1);
  return found[0];
};
/** The day's cell: a link to the day's list under the grid. */
const cell = (root: HtmlNode, d: number) => {
  const found = linksTo(grid(root), `#d-${on(d)}`);
  expect(found, on(d)).toHaveLength(1);
  return found[0];
};
/** The count chip in the cell (its second span, after the date). */
const chip = (root: HtmlNode, d: number) => findAll(cell(root, d), (n) => n.tag === "span")[1];
/** The day's entry in the list under the grid. */
const day = (root: HtmlNode, d: number) => {
  const found = findAll(root, (n) => n.tag === "li" && n.attrs.id === `d-${on(d)}`);
  expect(found, on(d)).toHaveLength(1);
  return found[0];
};
const SEEDED = [6, 8, 10, 12, 14];

describe("the calendar's day cells", () => {
  it.each([
    [6, "🤝1件", "one to be home for, one left at the door"],
    [8, "🤝2件", "two to be home for, one of them 念のため対面"],
    [12, "🤝1件", "念のため対面 only"],
    [14, "🤝1件", "念のため対面, and an Amazon parcel that said nothing"],
  ])("a red cell counts its face-to-face parcels only: the %ith reads %s (%s)", async (d, text) => {
    const c = chip(await render(), d);
    expect(hasClasses(c, "bg-red-600", "text-white")).toBe(true);
    expect(textOf(c)).toBe(text);
  });

  it("a blue cell, with no face-to-face parcel, counts them all", async () => {
    const c = chip(await render(), 10);
    expect(hasClasses(c, "bg-sky-100")).toBe(true);
    expect(hasClasses(c, "bg-red-600")).toBe(false);
    expect(textOf(c)).toBe("3件");
  });

  it.each([
    [6, "対面 1 件、ほか 1 件"],
    // One said to be face-to-face, one by the default: 対面, as the heading's 対面受け取り.
    [8, "対面 2 件"],
    [10, "3 件"],
    // Only by the default: 念のため対面, as the heading.
    [12, "念のため対面 1 件"],
    [14, "念のため対面 1 件、ほか 1 件"],
  ])("names the %ith for screen readers with both numbers: 「M月D日、%s」", async (d, rest) => {
    expect(cell(await render(), d).attrs["aria-label"]).toBe(`${month}月${d}日、${rest}`);
  });

  it("words a cell's face-to-face parcels as the day's heading does", async () => {
    const root = await render();
    for (const d of SEEDED) {
      const name = cell(root, d).attrs["aria-label"];
      const red = findAll(findAll(day(root, d), (n) => n.tag === "h2")[0], (n) => hasClasses(n, "text-red-700"));
      const heading = red.length ? textOf(red[0]) : null;
      const said = name.includes("、念のため対面 ") ? "念のため対面" : name.includes("、対面 ") ? "対面受け取り" : null;
      expect(said, on(d)).toBe(heading);
    }
  });

  it("the numbers in a cell's name add up to the parcels listed for the day", async () => {
    const root = await render();
    for (const d of SEEDED) {
      const said = [...cell(root, d).attrs["aria-label"].matchAll(/(\d+) 件/g)].reduce((sum, m) => sum + Number(m[1]), 0);
      expect(said, on(d)).toBe(findAll(day(root, d), (n) => n.tag === "a").length);
    }
  });

  it("adds no text on screen: a cell shows its date and the chip, nothing else", async () => {
    const root = await render();
    expect(textOf(cell(root, 6))).toBe("6🤝1件");
    expect(textOf(cell(root, 10))).toBe("103件");
    for (const d of SEEDED) expect(findAll(cell(root, d), (n) => n.tag === "span"), on(d)).toHaveLength(2);
    expect(findAll(grid(root), (n) => hasClasses(n, "sr-only"))).toHaveLength(0);
  });

  it("a day with nothing is no link and has no name", async () => {
    const root = await render();
    const seventh = grid(root).children.filter((c): c is HtmlNode => typeof c !== "string" && textOf(c) === "7");
    expect(seventh).toHaveLength(1);
    expect(seventh[0].tag).toBe("div");
    expect(seventh[0].attrs["aria-label"]).toBeUndefined();
  });

  it("keeps the day's heading, its whole list and the badges as they were", async () => {
    const root = await render();
    const headingLabel = (d: number) => {
      const red = findAll(findAll(day(root, d), (n) => n.tag === "h2")[0], (n) => hasClasses(n, "text-red-700"));
      return red.length ? textOf(red[0]) : null;
    };
    expect(headingLabel(6)).toBe("対面受け取り");
    expect(headingLabel(8)).toBe("対面受け取り");
    expect(headingLabel(10)).toBeNull();
    expect(headingLabel(12)).toBe("念のため対面");
    expect(headingLabel(14)).toBe("念のため対面");

    // Every parcel of the day is listed, the ones to be home for and the rest.
    const titles = (d: number) => findAll(day(root, d), (n) => n.tag === "p" && hasClasses(n, "line-clamp-2")).map((p) => textOf(p)).sort();
    expect(titles(6)).toEqual(["6日 対面", "6日 置き配"].sort());
    expect(titles(10)).toEqual(["10日 置き配", "10日 Amazon", "10日 置き配 その2"].sort());
    expect(titles(14)).toEqual(["14日 念のため", "14日 Amazon"].sort());

    const card = (title: string) => {
      const found = findAll(root, (n) => n.tag === "a" && textOf(n).includes(title));
      expect(found, title).toHaveLength(1);
      return textOf(found[0]);
    };
    expect(card("6日 対面")).toContain("🤝 対面受け取り");
    expect(card("6日 置き配")).toContain("置き配・投函OK");
    expect(card("6日 置き配")).not.toContain("🤝");
    expect(card("8日 念のため")).toContain("🤝 念のため対面");
    expect(card("14日 Amazon")).not.toContain("🤝");
    expect(card("14日 Amazon")).not.toContain("置き配");
  });
});
