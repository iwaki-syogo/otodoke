import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeDb } from "./fake-db";
import { findAll, parseHtml, textOf } from "./html-tree";

/**
 * 「アカウントを削除」 (review E-2): on its own page now (設定 › アカウントの削除), closed (no form)
 * until it is pressed; the 設定 list ends with the row that opens it, after ログアウト.
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

describe("設定 › アカウントの削除", () => {
  it("the page holds the section, with no form until pressed", async () => {
    const Page = (await import("@/app/app/settings/delete/page")).default;
    const root = parseHtml(renderToStaticMarkup(Page()));
    const sections = findAll(root, (n) => n.tag === "section");
    expect(sections).toHaveLength(1);
    expect(findAll(sections[0], (n) => n.tag === "button").map(textOf)).toEqual(["アカウントを削除"]);
    expect(findAll(sections[0], (n) => n.tag === "form")).toEqual([]);
    expect(findAll(root, (n) => n.tag === "h1").map(textOf)).toEqual(["アカウントの削除"]);
  });

  it("the list ends with 「アカウントの削除」, after ログアウト, and holds no deletion form", async () => {
    const Page = (await import("@/app/app/settings/page")).default;
    const root = parseHtml(renderToStaticMarkup(await Page()));
    const cards = findAll(root, (n) => n.tag === "section");
    const account = cards.at(-1)!;
    const rows = findAll(account, (n) => n.tag === "a" || n.tag === "button" || (n.tag === "div" && textOf(n).startsWith("ログイン中") && !textOf(n).includes("ログアウト")));
    expect(rows.map((r) => textOf(r).replace(/qa@example\.com/, "").replace(/›$/, ""))).toEqual(["ログイン中", "ログアウト", "プライバシーポリシー", "アカウントの削除"]);
    expect(rows.at(-1)!.attrs.href).toBe("/app/settings/delete");
    expect(findAll(root, (n) => n.tag === "form").length).toBe(1);
  });
});
