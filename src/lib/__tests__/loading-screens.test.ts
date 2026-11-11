import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { todayJst } from "@/lib/format";
import { forced } from "./element-tree";
import { FakeDb } from "./fake-db";
import { findAll, hasClasses, linksTo, parseHtml, textOf, type HtmlNode } from "./html-tree";

/**
 * [Review 2026-11-06 F-2] Every screen under /app has a loading.tsx: the screen's frame in grey
 * blocks (headings, cards, the calendar's grid) from the tap until the page arrives. It says
 * 「読み込み中」 to screen readers and never what a list holds (no 「〜はありません」, no counts).
 *
 * A move that changes only the query (?m= on the calendar and the spend screen, ?q= on 受け取り済み)
 * shows no loading.tsx (the page keeps its state key): there the screen fades with aria-busy from
 * the tap, and the pressed control spins. The tabs show a spinner in the icon's place while their
 * page is on the way before its loading screen is there (useLinkStatus).
 */

const USER = "00000000-0000-4000-8000-00000000000a";
const mocks = vi.hoisted(() => ({ db: null as unknown, linkPending: false }));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { forcedHooks } = await import("./element-tree");
  return forcedHooks(actual);
});
vi.mock("next/link", async () => {
  const { createElement: h } = await import("react");
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const Link = ({ href, children, prefetch, scroll, replace, ...rest }: Record<string, unknown>) => h("a", { href: String(href), ...rest }, children as never);
  return { default: Link, useLinkStatus: () => ({ pending: mocks.linkPending }) };
});
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`NEXT_REDIRECT ${to}`);
  },
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/app/calendar",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => Object.assign(mocks.db as FakeDb, { auth: { getUser: async () => ({ data: { user: { id: USER } }, error: null }) } }),
  getUser: async () => ({ id: USER }),
}));

/** Tomorrow, so the calendar shows the parcel as one ahead. */
const AHEAD = (() => {
  const d = new Date(`${todayJst()}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
})();

beforeEach(() => {
  mocks.db = new FakeDb({ parcels: [{ id: "00000000-0000-4000-8000-000000000001", user_id: USER, shop: "テスト店", title: "品名", status: "shipped", expected_date: AHEAD, ordered_at: AHEAD }] });
  mocks.linkPending = false;
  forced.pending = false;
});
afterEach(() => {
  forced.pending = false;
});

const appDir = path.resolve(__dirname, "../../app/app");
const bones = (root: HtmlNode) => findAll(root, (n) => hasClasses(n, "animate-pulse"));
const cards = (root: HtmlNode) => findAll(root, (n) => hasClasses(n, "rounded-2xl", "border", "bg-white", "p-4"));
const h1 = (root: HtmlNode) => findAll(root, (n) => n.tag === "h1").map((h) => textOf(h).trim());
const spinners = (root: HtmlNode) => findAll(root, (n) => hasClasses(n, "animate-spin"));

/** Each screen under /app, and what its frame has. */
const SCREENS: Array<[string, (root: HtmlNode) => void]> = [
  [
    "",
    (root) => {
      expect(cards(root)).toHaveLength(5);
      expect(findAll(root, (n) => n.tag === "a")).toHaveLength(0);
    },
  ],
  [
    "calendar",
    (root) => {
      const grid = findAll(root, (n) => hasClasses(n, "grid", "grid-cols-7", "gap-y-1"));
      expect(grid).toHaveLength(1);
      expect(bones(grid[0])).toHaveLength(35);
      expect(findAll(root, (n) => hasClasses(n, "grid", "grid-cols-7", "text-center")).map((n) => textOf(n))).toEqual(["日月火水木金土"]);
      expect(textOf(root)).toContain("‹ 前月");
      expect(textOf(root)).toContain("翌月 ›");
      // The month is not known yet: nothing to move to.
      expect(findAll(root, (n) => n.tag === "a")).toHaveLength(0);
    },
  ],
  [
    "spend",
    (root) => {
      expect(textOf(root)).toContain("月全期間");
      expect(findAll(root, (n) => n.tag === "a")).toHaveLength(0);
      expect(bones(root).length).toBeGreaterThanOrEqual(10);
    },
  ],
  [
    "delivered",
    (root) => {
      expect(h1(root)).toEqual(["受け取り済み"]);
      expect(linksTo(root, "/app")).toHaveLength(1);
      expect(cards(root)).toHaveLength(3);
    },
  ],
  [
    "cancelled",
    (root) => {
      expect(h1(root)).toEqual(["キャンセルした荷物"]);
      expect(linksTo(root, "/app")).toHaveLength(1);
      expect(cards(root)).toHaveLength(3);
    },
  ],
  [
    "parcels/[id]",
    (root) => {
      expect(linksTo(root, "/app")).toHaveLength(1);
      const facts = findAll(root, (n) => hasClasses(n, "grid", "grid-cols-[6rem_1fr]"));
      expect(facts).toHaveLength(1);
      expect(bones(facts[0])).toHaveLength(12);
    },
  ],
  [
    "parcels/[id]/edit",
    (root) => {
      expect(h1(root)).toEqual(["荷物を編集"]);
      // 「‹ 戻る」 needs the parcel's id: not a link until the page is in.
      expect(findAll(root, (n) => n.tag === "a")).toHaveLength(0);
      expect(textOf(root)).toContain("‹ 戻る");
    },
  ],
  [
    "parcels/new",
    (root) => {
      expect(h1(root)).toEqual(["荷物を登録"]);
      expect(linksTo(root, "/app")).toHaveLength(1);
    },
  ],
  [
    "settings",
    (root) => {
      expect(h1(root)).toEqual(["設定"]);
      expect(findAll(root, (n) => n.tag === "a")).toHaveLength(0);
    },
  ],
  [
    "settings/forwarding",
    (root) => {
      expect(h1(root)).toEqual(["メールの転送"]);
      expect(linksTo(root, "/app/settings")).toHaveLength(1);
      expect(textOf(root)).toContain("‹ 設定");
    },
  ],
  [
    "settings/password",
    (root) => {
      expect(h1(root)).toEqual(["パスワードとメールの鍵"]);
      expect(linksTo(root, "/app/settings")).toHaveLength(1);
      expect(textOf(root)).toContain("‹ 設定");
    },
  ],
  [
    "settings/dropped",
    (root) => {
      expect(h1(root)).toEqual(["読まなかったメール"]);
      expect(linksTo(root, "/app/settings")).toHaveLength(1);
      expect(textOf(root)).toContain("‹ 設定");
    },
  ],
  [
    "settings/mail-handling",
    (root) => {
      expect(h1(root)).toEqual(["あなたのメールの扱い"]);
      expect(linksTo(root, "/app/settings")).toHaveLength(1);
      expect(textOf(root)).toContain("‹ 設定");
    },
  ],
  [
    "settings/trouble",
    (root) => {
      expect(h1(root)).toEqual(["うまく届かないとき"]);
      expect(linksTo(root, "/app/settings")).toHaveLength(1);
      expect(textOf(root)).toContain("‹ 設定");
    },
  ],
  [
    "settings/demo",
    (root) => {
      expect(h1(root)).toEqual(["サンプルで試す"]);
      expect(linksTo(root, "/app/settings")).toHaveLength(1);
      expect(textOf(root)).toContain("‹ 設定");
    },
  ],
  [
    "settings/delete",
    (root) => {
      expect(h1(root)).toEqual(["アカウントの削除"]);
      expect(linksTo(root, "/app/settings")).toHaveLength(1);
      expect(textOf(root)).toContain("‹ 設定");
    },
  ],
  [
    "welcome",
    (root) => {
      expect(h1(root)).toEqual(["最後に、メールの自動転送を設定しますか？"]);
      expect(findAll(root, (n) => n.tag === "a")).toHaveLength(0);
    },
  ],
];

/** Imported one by one: the bundler needs each path whole. */
const LOADERS: Record<string, () => Promise<{ default: unknown }>> = {
  "": () => import("@/app/app/loading"),
  calendar: () => import("@/app/app/calendar/loading"),
  spend: () => import("@/app/app/spend/loading"),
  delivered: () => import("@/app/app/delivered/loading"),
  cancelled: () => import("@/app/app/cancelled/loading"),
  "parcels/[id]": () => import("@/app/app/parcels/[id]/loading"),
  "parcels/[id]/edit": () => import("@/app/app/parcels/[id]/edit/loading"),
  "parcels/new": () => import("@/app/app/parcels/new/loading"),
  settings: () => import("@/app/app/settings/(list)/loading"),
  "settings/forwarding": () => import("@/app/app/settings/forwarding/loading"),
  "settings/password": () => import("@/app/app/settings/password/loading"),
  "settings/dropped": () => import("@/app/app/settings/dropped/loading"),
  "settings/mail-handling": () => import("@/app/app/settings/mail-handling/loading"),
  "settings/trouble": () => import("@/app/app/settings/trouble/loading"),
  "settings/demo": () => import("@/app/app/settings/demo/loading"),
  "settings/delete": () => import("@/app/app/settings/delete/loading"),
  welcome: () => import("@/app/app/welcome/loading"),
};

describe("loading screens under /app", () => {
  it("covers every screen it names", () => {
    expect(Object.keys(LOADERS).sort()).toEqual(SCREENS.map(([r]) => r).sort());
  });

  it.each(SCREENS)("/app/%s has a loading.tsx drawn with the shared skeleton", (route) => {
    const file = path.join(appDir, route === "settings" ? "settings/(list)" : route, "loading.tsx");
    expect(existsSync(file), file).toBe(true);
    expect(readFileSync(file, "utf8")).toMatch(/<SkeletonScreen\b/);
  });

  it.each(SCREENS)("/app/%s while loading: the screen's frame, 「読み込み中」 for screen readers, and nothing it has not read", async (route, shape) => {
    const Loading = (await LOADERS[route]()).default as () => Parameters<typeof renderToStaticMarkup>[0];
    const root = parseHtml(renderToStaticMarkup(createElement(Loading)));
    const top = root.children.filter((c) => typeof c !== "string") as HtmlNode[];
    expect(top).toHaveLength(1);
    expect(top[0].attrs.role).toBe("status");
    expect(top[0].attrs["aria-busy"]).toBe("true");
    const sr = findAll(root, (n) => hasClasses(n, "sr-only"));
    expect(sr.map((n) => textOf(n))).toEqual(["読み込み中"]);
    // What a sighted person reads: no verdict on the list, no number.
    const seen = textOf(root).replace("読み込み中", "");
    for (const verdict of ["ありません", "読み込めませんでした", "見つかりません", "まだ"]) expect(seen).not.toContain(verdict);
    expect(seen).not.toMatch(/\d/);
    expect(bones(root).length).toBeGreaterThanOrEqual(3);
    for (const b of bones(root)) expect(b.attrs["aria-hidden"]).toBe("true");
    shape(root);
  });

  it("the shared skeleton scrolls to the URL's #fragment once the page is in (「サンプルで試す」 → /app/settings/demo)", () => {
    const source = readFileSync(path.resolve(__dirname, "../../components/skeleton.tsx"), "utf8");
    expect(source).toMatch(/<ScrollToHashOnReady \/>/);
    expect(readFileSync(path.join(appDir, "page.tsx"), "utf8")).toContain('href="/app/settings/demo"');
  });
});

describe("a move that changes only the query fades the screen from the tap", () => {
  const render = async (mod: string, params: Record<string, string>) => {
    const Page = (await import(mod)).default as (p: { searchParams: Promise<Record<string, string>> }) => Promise<Parameters<typeof renderToStaticMarkup>[0]>;
    return parseHtml(renderToStaticMarkup(await Page({ searchParams: Promise.resolve(params) })));
  };
  const busy = (root: HtmlNode) => findAll(root, (n) => n.attrs["aria-busy"] === "true");

  it("the calendar: the grid, the days and 「受け取り済み」 fade with aria-busy; 前月／翌月 stay out of it", async () => {
    forced.pending = true;
    const root = await render("@/app/app/calendar/page", { m: AHEAD.slice(0, 7) });
    const area = busy(root);
    expect(area).toHaveLength(1);
    expect(hasClasses(area[0], "opacity-50")).toBe(true);
    expect(textOf(area[0])).toContain("日月火水木金土");
    expect(textOf(area[0])).toContain("1件");
    expect(linksTo(area[0], "/app/delivered")).toHaveLength(1);
    expect(findAll(area[0], (n) => n.tag === "a" && (n.attrs.href ?? "").startsWith("/app/calendar?m="))).toHaveLength(0);

    forced.pending = false;
    expect(busy(await render("@/app/app/calendar/page", { m: AHEAD.slice(0, 7) }))).toHaveLength(0);
  });

  it("the spend screen: the figures and the orders fade with aria-busy", async () => {
    forced.pending = true;
    const area = busy(await render("@/app/app/spend/page", { m: AHEAD.slice(0, 7) }));
    expect(area).toHaveLength(1);
    expect(hasClasses(area[0], "opacity-50")).toBe(true);
    expect(textOf(area[0])).toContain("注文");
  });
});

describe("the tabs", () => {
  const draw = async () => parseHtml(renderToStaticMarkup(createElement((await import("@/app/app/tab-bar")).TabBar)));

  it("show each tab's icon, and a spinner of the same size in its place while that tab's page is on the way", async () => {
    let root = await draw();
    expect(findAll(root, (n) => n.tag === "a")).toHaveLength(4);
    expect(findAll(root, (n) => n.tag === "svg")).toHaveLength(4);
    expect(spinners(root)).toHaveLength(0);

    mocks.linkPending = true;
    root = await draw();
    expect(findAll(root, (n) => n.tag === "svg")).toHaveLength(0);
    expect(spinners(root)).toHaveLength(4);
    for (const a of findAll(root, (n) => n.tag === "a")) {
      const box = findAll(a, (n) => n.tag === "span" && hasClasses(n, "h-5", "w-5"));
      expect(box).toHaveLength(1);
      expect(spinners(box[0])).toHaveLength(1);
    }
  });

  it("read the pending state with useLinkStatus, inside each Link", () => {
    const source = readFileSync(path.join(appDir, "tab-bar.tsx"), "utf8");
    expect(source).toMatch(/import Link, \{ useLinkStatus \} from "next\/link";/);
    expect(source).toMatch(/<Link\b[\s\S]*?<TabIcon\b[\s\S]*?<\/Link>/);
  });
});
