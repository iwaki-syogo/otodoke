import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeDb } from "./fake-db";
import { findAll, parseHtml, textOf, type HtmlNode } from "./html-tree";

/**
 * Review fixes for the 設定 split:
 * - B-M1: the approval card is shown whenever a confirmation exists; the list's 「承認待ち」 clears once other mail arrives AFTER it.
 * - B-M2: the key row shows 「未暗号化 N 通」 and goes first.
 * - L3: the "could not read" boxes say what could not be read.
 * - L5: one heading for 「あなたのメールの扱い」. L8: a failed read leaves a marker. L9: 削除 shows the address.
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
vi.mock("@/lib/inbox", () => ({ ensureInboxAddress: async () => "abcdefghjk", inboxEmail: () => "abcdefghjk@in.example.test" }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => Object.assign(mocks.state.db as FakeDb, { auth: { getUser: async () => ({ data: { user: { id: USER } }, error: null }) } }),
  getUser: async () => ({ id: USER, email: "qa@example.com" }),
}));
vi.mock("@/app/app/settings/actions", () => ({ loadDemo: vi.fn(), readWaitingMail: vi.fn(), markWronglyDropped: vi.fn(), forgetSender: vi.fn(), clearAllParcels: vi.fn() }));
vi.mock("@/app/app/settings/key-actions", () => ({ readMailKey: vi.fn(), registerMailKey: vi.fn(), activateMailKey: vi.fn(), rewrapMailKey: vi.fn(), sealStoredMail: vi.fn(), readSealedMail: vi.fn() }));
vi.mock("@/app/app/settings/password-actions", () => ({ changeLoginSecret: vi.fn() }));
vi.mock("@/app/app/settings/account-actions", () => ({ deleteAccount: vi.fn() }));
vi.mock("@/app/login/actions", () => ({ signInWithAuthSecret: vi.fn() }));
vi.mock("@/app/login/session-actions", () => ({ readSignedInAddress: vi.fn() }));
vi.mock("@/app/login/turnstile-widget", () => ({ TurnstileWidget: () => null }));
vi.mock("@/app/login/other-password-form", () => ({ OtherPasswordForm: () => null }));

let db: FakeDb;
let unread = 0;
beforeEach(() => {
  unread = 0;
  db = new FakeDb();
  db.hooks.push((q) => (q.table === "emails" && q.filters.some((f) => f.method === "or") ? { data: null, error: null, count: unread } : undefined));
  mocks.state.db = db;
});

const FAIL = { data: null, error: { message: "boom" }, count: null };
const activeKey = () =>
  db.rows("user_keys").push({ user_id: USER, key_id: "a".repeat(32), public_key: "x", wrapped_private_key: "x", wrap_iv: "x", kdf_salt: "x", kdf_iterations: 600000, challenge_hash: "0".repeat(64), created_at: "2026-11-06T00:00:00Z", activated_at: "2026-11-06T00:00:00Z", retired_at: null });
const confirmation = (day = 6) =>
  db.rows("emails").push({ id: `g${day}`, user_id: USER, classification: "forwarding_confirmation", processing_status: "processed", body_state: "plain", forwarding_confirm_url: "https://mail-settings.google.com/mail/vf-xyz", sent_at: `2026-11-0${day}T00:00:00Z`, created_at: `2026-11-0${day}T00:00:00Z`, provider_email_id: "re_conf" });
const ordinaryMail = (over: Record<string, unknown> = {}) =>
  db.rows("emails").push({ id: `m-${Math.random()}`, user_id: USER, classification: "order", processing_status: "processed", body_state: "sealed", provider_email_id: "re_123", ...over });


const list = async () => parseHtml(renderToStaticMarkup(await (await import("@/app/app/settings/(list)/page")).default()));
const forwarding = async () => parseHtml(renderToStaticMarkup(await (await import("@/app/app/settings/forwarding/page")).default()));
const welcome = async () => parseHtml(renderToStaticMarkup(await (await import("@/app/app/welcome/page")).default()));
const password = async () => parseHtml(renderToStaticMarkup(await (await import("@/app/app/settings/password/page")).default()));
const trouble = async () => parseHtml(renderToStaticMarkup(await (await import("@/app/app/settings/trouble/page")).default({ searchParams: Promise.resolve({}) })));

/** The rows of the mail card: [title, badge]. */
const mailRows = (root: HtmlNode) => {
  const card = findAll(root, (n) => n.tag === "section")[0];
  return findAll(card, (n) => n.tag === "a").map((a) => {
    const spans = findAll(a, (s) => s.tag === "span" && s.attrs["aria-hidden"] !== "true");
    return [textOf(spans[0]), spans[1] ? textOf(spans[1]) : null] as [string, string | null];
  });
};
const badgeOf = (root: HtmlNode, title: string) => mailRows(root).find((r) => r[0] === title)?.[1];
const APPROVAL_CARD = "Gmail の転送を承認してください";

describe("[B-M1] the approval card is shown whenever Gmail's confirmation exists; only the list badge goes by time", () => {
  const T = (day: number) => `2026-11-0${day}T00:00:00Z`;
  const screenEvent = (day: number) => db.rows("screen_events").push({ id: `s${day}`, user_id: USER, decision: "dropped", created_at: T(day) });
  const hasCard = async () => [await forwarding(), await welcome()].map((r) => textOf(r).includes(APPROVAL_CARD));
  const badge = async () => badgeOf(await list(), "メールの転送");

  it("positive control: only Gmail's confirmation -> 承認待ち on the list, the card on both pages", async () => {
    confirmation(6);
    expect(await badge()).toBe("承認待ち");
    expect(await hasCard()).toEqual([true, true]);
  });

  it("the card keeps its sentence about an approval already done", async () => {
    confirmation(6);
    expect(textOf(await forwarding())).toContain("承認済みなら、この案内は無視して大丈夫です。");
    expect(textOf(await welcome())).toContain("承認済みなら、この案内は無視して大丈夫です。");
  });

  it("a mail BEFORE the confirmation (forwarded by hand): badge and card", async () => {
    ordinaryMail({ created_at: T(5), sent_at: T(5) });
    confirmation(6);
    expect(await badge()).toBe("承認待ち");
    expect(await hasCard()).toEqual([true, true]);
  });

  it("a second confirmation after an earlier mail (two Gmail accounts): badge and card", async () => {
    confirmation(5);
    ordinaryMail({ created_at: T(6), sent_at: T(6) });
    db.rows("emails").push({ id: "g2", user_id: USER, classification: "forwarding_confirmation", processing_status: "processed", body_state: "plain", forwarding_confirm_url: "https://mail-settings.google.com/mail/vf-second", sent_at: T(7), created_at: T(7), provider_email_id: "re_conf2" });
    expect(await badge()).toBe("承認待ち");
    expect(await hasCard()).toEqual([true, true]);
  });

  it("a screen_events row BEFORE the confirmation: badge and card", async () => {
    screenEvent(5);
    confirmation(6);
    expect(await badge()).toBe("承認待ち");
    expect(await hasCard()).toEqual([true, true]);
  });

  it.each([
    ["an ordinary mail", () => ordinaryMail({ created_at: T(7), sent_at: T(7) })],
    ["a mail the screen dropped", () => screenEvent(7)],
  ])("%s AFTER the confirmation: no badge, but the card stays on both pages", async (_what, arrive) => {
    confirmation(6);
    arrive();
    expect(await badge()).toBeNull();
    expect(await hasCard()).toEqual([true, true]);
  });

  it("a public sample or another confirmation after it does not clear the badge", async () => {
    confirmation(6);
    ordinaryMail({ provider_email_id: "demo:1", created_at: T(7) });
    expect(await badge()).toBe("承認待ち");
  });

  it("a failed supporting read: the card stays, the list says 確認できません (never 承認待ち, never blank)", async () => {
    confirmation(6);
    ordinaryMail({ created_at: T(5) });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    db.hooks.unshift((q) => (q.table === "screen_events" && q.head ? FAIL : undefined));
    expect(await badge()).toBe("確認できません");
    expect(await hasCard()).toEqual([true, true]);
    log.mockRestore();
  });
});

describe("[B-M2] the key row shows the mail not encrypted yet, and goes first", () => {
  const plain = (n: number) => {
    for (let i = 0; i < n; i++) ordinaryMail({ body_state: "plain" });
  };

  it("with a key and plaintext mail: 「未暗号化 N 通」 on the key row, which is first even before 未読", async () => {
    activeKey();
    plain(2);
    unread = 3;
    const rows = mailRows(await list());
    expect(rows[0]).toEqual(["パスワードとメールの鍵", "未暗号化 2 通"]);
    expect(rows[1]).toEqual(["うまく届かないとき", "未読 3"]);
  });

  it("negative controls: no plaintext mail, or only the public samples, shows no badge", async () => {
    activeKey();
    expect(badgeOf(await list(), "パスワードとメールの鍵")).toBeNull();
    ordinaryMail({ body_state: "plain", provider_email_id: "demo:1" });
    expect(badgeOf(await list(), "パスワードとメールの鍵")).toBeNull();
  });

  it("without a key the badge stays 未設定", async () => {
    plain(2);
    expect(badgeOf(await list(), "パスワードとメールの鍵")).toBe("未設定");
  });

  it("a failed count shows no number, only the marker", async () => {
    activeKey();
    plain(2);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    db.hooks.unshift((q) => (q.table === "emails" && q.head && q.filters.some((f) => f.args[0] === "body_state") ? FAIL : undefined));
    const badge = badgeOf(await list(), "パスワードとメールの鍵");
    expect(badge).toBe("確認できません");
    expect(badge).not.toMatch(/\d/);
    log.mockRestore();
  });
});

describe("[L8] a row whose read failed is marked, never blank", () => {
  const fail = (match: (q: { table: string; head: boolean; filters: Array<{ method: string; args: unknown[] }> }) => boolean) => db.hooks.unshift((q) => (match(q) ? FAIL : undefined));

  it.each([
    ["the key", "パスワードとメールの鍵", (q: { table: string }) => q.table === "user_keys"],
    ["the dropped count", "読まなかったメール", (q: { table: string }) => q.table === "screen_events"],
    ["the unread count", "うまく届かないとき", (q: { table: string; filters: Array<{ method: string }> }) => q.table === "emails" && q.filters.some((f) => f.method === "or")],
    ["the confirmation", "メールの転送", (q: { table: string; filters: Array<{ method: string; args: unknown[] }> }) => q.table === "emails" && q.filters.some((f) => f.args[1] === "forwarding_confirmation") && !q.filters.some((f) => f.method === "like")],
  ])("%s", async (_what, title, match) => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    fail(match as never);
    expect(badgeOf(await list(), title)).toBe("確認できません");
    log.mockRestore();
  });

  it("negative control: with every read fine, no row carries the marker", async () => {
    activeKey();
    expect(mailRows(await list()).filter((r) => r[1] === "確認できません")).toEqual([]);
  });
});

describe("[L3] the could-not-read boxes say what could not be read", () => {
  const boxes = (root: HtmlNode) => findAll(root, (n) => n.tag === "p" && /読み込めませんでした/.test(textOf(n))).map((p) => textOf(p));

  it("trouble: the unread count", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    db.hooks.unshift((q) => (q.table === "emails" ? FAIL : undefined));
    expect(boxes(await trouble())).toEqual(["未読のメールの数を読み込めませんでした"]);
    log.mockRestore();
  });

  it("password: the key", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    db.hooks.unshift((q) => (q.table === "user_keys" ? FAIL : undefined));
    expect(boxes(await password())).toEqual(["メールの鍵を読み込めませんでした"]);
    log.mockRestore();
  });

  it("forwarding: Gmail's approval", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    activeKey();
    db.hooks.unshift((q) => (q.table === "emails" && q.filters.some((f) => f.args[1] === "forwarding_confirmation") ? FAIL : undefined));
    expect(boxes(await forwarding())).toEqual(["Gmail の承認の案内を読み込めませんでした"]);
    log.mockRestore();
  });
});

describe("[L5] 「あなたのメールの扱い」 has one heading", () => {
  it("the page has the h1 and no h2 of the same words; the component keeps its h2 by default", async () => {
    const root = parseHtml(renderToStaticMarkup((await import("@/app/app/settings/mail-handling/page")).default()));
    expect(findAll(root, (n) => n.tag === "h1").map(textOf)).toEqual(["あなたのメールの扱い"]);
    expect(findAll(root, (n) => n.tag === "h2")).toEqual([]);
    const { MailHandling } = await import("@/app/app/settings/mail-handling");
    const alone = parseHtml(renderToStaticMarkup(MailHandling({})));
    expect(findAll(alone, (n) => n.tag === "h2").map(textOf)).toEqual(["あなたのメールの扱い"]);
  });
});

describe("[L9] 設定 › アカウントの削除 shows who is signed in", () => {
  it("with the shared LoggedInAs", async () => {
    const root = parseHtml(renderToStaticMarkup(await (await import("@/app/app/settings/delete/page")).default()));
    expect(textOf(root)).toContain("ログイン中: qa@example.com");
  });
});
