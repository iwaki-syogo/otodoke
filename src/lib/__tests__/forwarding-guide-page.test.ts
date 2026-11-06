import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { FORWARDING_GUIDES, FORWARDING_PITFALLS, GMAIL_FILTER, PITFALLS_LEAD } from "@/lib/forwarding-guide";
import * as guideData from "@/lib/forwarding-guide";
import { withoutComments } from "./source-scan";
import { findAll, parseHtml, textOf, type HtmlNode } from "./html-tree";

/**
 * The guide at /guide/forwarding: static, readable before signing in, and every sentence is the
 * one in the shared data (src/lib/forwarding-guide.ts). Fixed strings below are copied from the
 * source document so a reworded data file fails here.
 */

vi.mock("next/link", async () => {
  const { createElement: h } = await import("react");
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const Link = ({ href, children, prefetch, ...rest }: Record<string, unknown>) => h("a", { href: String(href), ...rest }, children as never);
  return { default: Link };
});
vi.mock("@/components/wordmark", () => ({ Wordmark: () => "Otodoke" }));

const PAGE_SOURCE = path.join(process.cwd(), "src/app/guide/forwarding/page.tsx");
const SETTINGS_SOURCE = path.join(process.cwd(), "src/app/app/settings/page.tsx");
const HOSTS = ["mail.google.com", "www.icloud.com", "outlook.live.com", "www.kuronekoyamato.co.jp", "faq.kuronekoyamato.co.jp"];

async function render(): Promise<HtmlNode> {
  const Page = (await import("@/app/guide/forwarding/page")).default;
  return parseHtml(renderToStaticMarkup(createElement(Page)));
}

/** What in this text breaks the owner's wording rule (empty when nothing does). */
function wordingProblems(text: string): string[] {
  return ["転送するだけ"].filter((w) => text.includes(w));
}

/** Every external link in the tree that breaks the link rules. */
function linkProblems(root: HtmlNode): string[] {
  const out: string[] = [];
  for (const a of findAll(root, (n) => n.tag === "a" && /^https?:/.test(n.attrs.href ?? ""))) {
    const href = a.attrs.href;
    const url = new URL(href);
    if (url.protocol !== "https:") out.push(`not https: ${href}`);
    if (!HOSTS.includes(url.hostname)) out.push(`host: ${href}`);
    if (a.attrs.target !== "_blank") out.push(`target: ${href}`);
    if (!(a.attrs.rel ?? "").split(/\s+/).includes("noopener")) out.push(`rel: ${href}`);
  }
  return out;
}

describe("/guide/forwarding", () => {
  it("shows the main sentences of the source document", async () => {
    const text = textOf(await render()).replace(/\s+/g, " ");
    const expected = [
      "メールの自動転送の設定",
      "設定は最初の 1 回だけです。あとは何もしなくても、荷物のメールが Otodoke に届きます。",
      "お使いのメールを選んでください。どれも 5 分ほどで終わります。",
      "Otodoke の設定の「メールの転送」で、あなた専用の転送先アドレスをコピーしておきます。",
      "「転送先アドレスを追加」を押し、Otodoke のアドレスを貼り付けます。",
      "転送先を登録する",
      "荷物のメールだけを送るフィルタを作る",
      "「転送する」にチェックを入れ、横の欄で Otodoke のアドレスを選び、「フィルタを作成」を押します。",
      "「転送後にメッセージを削除」にはチェックを入れません。入れると、iCloud にメールが残りません。",
      "「転送を有効にする」をオンにし、Otodoke のアドレスを貼り付けます。",
      "サインインしていないと Outlook の紹介ページが開きます。サインインしてから、もう一度このボタンを押してください。",
      "お使いのメールの設定にある「自動転送」で、Otodoke のアドレスへ転送してください。",
      "届かない人が多い落とし穴（必ず確かめてください）",
      "1. ヤマト運輸などのお届け予定メールを受け取っていない",
      "2. ショップの「発送のお知らせ」メールを止めている",
      "3. 荷物のメールが迷惑メールに入っている",
      "設定できたか確かめる",
      "出ないときは、設定の「うまく届かないとき」を開いてください。",
      GMAIL_FILTER,
      "@ml2.kuronekoyamato.co.jp",
    ];
    for (const s of expected) expect(text, s).toContain(s);
    expect(text).toContain(PITFALLS_LEAD);
  });

  it("shows every step and note of the data, numbered straight through in Gmail", async () => {
    const root = await render();
    const text = textOf(root).replace(/\s+/g, " ");
    for (const g of FORWARDING_GUIDES) {
      for (const step of g.groups.flatMap((x) => x.steps)) expect(text, step.text).toContain(step.text);
      for (const note of g.notes) expect(text).toContain(note);
    }
    const gmail = findAll(root, (n) => n.tag === "section" && n.attrs.id === "gmail")[0];
    const numbers = findAll(gmail, (n) => n.tag === "span" && /^\d$/.test(textOf(n))).map(textOf);
    expect(numbers).toEqual(["1", "2", "3", "4", "5", "6", "7", "8", "9"]);
    for (const p of FORWARDING_PITFALLS) expect(text).toContain(p.title);
  });

  it("has the five anchors and chips that jump to them", async () => {
    const root = await render();
    for (const id of ["gmail", "icloud", "outlook", "other", "pitfalls"]) {
      expect(findAll(root, (n) => n.attrs.id === id), id).toHaveLength(1);
    }
    for (const id of ["gmail", "icloud", "outlook", "other"]) {
      expect(findAll(root, (n) => n.tag === "a" && n.attrs.href === `#${id}`), id).toHaveLength(1);
    }
  });

  it("never says 「転送するだけ」, in the data or on the page", async () => {
    const all = JSON.stringify(Object.values(guideData));
    expect(wordingProblems(all)).toEqual([]);
    expect(wordingProblems(textOf(await render()))).toEqual([]);
  });

  it("the wording check fails on a string that says it (negative control)", () => {
    expect(wordingProblems("メールを転送するだけで済みます")).not.toEqual([]);
  });

  it("opens every outside link in a new tab over https, only on the known hosts", async () => {
    const root = await render();
    const links = findAll(root, (n) => n.tag === "a" && /^https?:/.test(n.attrs.href ?? ""));
    expect(links).toHaveLength(5);
    expect(linkProblems(root)).toEqual([]);
  });

  it("the link check fails on a bad link (negative control)", () => {
    const bad = parseHtml('<div><a href="http://evil.example/x">x</a></div>');
    expect(linkProblems(bad).length).toBeGreaterThan(0);
  });

  it("keeps the Gmail filter in step with the settings page", () => {
    const source = readFileSync(SETTINGS_SOURCE, "utf8");
    const own = /const GMAIL_FILTER = "([^"]*)"/.exec(source);
    if (own) expect(own[1]).toBe(GMAIL_FILTER);
    else expect(source).toContain("forwarding-guide");
  });

  it("reads nothing from the database or the request", () => {
    const source = withoutComments(readFileSync(PAGE_SOURCE, "utf8"));
    expect(source).not.toMatch(/supabase/i);
    expect(source).not.toMatch(/\bcookies\b/);
    expect(source).not.toMatch(/\bheaders\b/);
    expect(source).toContain('export const dynamic = "force-static"');
  });
});
