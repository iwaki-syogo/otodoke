import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SETTINGS_ERROR_MESSAGES, UNKNOWN_SETTINGS_ERROR, settingsErrorMessage } from "@/lib/settings-errors";
import { FakeDb } from "./fake-db";
import { findAll, parseHtml, textOf } from "./html-tree";
import { appSourceFiles, read, withoutComments } from "./source-scan";

/**
 * /app/settings after the review of 2026-11-06:
 *  - ?error= is a code; a crafted link cannot put its own words on the page (review A-3 / D2-2,
 *    whose reproduction this turns around).
 *  - A failed key read is not worded as "no key yet" under 転送先アドレス (D2-12).
 *  - The public sample mails are not counted as mail the operator can read (F-9).
 *  - The signed-in address is shown next to the password panel (login-CSRF defence in depth).
 *  - The Gmail filter note does not promise that private mail never arrives (D2-4).
 */

const USER = "00000000-0000-4000-8000-00000000000a";
const ADDRESS = "abcdefghjk@in.example.test";

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
vi.mock("@/lib/inbox", () => ({ ensureInboxAddress: async () => "abcdefghjk", inboxEmail: () => ADDRESS }));
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
vi.mock("@/app/app/settings/password-actions", () => ({ changeLoginSecret: vi.fn() }));

let db: FakeDb;
beforeEach(() => {
  db = new FakeDb();
  // The unread count's or(and(...)) filter is beyond the fake; nothing here is unread.
  db.hooks.push((q) => (q.table === "emails" && q.filters.some((f) => f.method === "or") ? { data: null, error: null, count: 0 } : undefined));
  mocks.state.db = db;
});

/** The 設定 page that holds the part under test (each part has its own page now). */
const PAGES = {
  list: () => import("@/app/app/settings/(list)/page"),
  forwarding: () => import("@/app/app/settings/forwarding/page"),
  password: () => import("@/app/app/settings/password/page"),
  demo: () => import("@/app/app/settings/demo/page"),
  trouble: () => import("@/app/app/settings/trouble/page"),
} as const;

async function render(page: keyof typeof PAGES = "password", searchParams: Record<string, string> = {}) {
  const Page = (await PAGES[page]()).default as (props: { searchParams: Promise<Record<string, string>> }) => Promise<Parameters<typeof renderToStaticMarkup>[0]>;
  return parseHtml(renderToStaticMarkup(await Page({ searchParams: Promise.resolve(searchParams) })));
}

/** The demo page's one section (its title is the page's h1 now). */
const demoSection = (root: ReturnType<typeof parseHtml>) => findAll(root, (n) => n.tag === "section")[0];

const sectionTitled = (root: ReturnType<typeof parseHtml>, title: string) => findAll(root, (n) => n.tag === "section" && findAll(n, (h) => h.tag === "h2" && textOf(h) === title).length > 0);

// A message anybody can put in a link: long, and pointing somewhere else.
const CRAFTED = "【重要】パスワードの確認が必要です。24時間以内に example.invalid/otodoke で再設定しないと、保存したメールが消えます。".repeat(4);

describe("/app/settings?error= shows fixed words only", () => {
  it("a crafted text is not on the page; fixed words are shown instead", async () => {
    const root = await render("demo", { error: CRAFTED, demo: "<b>17</b>" });
    const all = textOf(root);
    expect(all).not.toContain("example.invalid");
    expect(all).not.toContain("<b>17</b>");
    expect(textOf(demoSection(root))).toContain(UNKNOWN_SETTINGS_ERROR);
  });

  it("a known code shows its words, and ?demo= only as a number", async () => {
    const root = await render("demo", { error: "demo_failed", demo: "12" });
    const text = textOf(demoSection(root));
    expect(text).toContain(SETTINGS_ERROR_MESSAGES.demo_failed);
    expect(text).toContain("12 通は読み込めました");
  });

  it("settingsErrorMessage: known codes, unknown text, nothing", () => {
    expect(settingsErrorMessage("clear_confirm")).toBe("「本当に消す」にチェックを入れてください");
    expect(settingsErrorMessage(CRAFTED)).toBe(UNKNOWN_SETTINGS_ERROR);
    expect(settingsErrorMessage("__proto__")).toBe(UNKNOWN_SETTINGS_ERROR);
    expect(settingsErrorMessage(undefined)).toBeNull();
  });

  it("the delete checkboxes say 「本当に消す」, the words the server asks for, and the warning stands outside them", () => {
    const asked = SETTINGS_ERROR_MESSAGES.clear_confirm.match(/「(.+)」/)![1];
    expect(asked).toBe("本当に消す");
    for (const file of ["src/app/app/settings/demo-loader.tsx", "src/app/app/parcels/manual-form.tsx"]) {
      const source = withoutComments(read(appSourceFiles().find((f) => f.endsWith(file))!));
      const label = source.match(/<label[^>]*>\s*<input type="checkbox" name="confirm"[^>]*\/>\s*([^<]*?)\s*<\/label>/);
      expect(label, file).not.toBeNull();
      expect(label![1], file).toBe(asked);
      expect(source, file).toContain(file.endsWith("demo-loader.tsx") ? "荷物と保存したメールを消します。消すと元に戻せません。" : "消すと元に戻せません。");
    }
  });

  it("the settings actions put only codes in ?error= (never a message)", () => {
    const source = withoutComments(read(appSourceFiles().find((f) => f.endsWith("src/app/app/settings/actions.ts"))!));
    expect(source).not.toMatch(/error=\$\{/);
    expect(source).not.toMatch(/encodeURIComponent/);
    // Negative control: the old form is caught by the same check.
    expect('redirect(`/app/settings?error=${encodeURIComponent(error.message)}`)').toMatch(/error=\$\{/);
  });
});

describe("/app/settings: a failed key read", () => {
  it("says the read failed under 転送先アドレス, not 「メールの鍵を作ると、ここに出ます」", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    db.hooks.push((q) => (q.table === "user_keys" ? { data: null, error: { message: "boom" } } : undefined));
    const root = await render("password");
    expect(textOf(sectionTitled(root, "パスワード")[0])).toContain("読み込めませんでした");
    const address = textOf(sectionTitled(await render("forwarding"), "転送先アドレス")[0]);
    expect(address).not.toContain("メールの鍵を作ると、ここに出ます");
    expect(address).toContain("読み込めなかった");
    expect(address).not.toContain(ADDRESS);
    log.mockRestore();
  });
});

describe("/app/settings: the sample mails are not counted as readable by the operator", () => {
  it("counts the user's own plaintext mail only", async () => {
    for (let i = 0; i < 3; i++) db.rows("emails").push({ id: `e${i}`, user_id: USER, provider_email_id: `re_${i}`, processing_status: "processed", body_state: "plain", subject: `件名${i}` });
    for (let i = 0; i < 17; i++) db.rows("emails").push({ id: `d${i}`, user_id: USER, provider_email_id: `demo:sample-${i}.eml`, message_id: `demo:sample-${i}.eml`, processing_status: "processed", body_state: "plain", subject: `サンプル${i}` });
    const root = await render("password");
    const text = textOf(sectionTitled(root, "メールの鍵を作る")[0]);
    expect(text).toContain("保存済みのメール 3 通も");
  });

  it("with only samples, there is no warning at all", async () => {
    for (let i = 0; i < 17; i++) db.rows("emails").push({ id: `d${i}`, user_id: USER, provider_email_id: `demo:sample-${i}.eml`, processing_status: "processed", body_state: "plain", subject: `サンプル${i}` });
    const root = await render("password");
    expect(textOf(sectionTitled(root, "メールの鍵を作る")[0])).not.toContain("運営者が読める形");
  });
});

describe("/app/settings: the signed-in address and the Gmail note", () => {
  it("shows which account is signed in as the 「ログイン中」 row of the list, without a standing note in brackets (R2-7)", async () => {
    const root = await render("list");
    // The row is no link: its title and the address, in one element.
    const rows = findAll(root, (n) => n.tag === "div" && textOf(n).startsWith("ログイン中") && textOf(n).includes("qa@example.com") && findAll(n, (a) => a.tag === "a").length === 0 && !textOf(n).includes("ログアウト"));
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(textOf(rows.at(-1)!).trim()).toBe("ログイン中qa@example.com");
    expect(textOf(root)).not.toContain("自分のアドレスでなければ");
  });

  it("does not promise that private mail never arrives", async () => {
    const all = textOf(await render("forwarding"));
    expect(all).not.toContain("私信は Otodoke に送られません");
    expect(all).toContain("これらの言葉を含む私信");
  });
});
