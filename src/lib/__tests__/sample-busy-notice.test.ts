import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeDb } from "./fake-db";
import { findAll, parseHtml, textOf } from "./html-tree";

/**
 * The sample load leaves /app?demo=busy when another load is running. The list says so in one line,
 * and only for that marker: no other ?demo= value, and no marker, show it.
 */

const USER = "00000000-0000-4000-8000-00000000000a";
const NOTICE = "ほかの人がサンプルを読み込んでいます。少し待ってから、下の「読み込み直す」を押してください。";

const mocks = vi.hoisted(() => ({ state: { db: null as unknown } }));

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
  mocks.state.db = new FakeDb({ parcels: [], emails: [] });
});

async function render(searchParams?: { demo?: string }) {
  const Page = (await import("@/app/app/page")).default;
  return parseHtml(renderToStaticMarkup(await Page(searchParams ? { searchParams: Promise.resolve(searchParams) } : undefined)));
}

describe("the note that another load is running", () => {
  it("shows once for ?demo=busy", async () => {
    const tree = await render({ demo: "busy" });
    const notes = findAll(tree, (n) => n.tag === "p" && textOf(n).includes(NOTICE));
    expect(notes).toHaveLength(1);
    // The link inside it goes to /app without the marker, so the note is gone after pressing it.
    const links = findAll(notes[0], (n) => n.tag === "a" && textOf(n).trim() === "読み込み直す");
    expect(links).toHaveLength(1);
    expect(links[0].attrs.href).toBe("/app");
  });

  it("is not shown without the marker, nor for another value", async () => {
    for (const params of [undefined, {}, { demo: "3" }, { demo: "Busy" }]) {
      expect(findAll(await render(params), (n) => textOf(n).includes("サンプルを読み込んでいます"))).toHaveLength(0);
      expect(findAll(await render(params), (n) => n.tag === "a" && textOf(n).trim() === "読み込み直す")).toHaveLength(0);
    }
  });
});
