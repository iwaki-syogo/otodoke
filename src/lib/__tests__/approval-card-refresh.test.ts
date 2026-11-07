import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GMAIL_FILTER } from "@/lib/forwarding-guide";
import { FakeDb } from "./fake-db";
import { findAll, parseHtml, textOf } from "./html-tree";

/**
 * The yellow Gmail approval card (settings and welcome) carries the filter text to copy, and the
 * page draws RefreshUntilApproval only while the link has not come and reading it did not fail.
 */

const USER = "00000000-0000-4000-8000-00000000000a";
const CONFIRM_URL = "https://mail-settings.google.com/mail/vf-xyz";

const mocks = vi.hoisted(() => ({ state: { db: null as unknown } }));

vi.mock("next/navigation", () => ({ redirect: vi.fn(), notFound: vi.fn(), useRouter: () => ({ refresh: vi.fn() }), usePathname: () => "/app/welcome" }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => Object.assign(mocks.state.db as FakeDb, { auth: { getUser: async () => ({ data: { user: { id: USER } }, error: null }) } }),
  getUser: async () => ({ id: USER, email: "qa@example.com" }),
}));
vi.mock("@/lib/inbox", () => ({ ensureInboxAddress: async () => "abcdefghjk", inboxEmail: () => "abcdefghjk@in.example.test" }));
// A probe in place of the invisible component, so the page's choice to draw it can be seen.
vi.mock("@/components/refresh-until-approval", async () => {
  const { createElement } = await import("react");
  return { RefreshUntilApproval: () => createElement("i", { "data-probe": "refresh" }) };
});

let db: FakeDb;
beforeEach(() => {
  db = new FakeDb();
  mocks.state.db = db;
});

const confirmationCame = () =>
  db.rows("emails").push({ id: "g", user_id: USER, classification: "forwarding_confirmation", processing_status: "processed", body_state: "plain", forwarding_confirm_url: CONFIRM_URL, sent_at: "2026-11-06T00:00:00Z" });
const readFails = () => db.hooks.push((q) => (q.table === "emails" ? { data: null, error: { message: "boom" } } : undefined));

const PAGES = [
  ["welcome", () => import("@/app/app/welcome/page")],
  ["settings forwarding", () => import("@/app/app/settings/forwarding/page")],
] as const;

describe.each(PAGES)("%s", (_name, load) => {
  const draw = async () => parseHtml(renderToStaticMarkup(await (await load()).default()));
  const probes = (root: Awaited<ReturnType<typeof draw>>) => findAll(root, (n) => n.attrs["data-probe"] === "refresh");

  it("the approval card has the sentence and the filter text with a copy button; no refresh", async () => {
    confirmationCame();
    const root = await draw();
    const [card] = findAll(root, (n) => n.attrs.id === "gmail-approval");
    expect(textOf(card)).toContain("承認したら、フィルタの「含む」に貼るこの文字列をコピーして Gmail に戻ります。");
    expect(findAll(card, (n) => n.tag === "code").map(textOf)).toEqual([GMAIL_FILTER]);
    expect(findAll(card, (n) => n.tag === "button").map(textOf)).toEqual(["コピー"]);
    expect(probes(root)).toHaveLength(0);
  });

  it("without the link the refresh is drawn and there is no card", async () => {
    const root = await draw();
    expect(findAll(root, (n) => n.attrs.id === "gmail-approval")).toHaveLength(0);
    expect(probes(root)).toHaveLength(1);
  });

  it("when reading the link failed the refresh is not drawn", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    readFails();
    const root = await draw();
    expect(textOf(root)).toContain("Gmail の承認の案内を読み込めませんでした");
    expect(probes(root)).toHaveLength(0);
  });
});
