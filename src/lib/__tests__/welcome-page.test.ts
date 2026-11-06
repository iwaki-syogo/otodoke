import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FORWARDING_GUIDES } from "@/lib/forwarding-guide";
import { FakeDb } from "./fake-db";
import { classesOf, findAll, parseHtml, textOf, type HtmlNode } from "./html-tree";

/**
 * Onboarding screen 3, /app/welcome (src/app/app/welcome/page.tsx): the wording file's title and
 * body, 「1. 転送先アドレスをコピー」 with the address and the copy button,
 * 「2. お使いのメールで設定」 with the four guides of forwarding-guide.ts as cards that open, and
 * 「設定しました」 and 「あとで」 to the parcel list. Gmail's approval only when its confirmation came, and the case
 * without a key, are 設定 › メールの転送's, word for word and drawn the same.
 */

const USER = "00000000-0000-4000-8000-00000000000a";
const ADDRESS = "abcdefghjk@in.example.test";
const CONFIRM_URL = "https://mail-settings.google.com/mail/vf-xyz";

const mocks = vi.hoisted(() => ({ state: { db: null as unknown }, noDomain: false, ensure: vi.fn() }));

vi.mock("next/navigation", () => ({ redirect: vi.fn(), notFound: vi.fn(), useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }), usePathname: () => "/app/welcome" }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => Object.assign(mocks.state.db as FakeDb, { auth: { getUser: async () => ({ data: { user: { id: USER } }, error: null }) } }),
  getUser: async () => ({ id: USER, email: "qa@example.com" }),
}));
vi.mock("@/lib/inbox", () => ({ ensureInboxAddress: mocks.ensure, inboxEmail: () => (mocks.noDomain ? null : ADDRESS) }));

let db: FakeDb;
beforeEach(() => {
  mocks.noDomain = false;
  mocks.ensure.mockReset();
  mocks.ensure.mockResolvedValue("abcdefghjk");
  db = new FakeDb();
  mocks.state.db = db;
});

const activeKey = () =>
  db.rows("user_keys").push({ user_id: USER, key_id: "a".repeat(32), public_key: "x", wrapped_private_key: "x", wrap_iv: "x", kdf_salt: "x", kdf_iterations: 600000, challenge_hash: "0".repeat(64), created_at: "2026-11-06T00:00:00Z", activated_at: "2026-11-06T00:00:00Z", retired_at: null });
const confirmationCame = () =>
  db.rows("emails").push({ id: "g", user_id: USER, classification: "forwarding_confirmation", processing_status: "processed", body_state: "plain", forwarding_confirm_url: CONFIRM_URL, sent_at: "2026-11-06T00:00:00Z" });

async function welcome() {
  const Page = (await import("@/app/app/welcome/page")).default;
  return parseHtml(renderToStaticMarkup(await Page()));
}
async function forwarding() {
  const Page = (await import("@/app/app/settings/forwarding/page")).default;
  return parseHtml(renderToStaticMarkup(await Page()));
}

const sectionTitled = (root: HtmlNode, title: string) => findAll(root, (n) => n.tag === "section" && findAll(n, (h) => h.tag === "h2" && textOf(h) === title).length > 0);
/** A node as drawn: its tag, classes, link and text, and the same of its children. */
const drawnAs = (n: HtmlNode): unknown => ({ tag: n.tag, class: classesOf(n), href: n.attrs.href, text: textOf(n), children: n.children.filter((c): c is HtmlNode => typeof c !== "string").map(drawnAs) });
/** The paragraphs of a section, as drawn. */
const paragraphs = (section: HtmlNode) => findAll(section, (n) => n.tag === "p").map(drawnAs);

describe("/app/welcome", () => {
  it("has the wording file's words, the steps in order, and the four guides as cards that open", async () => {
    activeKey();
    const root = await welcome();
    expect(findAll(root, (n) => n.tag === "h1").map(textOf)).toEqual(["最後に、メールの自動転送を設定しますか？"]);
    expect(textOf(root)).toContain("設定は最初の 1 回だけです。");
    expect(findAll(root, (n) => n.tag === "h2").map(textOf)).toEqual(["1. 転送先アドレスをコピー", "2. お使いのメールで設定"]);

    const [copy] = sectionTitled(root, "1. 転送先アドレスをコピー");
    expect(findAll(copy, (n) => n.tag === "code").map(textOf)).toEqual([ADDRESS]);
    expect(findAll(copy, (n) => n.tag === "button").map(textOf)).toEqual(["コピー"]);
    expect(mocks.ensure).toHaveBeenCalledWith(expect.anything(), USER);

    const [setUp] = sectionTitled(root, "2. お使いのメールで設定");
    const cards = findAll(setUp, (n) => n.tag === "details");
    expect(cards.map((c) => textOf(findAll(c, (n) => n.tag === "summary")[0]))).toEqual(["Gmail", "iCloud メール", "Outlook", "そのほかのメール"]);
    expect(FORWARDING_GUIDES.map((g) => g.title)).toEqual(["Gmail", "iCloud メール", "Outlook", "そのほかのメール"]);
    // Inside, the existing steps (forwarding-guide.ts), with their links in a new tab.
    for (const [i, guide] of FORWARDING_GUIDES.entries()) {
      for (const step of guide.groups.flatMap((g) => g.steps)) expect(textOf(cards[i])).toContain(step.text);
      if (guide.link) expect(findAll(cards[i], (n) => n.tag === "a" && n.attrs.href === guide.link!.href && n.attrs.target === "_blank")).toHaveLength(1);
    }
  });

  it("「設定しました」 (black, the main one) and 「あとで」 (white) both go to the parcel list", async () => {
    activeKey();
    const root = await welcome();
    const buttons = findAll(root, (n) => n.tag === "a" && n.attrs.href === "/app");
    expect(buttons.map(textOf)).toEqual(["設定しました", "あとで"]);
    expect(classesOf(buttons[0])).toEqual(expect.arrayContaining(["w-full", "bg-neutral-900", "text-white", "rounded-xl", "py-4"]));
    expect(classesOf(buttons[1])).toEqual(expect.arrayContaining(["w-full", "bg-white", "border-neutral-300", "rounded-xl", "py-4"]));
  });

  it("no standing note of its own, nothing of 「転送するだけ」, and no shadow or gradient", async () => {
    activeKey();
    const html = renderToStaticMarkup(await (await import("@/app/app/welcome/page")).default());
    const text = textOf(parseHtml(html));
    for (const note of ["あなた専用のアドレスです", "注文・発送のメールをこのアドレスに転送してください", "くわしい手順を見る", "店ごとの設定はいりません", "転送するだけ"]) expect(text).not.toContain(note);
    expect(html).not.toMatch(/shadow|gradient/);
  });

  it("Gmail's approval only once its confirmation came: above step 1, as 設定 › メールの転送 draws it", async () => {
    activeKey();
    expect(textOf(await welcome())).not.toContain("Gmail の転送を承認してください");

    confirmationCame();
    const root = await welcome();
    const [card] = findAll(root, (n) => n.attrs.id === "gmail-approval");
    expect(findAll(card, (n) => n.tag === "a" && n.attrs.href === CONFIRM_URL).map(textOf)).toEqual(["承認ページを開く"]);
    const html = renderToStaticMarkup(await (await import("@/app/app/welcome/page")).default());
    expect(html.indexOf("Gmail の転送を承認してください")).toBeLessThan(html.indexOf("1. 転送先アドレスをコピー"));
    const [theirs] = findAll(await forwarding(), (n) => n.attrs.id === "gmail-approval");
    // The same words and look; only the space above it is the welcome page's own.
    expect(drawnAs(card)).toEqual({ ...(drawnAs(theirs) as object), class: ["mt-6", ...classesOf(theirs)] });
  });

  it.each([
    ["no key yet", () => {}, "メールの鍵を作ると、ここに出ます。サンプルは鍵なしで試せます。"],
    ["the key could not be read", () => db.hooks.push((q) => (q.table === "user_keys" ? { data: null, error: { message: "boom" } } : undefined)), "メールの鍵を読み込めなかったので、アドレスを出せませんでした。ページを読み込み直してください。"],
    ["no inbound domain", () => {
      activeKey();
      mocks.noDomain = true;
    }, "受信ドメインがまだ設定されていません。"],
  ] as const)("without the address (%s): 設定 › メールの転送's sentence, drawn the same, and no address", async (_what, arrange, sentence) => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    arrange();
    const [mine] = sectionTitled(await welcome(), "1. 転送先アドレスをコピー");
    const [theirs] = sectionTitled(await forwarding(), "転送先アドレス");
    expect(textOf(mine)).toContain(sentence);
    expect(textOf(mine)).not.toContain(ADDRESS);
    // Every paragraph the step shows is one the forwarding page shows, with the same look.
    const theirParagraphs = paragraphs(theirs);
    for (const p of paragraphs(mine)) expect(theirParagraphs).toContainEqual(p);
    expect(paragraphs(mine).length).toBeGreaterThan(0);
    log.mockRestore();
  });

  it("negative control: the comparison sees a sentence the forwarding page does not have", async () => {
    const [theirs] = sectionTitled(await forwarding(), "転送先アドレス");
    const planted = parseHtml('<section><p class="mt-1 text-sm leading-6 text-neutral-600">メールの鍵を作ると、ここに出ます。</p></section>');
    expect(paragraphs(theirs)).not.toContainEqual(paragraphs(planted)[0]);
  });
});
