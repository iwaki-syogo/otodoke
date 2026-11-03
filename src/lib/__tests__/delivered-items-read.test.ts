import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { forced } from "./element-tree";
import { FakeDb, describeQuery, type Query } from "./fake-db";
import { findAll, parseHtml, textOf, type HtmlNode } from "./html-tree";

/**
 * [Codex-C3][Q5] /app/delivered reads parcel_items only when there is a search word.
 * The items only serve ?q=; with no word (absent, empty or only spaces) the page draws from the
 * parcels alone, so an items read cannot fail it.
 */

const USER = "00000000-0000-4000-8000-00000000000a";

const mocks = vi.hoisted(() => ({
  state: { db: null as unknown },
  router: { push: () => {}, refresh: () => {}, replace: () => {}, back: () => {}, prefetch: () => {} },
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
  usePathname: () => "/app/delivered",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => Object.assign(mocks.state.db as FakeDb, { auth: { getUser: async () => ({ data: { user: { id: USER } }, error: null }) } }),
  getUser: async () => ({ id: USER }),
}));

const D1 = { id: "00000000-0000-4000-8000-000000000101", user_id: USER, shop: "テスト雑貨", shop_key: "other", title: "ノート", status: "delivered", ordered_at: "2026-10-30", updated_at: "2026-11-01T00:00:00Z" };
const D2 = { id: "00000000-0000-4000-8000-000000000102", user_id: USER, shop: "テスト雑貨", shop_key: "other", title: "ペン", status: "delivered", ordered_at: "2026-10-05", updated_at: "2026-11-01T00:00:00Z" };
const ITEM = { id: "10000000-0000-4000-8000-000000000101", parcel_id: D2.id, user_id: USER, name: "変換アダプタ" };

let db: FakeDb;
beforeEach(() => {
  db = new FakeDb({ parcels: [D1, D2], parcel_items: [ITEM] });
  mocks.state.db = db;
  forced.pending = false;
});

async function render(params: Record<string, string>) {
  const Page = (await import("@/app/app/delivered/page")).default as unknown as (p: { searchParams: Promise<Record<string, string>> }) => Promise<Parameters<typeof renderToStaticMarkup>[0]>;
  return parseHtml(renderToStaticMarkup(await Page({ searchParams: Promise.resolve(params) })));
}

const itemReads = () => db.callsOn("parcel_items");
const shown = (root: HtmlNode) =>
  findAll(root, (n) => n.tag === "a" && (n.attrs.href ?? "").startsWith("/app/parcels/")).map((n) => n.attrs.href.slice("/app/parcels/".length));
const askedForUser = (q: Query) => q.filters.some((f) => f.method === "eq" && f.args[0] === "user_id" && f.args[1] === USER);
const failItems = () => db.hooks.push((q) => (q.table === "parcel_items" ? { data: null, error: { message: "boom" }, count: null } : undefined));

describe("[Codex-C3][Q5] delivered page: items are read only for a search word", () => {
  for (const [label, params] of [
    ["no q", {}],
    ["an empty q", { q: "" }],
    ["a q of only spaces", { q: "  　 " }],
  ] as Array<[string, Record<string, string>]>) {
    it(`never reads parcel_items with ${label}, and lists the parcels`, async () => {
      const root = await render(params);
      expect(itemReads().map(describeQuery)).toEqual([]);
      expect(shown(root)).toEqual([D1.id, D2.id]);
    });
  }

  it("reads parcel_items with user_id when there is a word, and an item name matches", async () => {
    const root = await render({ q: "変換" });
    const reads = itemReads();
    expect(reads.length).toBeGreaterThan(0);
    for (const q of reads) expect(askedForUser(q), describeQuery(q)).toBe(true);
    expect(shown(root)).toEqual([D2.id]);
  });

  it("says only 「読み込めませんでした」 when there is a word and the items read fails", async () => {
    failItems();
    const root = await render({ q: "変換" });
    const text = textOf(root);
    expect(text).toContain("読み込めませんでした");
    expect(text).not.toContain("見つかりません");
    expect(text).not.toContain("届いた荷物はありません");
    expect(shown(root)).toEqual([]);
  });

  it("draws the parcels with no word even though an items read would fail", async () => {
    failItems();
    const root = await render({ s: "テスト雑貨" });
    expect(textOf(root)).not.toContain("読み込めませんでした");
    expect(shown(root)).toEqual([D1.id, D2.id]);
    expect(itemReads()).toHaveLength(0);
  });
});
