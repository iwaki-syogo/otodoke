import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeDb } from "./fake-db";
import { findAll, parseHtml, textOf, type HtmlNode } from "./html-tree";

/**
 * The calendar and the spend page (a month) put MonthPicker in the heading (task 4). MonthPicker
 * is replaced here by a stand-in that writes its props out, so the test reads what each page
 * passes: calendar -> { value: ym, basePath: "/app/calendar" } and no kept value; spend ->
 * { value: ym, basePath: "/app/spend", keep: { c, s } } with the URL's ?c= / ?s= strings.
 * 「‹ 前月」「翌月 ›」 stay on both. The whole period has no picker.
 */

const USER = "00000000-0000-4000-8000-00000000000a";
const mocks = vi.hoisted(() => ({ state: { db: null as unknown } }));

vi.mock("@/app/app/month-picker", async () => {
  const { createElement } = await import("react");
  return { MonthPicker: (props: Record<string, unknown>) => createElement("output", { "data-picker": JSON.stringify(props) }) };
});
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: vi.fn(),
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/app",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => Object.assign(mocks.state.db as FakeDb, { auth: { getUser: async () => ({ data: { user: { id: USER } }, error: null }) } }),
  getUser: async () => ({ id: USER }),
}));

beforeEach(() => {
  mocks.state.db = new FakeDb({
    parcels: [{ id: "00000000-0000-4000-8000-000000000001", user_id: USER, shop: "Amazon.co.jp", shop_key: "amazon", title: "品", status: "delivered", ordered_at: "2026-10-05", total_amount: 1000, category: "food" }],
  });
});

async function renderPage(mod: string, params: Record<string, string>) {
  const Page = (await import(mod)).default;
  return parseHtml(renderToStaticMarkup(await Page({ searchParams: Promise.resolve(params) } as never)));
}

const pickers = (root: HtmlNode) => findAll(root, (n) => n.tag === "output" && "data-picker" in n.attrs).map((n) => JSON.parse(n.attrs["data-picker"]) as { value: string; basePath: string; keep?: Record<string, string | undefined> });
/** keep without the empty values: what monthHref would send. */
const kept = (keep?: Record<string, string | undefined>) => Object.fromEntries(Object.entries(keep ?? {}).filter(([, v]) => v !== undefined && v !== ""));
const linkText = (root: HtmlNode) => findAll(root, (n) => n.tag === "a").map((n) => textOf(n).trim());

describe("calendar heading", () => {
  it("is MonthPicker for the month shown, with nothing kept", async () => {
    const root = await renderPage("@/app/app/calendar/page", { m: "2026-10" });
    const p = pickers(root);
    expect(p).toHaveLength(1);
    expect(p[0].value).toBe("2026-10");
    expect(p[0].basePath).toBe("/app/calendar");
    expect(kept(p[0].keep)).toEqual({});
  });

  it("keeps 「‹ 前月」 and 「翌月 ›」", async () => {
    const root = await renderPage("@/app/app/calendar/page", { m: "2026-10" });
    expect(linkText(root)).toEqual(expect.arrayContaining(["‹ 前月", "翌月 ›"]));
  });

  it("imports MonthPicker", () => {
    const source = readFileSync(path.resolve(__dirname, "../../app/app/calendar/page.tsx"), "utf8");
    expect(source).toMatch(/import\s*\{\s*MonthPicker\s*\}\s*from\s*["']\.\.\/month-picker["']/);
  });
});

describe("spend heading", () => {
  it("is MonthPicker for the month shown, keeping ?c= and ?s=", async () => {
    const p = pickers(await renderPage("@/app/app/spend/page", { m: "2026-10", c: "none", s: "Amazon" }));
    expect(p).toHaveLength(1);
    expect(p[0].value).toBe("2026-10");
    expect(p[0].basePath).toBe("/app/spend");
    expect(kept(p[0].keep)).toEqual({ c: "none", s: "Amazon" });
  });

  it("keeps nothing without ?c= and ?s=, and drops an unknown ?c=", async () => {
    expect(kept(pickers(await renderPage("@/app/app/spend/page", { m: "2026-10" }))[0].keep)).toEqual({});
    expect(kept(pickers(await renderPage("@/app/app/spend/page", { m: "2026-10", c: "toys" }))[0].keep)).toEqual({});
  });

  it("keeps 「‹ 前月」 and 「翌月 ›」", async () => {
    const root = await renderPage("@/app/app/spend/page", { m: "2026-10" });
    expect(linkText(root)).toEqual(expect.arrayContaining(["‹ 前月", "翌月 ›"]));
  });

  it("has no picker over the whole period, which keeps its 「全期間」 heading", async () => {
    const root = await renderPage("@/app/app/spend/page", { m: "all" });
    expect(pickers(root)).toHaveLength(0);
    expect(findAll(root, (n) => n.tag === "h1").map((n) => textOf(n).trim())).toEqual(["全期間"]);
  });
});
