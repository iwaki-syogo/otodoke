import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GMAIL_FILTER } from "@/lib/forwarding-guide";
import { FakeDb } from "./fake-db";
import { findAll, parseHtml, textOf } from "./html-tree";

/**
 * The yellow Gmail approval card (settings and welcome) carries the filter text to copy, and the
 * page draws RefreshUntilApproval while the link has not come (also when reading it failed) and the address is shown.
 */

const USER = "00000000-0000-4000-8000-00000000000a";
const CONFIRM_URL = "https://mail-settings.google.com/mail/vf-xyz";

const mocks = vi.hoisted(() => ({ state: { db: null as unknown, noDomain: false } }));

vi.mock("next/navigation", () => ({ redirect: vi.fn(), notFound: vi.fn(), useRouter: () => ({ refresh: vi.fn() }), usePathname: () => "/app/welcome" }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => Object.assign(mocks.state.db as FakeDb, { auth: { getUser: async () => ({ data: { user: { id: USER } }, error: null }) } }),
  getUser: async () => ({ id: USER, email: "qa@example.com" }),
}));
vi.mock("@/lib/inbox", () => ({ ensureInboxAddress: async () => "abcdefghjk", inboxEmail: () => (mocks.state.noDomain ? "" : "abcdefghjk@in.example.test") }));
// A probe in place of the invisible component, so the page's choice to draw it can be seen.
vi.mock("@/components/refresh-until-approval", async () => {
  const { createElement } = await import("react");
  return { RefreshUntilApproval: () => createElement("i", { "data-probe": "refresh" }) };
});

let db: FakeDb;
beforeEach(() => {
  db = new FakeDb();
  mocks.state.db = db;
  mocks.state.noDomain = false;
  db.rows("user_keys").push({ user_id: USER, key_id: "a".repeat(32), public_key: "x", wrapped_private_key: "x", wrap_iv: "x", kdf_salt: "x", kdf_iterations: 600000, challenge_hash: "0".repeat(64), created_at: "2026-11-06T00:00:00Z", activated_at: "2026-11-06T00:00:00Z", retired_at: null });
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
    expect(textOf(card)).toContain("フィルタを作るときは、この文字列をコピーして「含む」に貼ります。");
    expect(findAll(card, (n) => n.tag === "code").map(textOf)).toEqual([GMAIL_FILTER]);
    expect(findAll(card, (n) => n.tag === "button").map(textOf)).toEqual(["コピー"]);
    expect(probes(root)).toHaveLength(0);
  });

  it("without the link the refresh is drawn and there is no card", async () => {
    const root = await draw();
    expect(findAll(root, (n) => n.attrs.id === "gmail-approval")).toHaveLength(0);
    expect(probes(root)).toHaveLength(1);
  });

  it("when reading the link failed the red notice and the refresh are both drawn", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    readFails();
    const root = await draw();
    expect(textOf(root)).toContain("Gmail の承認の案内を読み込めませんでした");
    expect(probes(root)).toHaveLength(1);
  });

  it("when reading the link failed and there is no key, the red notice is drawn and the refresh is not", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    db.rows("user_keys").length = 0;
    readFails();
    const root = await draw();
    expect(textOf(root)).toContain("Gmail の承認の案内を読み込めませんでした");
    expect(probes(root)).toHaveLength(0);
  });

  it("the refresh is drawn only when the address is shown: not without a key, a receiving domain, or when the key read failed", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(probes(await draw())).toHaveLength(1);
    db.rows("user_keys").length = 0;
    expect(probes(await draw())).toHaveLength(0);
    db.rows("user_keys").push({ user_id: USER, key_id: "a".repeat(32), public_key: "x", wrapped_private_key: "x", wrap_iv: "x", kdf_salt: "x", kdf_iterations: 600000, challenge_hash: "0".repeat(64), created_at: "2026-11-06T00:00:00Z", activated_at: "2026-11-06T00:00:00Z", retired_at: null });
    mocks.state.noDomain = true;
    expect(probes(await draw())).toHaveLength(0);
    mocks.state.noDomain = false;
    db.hooks.push((q) => (q.table === "user_keys" ? { data: null, error: { message: "boom" } } : undefined));
    expect(probes(await draw())).toHaveLength(0);
  });
});
