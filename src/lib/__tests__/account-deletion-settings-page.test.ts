import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeDb } from "./fake-db";
import { findAll, parseHtml, textOf } from "./html-tree";

/**
 * 設定 ends with 「アカウントを削除」 (review E-2): the last section of the page, after ログアウト,
 * closed (no form) until it is pressed.
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
  usePathname: () => "/app/settings",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => Object.assign(mocks.state.db as FakeDb, { auth: { getUser: async () => ({ data: { user: { id: USER } }, error: null }) } }),
  getUser: async () => ({ id: USER, email: "qa@example.com" }),
}));
vi.mock("@/lib/inbox", () => ({ ensureInboxAddress: async () => "abcdefghjk", inboxEmail: () => "abcdefghjk@in.example.test" }));
vi.mock("@/app/app/settings/actions", () => ({ loadDemo: vi.fn(), readWaitingMail: vi.fn(), markWronglyDropped: vi.fn(), clearAllParcels: vi.fn() }));
vi.mock("@/app/app/settings/account-actions", () => ({ deleteAccount: vi.fn() }));
vi.mock("@/app/app/settings/key-actions", () => ({
  registerMailKey: vi.fn(),
  activateMailKey: vi.fn(),
  rewrapMailKey: vi.fn(),
  sealStoredMail: vi.fn(),
  readMailKey: vi.fn(),
  readRetiredMailKeys: vi.fn(),
  readSealedMail: vi.fn(),
}));

beforeEach(() => {
  const db = new FakeDb();
  // The unread count's or(and(...)) filter is beyond the fake; nothing here is unread.
  db.hooks.push((q) => (q.table === "emails" && q.filters.some((f) => f.method === "or") ? { data: null, error: null, count: 0 } : undefined));
  mocks.state.db = db;
});

describe("/app/settings: 「アカウントを削除」", () => {
  it("is the last section, after ログアウト, with no form until pressed", async () => {
    const Page = (await import("@/app/app/settings/page")).default;
    const root = parseHtml(renderToStaticMarkup(await Page({ searchParams: Promise.resolve({}) })));
    const page = findAll(root, (n) => n.tag === "div")[0];
    const sections = page.children.filter((c): c is Exclude<typeof c, string> => typeof c !== "string" && c.tag === "section");
    const last = sections.at(-1)!;
    expect(findAll(last, (n) => n.tag === "button").map(textOf)).toEqual(["アカウントを削除"]);
    expect(findAll(last, (n) => n.tag === "form")).toEqual([]);
    const beforeLast = sections.at(-2)!;
    expect(findAll(beforeLast, (n) => n.tag === "button").map(textOf)).toEqual(["ログアウト"]);
  });
});
