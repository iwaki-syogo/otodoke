import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { todayJst } from "@/lib/format";
import { FakeDb, describeQuery, type Query } from "./fake-db";
import { findAll, linksTo, parseHtml, textOf, type HtmlNode } from "./html-tree";

/**
 * [Feedback 4-6] The parcel list.
 * 5: 「届いた荷物 ›」 is a PageLink (see calendar.test.ts for the part itself).
 * 4: cancelled parcels leave the list for their own page /app/cancelled, reached by
 *    「キャンセルした荷物 ›」 right under 「届いた荷物 ›」, shown even at 0. Neither link shows a count (owner's rule).
 * 6: the red 「対面受け取りが必要な商品」 card leaves the list; the card's badge stays.
 * [Codex-P1] The two links are at the end of the list on the empty screen too.
 */

const USER = "00000000-0000-4000-8000-00000000000a";

const mocks = vi.hoisted(() => ({ state: { db: null as unknown, pathname: "/app" } }));

// These existing UI scenarios begin after the person has allowed reading.
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
  usePathname: () => mocks.state.pathname,
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => Object.assign(mocks.state.db as FakeDb, { auth: { getUser: async () => ({ data: { user: { id: USER } }, error: null }) } }),
  getUser: async () => ({ id: USER }),
}));

const TODAY = todayJst();
const day = (n: number) => {
  const d = new Date(`${TODAY}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

let seq = 0;
const parcel = (over: Record<string, unknown>) => ({
  id: `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`,
  user_id: USER,
  shop: "テスト店",
  title: `品名${seq}`,
  status: "shipped",
  updated_at: "2026-11-01T00:00:00Z",
  ...over,
});

let db: FakeDb;
beforeEach(() => {
  db = new FakeDb({ parcels: [], emails: [] });
  mocks.state.db = db;
  mocks.state.pathname = "/app";
});

const read = (rel: string) => readFileSync(path.resolve(__dirname, "../../app/app", rel), "utf8");

async function renderList() {
  const Page = (await import("@/app/app/page")).default;
  const html = renderToStaticMarkup(await Page());
  return { html, root: parseHtml(html) };
}

const one = (root: HtmlNode, href: string) => {
  const links = linksTo(root, href);
  expect(links, href).toHaveLength(1);
  return links[0];
};

/** Neither link on the list shows a count: the number is seen after opening the page. */
function expectNoCount(root: HtmlNode) {
  for (const href of ["/app/delivered", "/app/cancelled"]) {
    expect(textOf(one(root, href)), href).not.toMatch(/\d\s*件|\d/);
  }
}

/** 「届いた荷物 ›」 then 「キャンセルした荷物 ›」 right under it, with nothing in between. */
function expectLinksTogether(html: string) {
  const delivered = html.indexOf('href="/app/delivered"');
  const cancelled = html.indexOf('href="/app/cancelled"');
  expect(delivered, "link to /app/delivered").toBeGreaterThanOrEqual(0);
  expect(cancelled, "link to /app/cancelled").toBeGreaterThan(delivered);
  const between = html.slice(html.indexOf("</a>", delivered) + "</a>".length, html.lastIndexOf("<a", cancelled));
  expect(between.replace(/<[^>]+>/g, "").trim(), "text between the two links").toBe("");
  expect(between, "elements between the two links").not.toMatch(/<(a|section|p|button|details|h2|ul)\b/);
}

describe("[Feedback 4/5] 「届いた荷物 ›」 and 「キャンセルした荷物 ›」 in the list", () => {
  it("[Codex-P1] shows both links on the empty screen, with no count, and keeps the empty screen", async () => {
    const { html, root } = await renderList();
    expectNoCount(root);
    expectLinksTogether(html);
    expect(textOf(root)).toContain("まだ荷物がありません");
    expect(linksTo(root, "/app/parcels/new")).toHaveLength(1);
  });

  it("[Codex-P1] shows both links when every parcel is delivered or cancelled", async () => {
    db = new FakeDb({ parcels: [parcel({ status: "delivered" }), parcel({ status: "delivered" }), parcel({ status: "cancelled" })], emails: [] });
    mocks.state.db = db;
    const { html, root } = await renderList();
    expectNoCount(root);
    expectLinksTogether(html);
  });

  it("puts 「キャンセルした荷物 ›」 right under 「届いた荷物 ›」, at the end of the list", async () => {
    const seeded = [
      parcel({ status: "shipped", expected_date: day(1) }),
      parcel({ status: "ordered" }),
      parcel({ status: "delivered" }),
      parcel({ status: "cancelled" }),
      parcel({ status: "cancelled" }),
    ];
    db = new FakeDb({ parcels: seeded, emails: [] });
    mocks.state.db = db;
    const { html, root } = await renderList();
    expectNoCount(root);
    expectLinksTogether(html);
    // No parcel card after the two links.
    const lastCard = Math.max(...seeded.map((p) => html.lastIndexOf(`href="/app/parcels/${p.id}"`)));
    expect(lastCard).toBeGreaterThanOrEqual(0);
    expect(lastCard).toBeLessThan(html.indexOf('href="/app/delivered"'));
  });

  it("no longer lists cancelled parcels in the list", async () => {
    const gone = parcel({ status: "cancelled", title: "キャンセルした品" });
    db = new FakeDb({ parcels: [parcel({ status: "shipped", expected_date: day(2) }), gone], emails: [] });
    mocks.state.db = db;
    const { root } = await renderList();
    expect(linksTo(root, `/app/parcels/${gone.id}`)).toHaveLength(0);
    expect(textOf(root)).not.toContain("キャンセルした品");
    expect(textOf(root)).not.toMatch(/キャンセル\s*\d+\s*件/);
  });

  it("shows neither link with a count, and reads no delivered/cancelled head count", async () => {
    db = new FakeDb({ parcels: [parcel({ status: "delivered" }), parcel({ status: "cancelled" }), parcel({ status: "shipped", expected_date: day(2) })], emails: [] });
    mocks.state.db = db;
    const { root } = await renderList();
    expectNoCount(root);
    const heads = db.callsOn("parcels", "select").filter((q: Query) => q.head);
    expect(heads.map(describeQuery)).toHaveLength(0);
  });

  it("[negative control] expectNoCount fails on a link that carries a count", async () => {
    const { PageLink } = (await import("@/app/app/page-link")) as unknown as {
      PageLink: (p: { href: string; label: string; count?: number }) => ReturnType<typeof createElement>;
    };
    const root = parseHtml(renderToStaticMarkup(createElement(PageLink, { href: "/app/delivered", label: "届いた荷物", count: 2 })));
    expect(() => expect(textOf(one(root, "/app/delivered"))).not.toMatch(/\d\s*件/)).toThrow();
  });
});

describe("[Feedback 6] the red 「対面受け取りが必要な商品」 card", () => {
  it("is gone from the list, while the parcel's own card keeps its badge", async () => {
    const inPerson = parcel({ status: "shipped", requires_presence: true, expected_date: day(3), title: "対面で受け取る品" });
    db = new FakeDb({ parcels: [inPerson, parcel({ status: "shipped", requires_presence: false, expected_date: day(1) })], emails: [] });
    mocks.state.db = db;
    const { root } = await renderList();
    expect(textOf(root)).not.toContain("対面受け取りが必要な商品");
    // Listed once, as its card, not a second time in a red card.
    const cards = linksTo(root, `/app/parcels/${inPerson.id}`);
    expect(cards).toHaveLength(1);
    expect(textOf(cards[0])).toContain("🤝 対面受け取り");
    expect(findAll(root, (n) => n.tag === "section" && (n.attrs.class ?? "").includes("bg-red-50"))).toHaveLength(0);
  });
});

describe("[Feedback 4] /app/cancelled", () => {
  async function renderCancelled() {
    const mod = await import("@/app/app/cancelled/page");
    const html = renderToStaticMarkup(await mod.default());
    return { mod, html, root: parseHtml(html) };
  }
  const parcelLinks = (root: HtmlNode) => findAll(root, (n) => n.tag === "a" && /^\/app\/parcels\/[^/]+$/.test(n.attrs.href ?? ""));

  it("lists only cancelled parcels, by the month they were ordered", async () => {
    const oct1 = parcel({ status: "cancelled", ordered_at: "2026-10-05" });
    const oct2 = parcel({ status: "cancelled", ordered_at: "2026-10-20" });
    const sep = parcel({ status: "cancelled", ordered_at: "2026-09-01" });
    const others = [parcel({ status: "delivered", ordered_at: "2026-10-10" }), parcel({ status: "shipped", ordered_at: "2026-10-11" })];
    db = new FakeDb({ parcels: [sep, ...others, oct1, oct2] });
    mocks.state.db = db;
    const { root } = await renderCancelled();
    expect(parcelLinks(root).map((a) => a.attrs.href)).toEqual([oct2, oct1, sep].map((p) => `/app/parcels/${p.id}`));
    expect(findAll(root, (n) => n.tag === "h2").map((h) => textOf(h))).toEqual([expect.stringContaining("2026年10月に注文"), expect.stringContaining("2026年9月に注文")]);
    const [h1] = findAll(root, (n) => n.tag === "h1");
    expect(textOf(h1)).toMatch(/^キャンセルした荷物\s*3$/);
  });

  it("reads every cancelled parcel, past the 1000-row cap", async () => {
    db = new FakeDb({ parcels: Array.from({ length: 1001 }, () => parcel({ status: "cancelled", ordered_at: "2026-10-01" })) });
    mocks.state.db = db;
    const { root } = await renderCancelled();
    expect(parcelLinks(root)).toHaveLength(1001);
    expect(textOf(findAll(root, (n) => n.tag === "h1")[0])).toMatch(/1,001/);
    for (const q of db.callsOn("parcels", "select")) expect(q.filters.some((f) => f.method === "eq" && f.args[0] === "status" && f.args[1] === "cancelled"), describeQuery(q)).toBe(true);
  });

  it("says 「読み込めませんでした」 when the read fails, not that there are none", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    db = new FakeDb({ parcels: [parcel({ status: "cancelled" })] });
    db.hooks.push((q) => (q.table === "parcels" ? { data: null, error: { message: "boom" }, count: null } : undefined));
    mocks.state.db = db;
    try {
      const { root } = await renderCancelled();
      expect(textOf(root)).toContain("読み込めませんでした");
      expect(textOf(root)).not.toContain("キャンセルした荷物はありません");
      expect(parcelLinks(root)).toHaveLength(0);
    } finally {
      log.mockRestore();
    }
  });

  it("says 「キャンセルした荷物はありません」 when there are none", async () => {
    db = new FakeDb({ parcels: [parcel({ status: "delivered" })] });
    mocks.state.db = db;
    const { root } = await renderCancelled();
    expect(textOf(root)).toContain("キャンセルした荷物はありません");
    expect(parcelLinks(root)).toHaveLength(0);
  });

  it("goes back with 「‹ 荷物」 and is titled 「キャンセルした荷物」", async () => {
    const { mod, root } = await renderCancelled();
    expect(textOf(one(root, "/app")).trim()).toBe("‹ 荷物");
    expect((mod as unknown as { metadata: { title: string } }).metadata.title).toBe("キャンセルした荷物");
  });

  it("is built like the delivered page: readAll, status = cancelled, 「読み込めませんでした」, no search", () => {
    const page = read("cancelled/page.tsx");
    expect(page).toContain("readAll");
    expect(page).toContain("groupByOrderMonth");
    expect(page).toMatch(/\.eq\(\s*["']status["']\s*,\s*["']cancelled["']\s*\)/);
    expect(page).toContain("読み込めませんでした");
    expect(page).not.toMatch(/<input\b|searchParams/);
  });
});

describe("[Feedback 4] the 荷物 tab", () => {
  const tabs = async (pathname: string) => {
    mocks.state.pathname = pathname;
    const { TabBar } = await import("@/app/app/tab-bar");
    const root = parseHtml(renderToStaticMarkup(createElement(TabBar)));
    return findAll(root, (n) => n.tag === "a" && n.attrs["aria-current"] === "page").map((a) => textOf(a).trim());
  };

  it.each(["/app", "/app/delivered", "/app/cancelled", "/app/parcels/abc"])("is selected on %s", async (p) => {
    expect(await tabs(p)).toEqual(["荷物"]);
  });

  it("is not selected on the calendar", async () => {
    expect(await tabs("/app/calendar")).toEqual(["カレンダー"]);
  });
});

describe("[Feedback 4-6] source", () => {
  const appDir = path.resolve(__dirname, "../../app");
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const full = path.join(dir, name);
      return statSync(full).isDirectory() ? files(full) : /\.tsx?$/.test(name) ? [full] : [];
    });

  it("drops the red card, Folded and the cancelled filter from the list", () => {
    const list = read("page.tsx");
    expect(list).not.toContain("対面受け取りが必要な商品");
    expect(list).not.toMatch(/\binPerson\b/);
    expect(list).not.toMatch(/\bFolded\b/);
    expect(list).not.toMatch(/status\s*===\s*["']cancelled["']\s*\)/);
  });

  it("uses PageLink in three places: two in the list, one in the calendar", () => {
    const users = files(appDir).filter((f) => /<PageLink\b/.test(readFileSync(f, "utf8")));
    expect(users.map((f) => path.relative(appDir, f)).sort()).toEqual(["app/calendar/page.tsx", "app/page.tsx"]);
    const list = read("page.tsx");
    expect(list).toMatch(/<PageLink\b[^>]*href=\{?\s*["']\/app\/delivered["']/);
    expect(list).toMatch(/<PageLink\b[^>]*href=\{?\s*["']\/app\/cancelled["']/);
  });

  it("leaves no DeliveredLink behind", () => {
    expect(existsSync(path.resolve(appDir, "app/delivered-link.tsx"))).toBe(false);
    const src = path.resolve(__dirname, "../..");
    for (const f of files(src).filter((x) => !x.includes(`${path.sep}__tests__${path.sep}`))) {
      expect(readFileSync(f, "utf8"), f).not.toMatch(/delivered-link|DeliveredLink/);
    }
  });

  it("[README] describes 置き配 with the card's badge and the calendar, not the removed red card", () => {
    const readme = readFileSync(path.resolve(__dirname, "../../../README.md"), "utf8");
    const line = readme.split("\n").find((l) => l.includes("置き配できるか"));
    expect(line).toBeDefined();
    expect(line).not.toContain("対面受け取りが必要な商品");
    expect(line).toContain("カレンダー");
    expect(readme).not.toContain("「対面受け取りが必要な商品」として強調");
  });
});
