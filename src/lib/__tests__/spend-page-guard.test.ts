import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { categoryLabel } from "@/lib/category";
import { yen } from "@/lib/format";
import { FakeDb } from "./fake-db";
import { findAll, linksTo, parseHtml, textOf, type HtmlNode } from "./html-tree";

/**
 * Characterization of the spend page around the shop and ?c= reading that task 1 moves to
 * src/lib/shop.ts. These hold before and after the move (and after the ?s= work): Amazon's names
 * read as one shop, ?c=none is 未分類, an unknown ?c= narrows nothing, a picked category narrows
 * the month's orders, and the month list has no order-month headings.
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
  usePathname: () => "/app/spend",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => Object.assign(mocks.state.db as FakeDb, { auth: { getUser: async () => ({ data: { user: { id: USER } }, error: null }) } }),
  getUser: async () => ({ id: USER }),
}));

let seq = 0;
const parcel = (over: Record<string, unknown>) => ({
  id: `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`,
  user_id: USER,
  shop: "テスト店",
  title: `品名${seq}`,
  status: "delivered",
  updated_at: "2026-11-01T00:00:00Z",
  ...over,
});

const A1 = parcel({ shop: "Amazon.co.jp", shop_key: "amazon", ordered_at: "2026-10-05", total_amount: 1000, category: "food" });
const A2 = parcel({ shop: "アマゾン", shop_key: "amazon", ordered_at: "2026-10-10", total_amount: 2000, category: null });
const Y = parcel({ shop: "テスト電機", shop_key: "other", ordered_at: "2026-10-12", total_amount: 5000, category: "electronics" });
const OLD = parcel({ shop: "テスト電機", shop_key: "other", ordered_at: "2026-09-01", total_amount: 700, category: "food" });

beforeEach(() => {
  mocks.state.db = new FakeDb({ parcels: [A1, A2, Y, OLD] });
});

async function render(params: Record<string, string>) {
  const Page = (await import("@/app/app/spend/page")).default;
  return parseHtml(renderToStaticMarkup(await Page({ searchParams: Promise.resolve(params) } as never)));
}

const orderIds = (root: HtmlNode) =>
  findAll(root, (n) => n.tag === "a" && (n.attrs.href ?? "").startsWith("/app/parcels/"))
    .map((n) => n.attrs.href.slice("/app/parcels/".length))
    .sort();

describe("spend page: shops", () => {
  it("reads Amazon's names as one 「Amazon」 under 店ごと, with their amounts added", async () => {
    const text = textOf(await render({ m: "2026-10" }));
    // From 店ごと up to the 注文 heading that follows it.
    const from = text.indexOf("店ごと");
    const shops = text.slice(from, text.indexOf("注文", from));
    expect(shops).toContain(`Amazon${yen(3000)}`);
    expect(shops).not.toContain("Amazon.co.jp");
    expect(shops).not.toContain("アマゾン");
    expect(shops).toContain(`テスト電機${yen(5000)}`);
  });
});

describe("spend page: ?c=", () => {
  it("lists only 未分類 for ?c=none", async () => {
    expect(orderIds(await render({ m: "2026-10", c: "none" }))).toEqual([A2.id]);
  });

  it("lists only the picked category", async () => {
    expect(orderIds(await render({ m: "2026-10", c: "food" }))).toEqual([A1.id]);
  });

  it("narrows nothing for an unknown ?c=", async () => {
    expect(orderIds(await render({ m: "2026-10", c: "toys" }))).toEqual([A1.id, A2.id, Y.id].sort());
    expect(textOf(await render({ m: "2026-10", c: "toys" }))).not.toMatch(/だけ\s*×/);
  });

  it("offers 「◯◯だけ ×」 back to the month without ?c=", async () => {
    const root = await render({ m: "2026-10", c: "none" });
    const chip = findAll(root, (n) => n.tag === "a" && /だけ\s*×/.test(textOf(n)));
    expect(chip).toHaveLength(1);
    expect(textOf(chip[0])).toContain(categoryLabel(null));
    expect(chip[0].attrs.href).toBe("/app/spend?m=2026-10");
  });

  it("narrows the whole-period total to the picked category", async () => {
    const text = textOf(await render({ m: "all", c: "food" }));
    expect(text).toContain(`合計${yen(1700)}`);
  });

  it("totals the month in full without a filter", async () => {
    expect(textOf(await render({ m: "2026-10" }))).toContain(`合計${yen(8000)}`);
  });
});

describe("spend page: the month's orders", () => {
  it("lists the month's orders without order-month headings", async () => {
    const root = await render({ m: "2026-10" });
    expect(orderIds(root)).toEqual([A1.id, A2.id, Y.id].sort());
    expect(textOf(root)).not.toContain("に注文");
    expect(linksTo(root, `/app/parcels/${OLD.id}`)).toHaveLength(0);
  });
});
