import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeDb } from "./fake-db";
import { findAll, parseHtml, textOf, type HtmlNode } from "./html-tree";

/**
 * 設定 is a list of rows, each opening its own page (like an iOS settings screen): titles only,
 * the rows that need something done first, a failed read never shown as "nothing to do", and the
 * old fragment links (#demo, #gmail-approval) still reaching the page that holds the section.
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

const settingsDir = path.resolve(__dirname, "../../app/app/settings");
const source = (file: string) => readFileSync(path.join(settingsDir, file), "utf8");

const SUB_PAGES = ["forwarding", "password", "dropped", "mail-handling", "trouble", "demo", "delete"];

let db: FakeDb;
let unread = 0;
beforeEach(() => {
  unread = 0;
  db = new FakeDb();
  // The unread count's or(and(...)) filter is beyond the fake.
  db.hooks.push((q) => (q.table === "emails" && q.filters.some((f) => f.method === "or") ? { data: null, error: null, count: unread } : undefined));
  mocks.state.db = db;
});

const activeKey = () =>
  db.rows("user_keys").push({ user_id: USER, key_id: "a".repeat(32), public_key: "x", wrapped_private_key: "x", wrap_iv: "x", kdf_salt: "x", kdf_iterations: 600000, challenge_hash: "0".repeat(64), created_at: "2026-11-06T00:00:00Z", activated_at: "2026-11-06T00:00:00Z", retired_at: null });

const confirmation = () =>
  db.rows("emails").push({ id: "g", user_id: USER, classification: "forwarding_confirmation", processing_status: "processed", body_state: "plain", forwarding_confirm_url: "https://mail-settings.google.com/mail/vf-xyz", sent_at: "2026-11-06T00:00:00Z" });

async function render() {
  const Page = (await import("@/app/app/settings/(list)/page")).default;
  return parseHtml(renderToStaticMarkup(await Page()));
}

/** The rows of the mail card, in order: [href, title, badge]. */
const mailRows = (root: HtmlNode) => {
  const card = findAll(root, (n) => n.tag === "section")[0];
  return findAll(card, (n) => n.tag === "a").map((a) => {
    const spans = findAll(a, (s) => s.tag === "span" && s.attrs["aria-hidden"] !== "true");
    return [a.attrs.href, textOf(spans[0]), spans[1] ? textOf(spans[1]) : null];
  });
};

describe("設定 is a list of titles", () => {
  it("has no description text, and its rows open the six pages", async () => {
    activeKey();
    const root = await render();
    expect(findAll(root, (n) => n.tag === "p")).toEqual([]);
    expect(findAll(root, (n) => n.tag === "h1").map(textOf)).toEqual(["設定"]);
    expect(findAll(root, (n) => n.tag === "h2").map(textOf)).toEqual(["メール", "アカウント"]);
    expect(mailRows(root)).toEqual([
      ["/app/settings/forwarding", "メールの転送", null],
      ["/app/settings/password", "パスワードとメールの鍵", null],
      ["/app/settings/dropped", "読まなかったメール", "0"],
      ["/app/settings/mail-handling", "あなたのメールの扱い", null],
      ["/app/settings/trouble", "うまく届かないとき", null],
      ["/app/settings/demo", "サンプルで試す", null],
    ]);
    const account = findAll(root, (n) => n.tag === "section")[1];
    expect(findAll(account, (n) => n.tag === "a").map((a) => a.attrs.href)).toEqual(["/privacy", "/app/settings/delete"]);
  });

  it("puts the rows that need action first: password, unread, approval; the rest keep their order", async () => {
    unread = 3;
    confirmation();
    const rows = mailRows(await render());
    expect(rows.map((r) => r[1])).toEqual(["パスワードとメールの鍵", "うまく届かないとき", "メールの転送", "読まなかったメール", "あなたのメールの扱い", "サンプルで試す"]);
    expect(rows.slice(0, 3).map((r) => r[2])).toEqual(["未設定", "未読 3", "承認待ち"]);
  });

  it("a failed key read shows no 「未設定」, and a failed count shows no number", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    db.hooks.push((q) => (q.table === "user_keys" || q.table === "screen_events" ? { data: null, error: { message: "boom" }, count: null } : undefined));
    const rows = mailRows(await render());
    expect(rows.map((r) => r[1])).toEqual(["メールの転送", "パスワードとメールの鍵", "読まなかったメール", "あなたのメールの扱い", "うまく届かないとき", "サンプルで試す"]);
    expect(rows.map((r) => r[2])).toEqual([null, null, null, null, null, null]);
    log.mockRestore();
  });

  it("counts the dropped mails in the database and reads no rows", async () => {
    activeKey();
    for (let i = 0; i < 5; i++) db.rows("screen_events").push({ id: `s${i}`, user_id: USER, decision: "dropped", subject: "x", from_domain: "a.example", created_at: "2026-11-05T00:00:00Z", flagged_at: null });
    db.rows("screen_events").push({ id: "k", user_id: USER, decision: "kept" });
    expect(mailRows(await render())[2]).toEqual(["/app/settings/dropped", "読まなかったメール", "5"]);
    expect(db.callsOn("screen_events", "select").every((q) => q.head)).toBe(true);
    expect(source("(list)/page.tsx")).not.toContain("readAll");
  });
});

describe("every page of 設定 has its own loading screen and a way back", () => {
  it.each(SUB_PAGES)("/app/settings/%s: page.tsx, loading.tsx, 「‹ 設定」", (dir) => {
    expect(existsSync(path.join(settingsDir, dir, "page.tsx"))).toBe(true);
    expect(existsSync(path.join(settingsDir, dir, "loading.tsx")), dir).toBe(true);
    expect(source(`${dir}/page.tsx`)).toContain("<SubPage");
  });

  it("the back link goes to the list", async () => {
    const { SubPage } = await import("@/app/app/settings/sub-page");
    const root = parseHtml(renderToStaticMarkup(SubPage({ title: "題", children: null })));
    const links = findAll(root, (n) => n.tag === "a");
    expect(links.map((a) => [a.attrs.href, textOf(a)])).toEqual([["/app/settings", "‹ 設定"]]);
    expect(findAll(root, (n) => n.tag === "h1").map(textOf)).toEqual(["題"]);
  });
});

describe("the old fragment links still arrive", () => {
  it("moves #demo and #gmail-approval to the page that holds them, and nothing else", async () => {
    const { movedSection } = await import("@/app/app/settings/settings-hash-redirect");
    expect(movedSection("#demo")).toBe("/app/settings/demo");
    expect(movedSection("#gmail-approval")).toBe("/app/settings/forwarding#gmail-approval");
    for (const other of ["", "#", "#other", "#__proto__", "#/auth", "#demo2"]) expect(movedSection(other)).toBeNull();
  });

  it("is on the list page and replaces the URL (the back button does not come back to the list)", () => {
    expect(source("(list)/page.tsx")).toContain("<SettingsHashRedirect />");
    const code = source("settings-hash-redirect.tsx");
    expect(code).toMatch(/router\.replace\(to\)/);
    expect(code).toMatch(/window\.location\.hash/);
  });
});

describe("the Server Actions land on the page that shows the answer", () => {
  it("errors go to the page of their action", async () => {
    const { settingsErrorPath } = await import("@/lib/settings-errors");
    expect(settingsErrorPath("demo_failed", "&demo=3")).toBe("/app/settings/demo?error=demo_failed&demo=3");
    expect(settingsErrorPath("clear_confirm")).toBe("/app/settings/demo?error=clear_confirm");
    expect(settingsErrorPath("clear_failed")).toBe("/app/settings/demo?error=clear_failed");
    expect(settingsErrorPath("read_failed")).toBe("/app/settings/trouble?error=read_failed");
    expect(settingsErrorPath("flag_failed")).toBe("/app/settings/dropped?error=flag_failed");
  });

  it("the actions redirect to the new URLs and revalidate the list and the page", () => {
    const actions = source("actions.ts");
    expect(actions).toContain('redirect("/app/settings/trouble")');
    expect(actions).toContain('redirect("/app/settings/demo?cleared=1")');
    expect(actions).toContain("redirect(`/app/settings/dropped?flagged=${outcome}`)");
    expect(actions).toContain("redirect(`/app/settings/dropped?unflagged=");
    expect(actions).not.toMatch(/redirect\(["'`]\/app\/settings\?/);
    expect(actions).not.toContain('redirect("/app/settings")');
    expect(actions.match(/revalidatePath\("\/app\/settings\/dropped"\)/g)).toHaveLength(2);
    expect(actions.match(/revalidatePath\("\/app\/settings"\)/g)).toHaveLength(2);
  });
});

describe("the trouble page", () => {
  const render = async (unreadCount: number | "fail") => {
    if (unreadCount === "fail") db.hooks.unshift((q) => (q.table === "emails" ? { data: null, error: { message: "boom" }, count: null } : undefined));
    else unread = unreadCount;
    const Page = (await import("@/app/app/settings/trouble/page")).default;
    return parseHtml(renderToStaticMarkup(await Page({ searchParams: Promise.resolve({}) })));
  };

  it("offers 「読み取る」 when mail is unread, and says there is none otherwise", async () => {
    const some = await render(2);
    expect(textOf(some)).toContain("未読のメールが 2 通あります");
    expect(findAll(some, (n) => n.tag === "button").map(textOf)).toEqual(["読み取る"]);
    const none = await render(0);
    expect(textOf(none)).toContain("未読のメールはありません。");
    expect(findAll(none, (n) => n.tag === "button")).toEqual([]);
  });

  it("links to 読まなかったメール and メールの転送", async () => {
    const root = await render(0);
    expect(findAll(root, (n) => n.tag === "a").map((a) => [a.attrs.href, textOf(a).replace(/›$/, "")])).toContainEqual(["/app/settings/dropped", "読まなかったメール"]);
    expect(findAll(root, (n) => n.tag === "a").map((a) => a.attrs.href)).toContain("/app/settings/forwarding");
  });

  it("shows every pitfall of the shared words as a fold, between the unread card and the link rows", async () => {
    const { FORWARDING_PITFALLS, PITFALLS_HEADING, PITFALLS_LEAD } = await import("@/lib/forwarding-guide");
    const root = await render(0);
    const text = textOf(root).replace(/\s+/g, " ");
    expect(text).toContain(PITFALLS_HEADING);
    expect(text).toContain(PITFALLS_LEAD);
    const folds = findAll(root, (n) => n.tag === "details");
    expect(folds).toHaveLength(FORWARDING_PITFALLS.length);
    for (const p of FORWARDING_PITFALLS) expect(findAll(root, (n) => n.tag === "summary").map((n) => textOf(n).trim())).toContain(p.title);
    expect(text.indexOf("未読のメールはありません。")).toBeLessThan(text.indexOf(PITFALLS_HEADING));
    expect(text.indexOf(PITFALLS_HEADING)).toBeLessThan(text.indexOf("読まなかったメール"));
    for (const a of findAll(root, (n) => n.tag === "a" && /^https?:/.test(n.attrs.href ?? ""))) {
      expect(a.attrs.target).toBe("_blank");
      expect(a.attrs.rel).toContain("noopener");
    }
  });

  it("a failed count says 「読み込めませんでした」, never 「未読のメールはありません。」", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const root = await render("fail");
    expect(textOf(root)).toContain("読み込めませんでした");
    expect(textOf(root)).not.toContain("未読のメールはありません。");
    log.mockRestore();
  });
});

describe("the forwarding page's guides", () => {
  it("renders every guide of the shared words as a fold, and links to the full guide", async () => {
    activeKey();
    const { FORWARDING_GUIDES, GMAIL_FILTER } = await import("@/lib/forwarding-guide");
    const Page = (await import("@/app/app/settings/forwarding/page")).default;
    const root = parseHtml(renderToStaticMarkup(await Page()));
    const titles = findAll(root, (n) => n.tag === "summary").map((n) => textOf(n).trim());
    expect(titles).toEqual(FORWARDING_GUIDES.map((g) => g.title));
    const text = textOf(root).replace(/\s+/g, " ");
    for (const g of FORWARDING_GUIDES) for (const s of g.groups.flatMap((x) => x.steps)) expect(text, s.text).toContain(s.text);
    expect(text).toContain(GMAIL_FILTER);
    expect(text).toContain("自動転送の設定は最初の 1 回だけ");
    expect(text).toContain("店ごとの設定はいりません。新しい店で買っても、そのまま読み取ります。");
    expect(findAll(root, (n) => n.tag === "a" && textOf(n).trim() === "くわしい手順を見る").map((a) => a.attrs.href)).toEqual(["/guide/forwarding"]);
  });
});

describe("the Gmail filter words", () => {
  it("are written once, in src/lib/forwarding-guide.ts", () => {
    const root = path.resolve(__dirname, "../..");
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (/\.(ts|tsx)$/.test(e.name) && !full.includes("__tests__") && readFileSync(full, "utf8").includes("{注文 発送 出荷")) hits.push(path.relative(root, full));
      }
    };
    walk(root);
    expect(hits).toEqual(["lib/forwarding-guide.ts"]);
  });
});
