import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeDb } from "./fake-db";
import { mount } from "./hook-harness";
import { findAll, parseHtml, textOf } from "./html-tree";

/**
 * [Review 2026-11-06] With only Gmail's forwarding confirmation in, the empty list's 「設定で承認する」
 * goes to the approval in 設定 › メールの転送: /app/settings/forwarding#gmail-approval. That page first draws a loading screen,
 * where the section is not yet, so the router drops the scroll; the shared skeleton's
 * ScrollToHashOnReady scrolls to the section once the page has replaced the loading screen.
 * Followed here from the button the list draws to the scroll. Until the section carries
 * id="gmail-approval", the hash is ignored and 設定 opens at its top, as before.
 */

const USER = "00000000-0000-4000-8000-00000000000a";
const mocks = vi.hoisted(() => ({ state: { db: null as unknown } }));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { harnessHooks } = await import("./hook-harness");
  return harnessHooks(actual);
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

const { ScrollToHashOnReady } = await import("@/components/scroll-to-hash");
const { SkeletonScreen } = await import("@/components/skeleton");

beforeEach(() => {
  const db = new FakeDb({
    parcels: [],
    emails: [
      {
        id: "e-1",
        user_id: USER,
        provider_email_id: "re_1",
        message_id: "<confirm@google.com>",
        processing_status: "processed",
        classification: "forwarding_confirmation",
        from_address: "forwarding-noreply@google.com",
        from_domain: "google.com",
      },
    ],
    screen_events: [],
  });
  // The unread-mail notice's count: fake-db does not read and() inside or(); nothing is unread here.
  db.hooks.push((q) => (q.table === "emails" && q.filters.some((f) => f.method === "or") ? { data: null, error: null, count: 0 } : undefined));
  mocks.state.db = db;
});
afterEach(() => {
  vi.unstubAllGlobals();
});

/** Where the empty list's 「設定で承認する」 goes, as the list draws it. */
async function approvalLink(): Promise<URL> {
  const Page = (await import("@/app/app/page")).default;
  const root = parseHtml(renderToStaticMarkup(await Page()));
  const buttons = findAll(root, (n) => n.tag === "a" && textOf(n).trim() === "設定で承認する");
  expect(buttons).toHaveLength(1);
  return new URL(buttons[0].attrs.href, "https://otodoke.example");
}

/** Whether a loading screen is the shared skeleton, with ScrollToHashOnReady in it. */
function scrollsOnceIn(Loading: () => ReactNode): boolean {
  const screen = Loading() as ReactElement<{ children: ReactNode; className?: string }>;
  if (!isValidElement(screen) || screen.type !== SkeletonScreen) return false;
  const drawn = SkeletonScreen(screen.props) as ReactElement<{ children: ReactNode }>;
  return Children.toArray(drawn.props.children).filter((c) => isValidElement(c) && c.type === ScrollToHashOnReady).length === 1;
}

/** The page as the browser holds it: the URL's hash, and the elements by id. */
function browserAt(hash: string, ids: string[]) {
  const sections = Object.fromEntries(ids.map((id) => [id, { scrollIntoView: vi.fn() }]));
  vi.stubGlobal("window", { location: { hash } });
  vi.stubGlobal("document", { getElementById: vi.fn((id: string) => sections[id] ?? null) });
  return sections;
}

describe("the empty list's 「設定で承認する」 reaches the approval in 設定", () => {
  it("goes to 設定 with the approval's hash", async () => {
    const to = await approvalLink();
    expect(to.pathname).toBe("/app/settings/forwarding");
    expect(to.hash).toBe("#gmail-approval");
  });

  it("whichever loading screen stands in on the way (設定's own, or /app's), it scrolls once the page is in", async () => {
    expect(scrollsOnceIn((await import("@/app/app/settings/forwarding/loading")).default as () => ReactNode)).toBe(true);
    expect(scrollsOnceIn((await import("@/app/app/settings/(list)/loading")).default as () => ReactNode)).toBe(true);
    expect(scrollsOnceIn((await import("@/app/app/loading")).default as () => ReactNode)).toBe(true);
  });

  it("scrolls to the approval when the page replaces the loading screen, not before", async () => {
    const to = await approvalLink();
    const { "gmail-approval": approval, demo } = browserAt(to.hash, ["gmail-approval", "demo"]);
    const view = mount(() => ScrollToHashOnReady());
    expect(approval.scrollIntoView).not.toHaveBeenCalled();
    view.unmount();
    expect(approval.scrollIntoView).toHaveBeenCalledTimes(1);
    expect(demo.scrollIntoView).not.toHaveBeenCalled();
  });

  it("leaves 設定 at its top, with nothing thrown, while the section has no such id", async () => {
    const to = await approvalLink();
    const { demo } = browserAt(to.hash, ["demo"]);
    const view = mount(() => ScrollToHashOnReady());
    expect(() => view.unmount()).not.toThrow();
    expect(document.getElementById).toHaveBeenCalledWith("gmail-approval");
    expect(demo.scrollIntoView).not.toHaveBeenCalled();
  });
});
