import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeDb } from "./fake-db";
import { ancestorsOf, classesOf, findAll, linksTo, parseHtml, textOf, type HtmlNode } from "./html-tree";

/**
 * Where the privacy policy (/privacy) is linked from: the top page's footer next to GitHub, 設定
 * right under 「あなたのメールの扱い」 (not inside 「アカウントを削除」), and the page after an
 * account is deleted. One small link each, worded 「プライバシーポリシー」. The login page gets its
 * own link from the login fix.
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
// next/font only works inside the Next.js compiler.
vi.mock("@/components/wordmark", () => ({ Wordmark: () => "Otodoke" }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => Object.assign(mocks.state.db as FakeDb, { auth: { getUser: async () => ({ data: { user: { id: USER } }, error: null }) } }),
  getUser: async () => ({ id: USER, email: "qa@example.com" }),
}));
vi.mock("@/lib/inbox", () => ({ ensureInboxAddress: async () => "abcdefghjk", inboxEmail: () => "abcdefghjk@in.example.test" }));
vi.mock("@/app/app/settings/actions", () => ({ loadDemo: vi.fn(), readWaitingMail: vi.fn(), markWronglyDropped: vi.fn(), forgetSender: vi.fn(), clearAllParcels: vi.fn() }));
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

/** The one link to the policy on a page: worded 「プライバシーポリシー」, and small. */
function policyLink(root: HtmlNode): HtmlNode {
  const links = linksTo(root, "/privacy");
  expect(links.map(textOf)).toEqual(["プライバシーポリシー"]);
  const link = links[0];
  expect([link, ...ancestorsOf(link)].some((n) => classesOf(n).includes("text-xs")), "small text").toBe(true);
  return link;
}

/** The element siblings of `node`, in order. */
function elementSiblings(node: HtmlNode): HtmlNode[] {
  return node.parent!.children.filter((c): c is HtmlNode => typeof c !== "string");
}

describe("links to /privacy", () => {
  it("the top page: in the footer, next to GitHub", async () => {
    const Home = (await import("@/app/page")).default;
    const root = parseHtml(renderToStaticMarkup(await Home()));
    const link = policyLink(root);
    const footer = ancestorsOf(link).find((n) => n.tag === "footer");
    expect(footer).toBeDefined();
    expect(elementSiblings(link).filter((n) => n.tag === "a").map((a) => a.attrs.href)).toEqual(["https://github.com/iwaki-syogo/otodoke", "/privacy"]);
  });

  it("設定 › あなたのメールの扱い: right under 「あなたのメールの扱い」, outside every section", async () => {
    const Page = (await import("@/app/app/settings/mail-handling/page")).default;
    const root = parseHtml(renderToStaticMarkup(Page()));
    const link = policyLink(root);
    expect(ancestorsOf(link).some((n) => n.tag === "section")).toBe(false);
    const holder = link.parent!;
    const siblings = elementSiblings(holder);
    const before = siblings[siblings.indexOf(holder) - 1];
    expect(before.tag).toBe("section");
    expect(findAll(before, (n) => n.tag === "h2").map(textOf)).toEqual(["あなたのメールの扱い"]);
  });

  it("the page after deleting the account: below the way to the login page", async () => {
    const AccountDeletedPage = (await import("@/app/account-deleted/page")).default;
    const root = parseHtml(renderToStaticMarkup(AccountDeletedPage()));
    const link = policyLink(root);
    const order = elementSiblings(link).filter((n) => n.tag === "a").map((a) => a.attrs.href);
    expect(order.slice(-2)).toEqual(["/login", "/privacy"]);
  });
});
