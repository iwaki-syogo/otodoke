import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { BEFORE_YOU_START_ACTION, BEFORE_YOU_START_HEADING, FORWARDING_GUIDES, FORWARDING_PITFALLS, GMAIL_FILTER, PITFALLS_HEADING, PITFALLS_LEAD, VIDEO_CREDIT } from "@/lib/forwarding-guide";
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
const SETTINGS_SOURCE = path.join(process.cwd(), "src/app/app/settings/forwarding-guide.tsx");
const HOSTS = ["mail.google.com", "www.icloud.com", "outlook.live.com"];

async function render(): Promise<HtmlNode> {
  const Page = (await import("@/app/guide/forwarding/page")).default;
  return parseHtml(renderToStaticMarkup(createElement(Page)));
}

/** What in this text breaks the wording rule (empty when nothing does). */
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
      "上の「Gmail の設定を開く」を押すと、Gmail の設定の画面が開きます。上に並んだタブの「メール転送と POP/IMAP」を押します。開かないときは、右上の歯車 › 「すべての設定を表示」 › 「メール転送と POP/IMAP」を開きます。「転送先アドレスを追加」を押し、Otodoke のアドレスを貼り付けます。",
      "転送先を登録する",
      "荷物のメールだけを送るフィルタを作る",
      "「転送」の欄は変えずに、次のフィルタへ進みます。荷物のメールだけを送るためです。",
      "「含む」に次の文字列を貼り付けます。",
      "「転送する」にチェックを入れ、横の欄で Otodoke のアドレスを選び、「フィルタを作成」を押します。",
      "「転送後にメッセージを削除」にはチェックを入れません。入れると、iCloud にメールが残りません。",
      "「転送を有効にする」をオンにし、Otodoke のアドレスを貼り付けます。",
      "サインインしていないと Outlook の紹介ページが開きます。サインインしてから、もう一度このボタンを押してください。",
      "Yahoo!メールは、自動転送したメールが Yahoo!メールに残らないので、おすすめしません。",
      "お使いのメールの設定にある「自動転送」で、Otodoke のアドレスへ転送してください。転送したメールが元のメールにも残る設定にします。",
      "5 分・ブラウザで",
      GMAIL_FILTER,
    ];
    for (const s of expected) expect(text, s).toContain(s);
  });

  it("does not show the pitfall card or the 確かめる card, nor the sentences that made them look like more work", async () => {
    const root = await render();
    const text = textOf(root).replace(/\s+/g, " ");
    expect(findAll(root, (n) => n.attrs.id === "pitfalls")).toHaveLength(0);
    expect(findAll(root, (n) => n.tag === "a" && n.attrs.href === "#pitfalls")).toHaveLength(0);
    expect(text).not.toContain(PITFALLS_HEADING);
    expect(text).not.toContain(PITFALLS_LEAD);
    for (const p of FORWARDING_PITFALLS) expect(text).not.toContain(p.title);
    expect(text).not.toContain("@ml2.kuronekoyamato.co.jp");
    expect(text).not.toContain("設定できたか確かめる");
    expect(findAll(root, (n) => n.tag === "a" && n.attrs.href === "/app/settings/trouble")).toHaveLength(0);
    for (const w of ["パソコン版の画面で開き", "転送を無効にする", "先に確かめてください", "フィルタをまだ作っていなければ"]) expect(text, w).not.toContain(w);
    expect(text).not.toContain("スマホは Gmail アプリではなく");
    // Negative control: the same probe finds the heading in a tree that has it.
    expect(textOf(parseHtml(`<h2>${PITFALLS_HEADING}</h2>`))).toContain(PITFALLS_HEADING);
  });

  it("still shows the pitfalls on the 「うまく届かないとき」 page (negative control for the removal)", () => {
    const source = readFileSync(path.join(process.cwd(), "src/app/app/settings/trouble/page.tsx"), "utf8");
    expect(source).toContain("FORWARDING_PITFALLS");
    expect(source).toContain("PitfallBody");
    expect(FORWARDING_PITFALLS).toHaveLength(3);
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
    expect(numbers).toEqual(["1", "2", "3", "4", "5", "6", "7"]);
  });

  it("has the four anchors and chips that jump to them", async () => {
    const root = await render();
    for (const id of ["gmail", "icloud", "outlook", "other"]) {
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
    expect(links).toHaveLength(3);
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
    // The settings guide imports the words; it has no copy of its own.
    else expect(source).toContain('from "@/lib/forwarding-guide"');
  });

  it("sends the start card to the forwarding page", async () => {
    const root = await render();
    expect(findAll(root, (n) => n.tag === "a" && textOf(n).trim() === BEFORE_YOU_START_ACTION).map((a) => a.attrs.href)).toEqual(["/app/settings/forwarding"]);
  });

  it("gives the 「始める前に」 card exactly one link to the forwarding address page", async () => {
    const root = await render();
    const card = findAll(root, (n) => n.tag === "section" && findAll(n, (h) => h.tag === "h2" && textOf(h).trim() === BEFORE_YOU_START_HEADING).length > 0)[0];
    const links = findAll(card, (n) => n.tag === "a");
    expect(links.map((a) => [a.attrs.href, textOf(a).trim()])).toEqual([["/app/settings/forwarding", BEFORE_YOU_START_ACTION]]);
  });

  it("reads nothing from the database or the request", () => {
    const source = withoutComments(readFileSync(PAGE_SOURCE, "utf8"));
    expect(source).not.toMatch(/supabase/i);
    expect(source).not.toMatch(/\bcookies\b/);
    expect(source).not.toMatch(/\bheaders\b/);
    expect(source).toContain('export const dynamic = "force-static"');
  });

  it("puts one video in each of the Gmail, iCloud and Outlook sections", async () => {
    const root = await render();
    for (const id of ["gmail", "icloud", "outlook"]) {
      const section = findAll(root, (n) => n.tag === "section" && n.attrs.id === id)[0];
      const videos = findAll(section, (n) => n.tag === "video");
      expect(videos, id).toHaveLength(1);
      const v = videos[0];
      expect(v.attrs.preload, id).toBe("none");
      expect("controls" in v.attrs, id).toBe(true);
      expect("playsinline" in v.attrs || "playsInline" in v.attrs, id).toBe(true);
      expect("autoplay" in v.attrs || "autoPlay" in v.attrs, id).toBe(false);
      expect("loop" in v.attrs, id).toBe(false);
      expect("muted" in v.attrs, id).toBe(false);
    }
    const other = findAll(root, (n) => n.tag === "section" && n.attrs.id === "other")[0];
    expect(findAll(other, (n) => n.tag === "video")).toHaveLength(0);
  });

  it("points every video and poster at a file under public/, each mp4 at most 4MB", async () => {
    const root = await render();
    const videos = findAll(root, (n) => n.tag === "video");
    expect(videos).toHaveLength(3);
    for (const v of videos) {
      const sources = findAll(v, (n) => n.tag === "source");
      expect(sources).toHaveLength(1);
      const mp4 = path.join(process.cwd(), "public", sources[0].attrs.src);
      const poster = path.join(process.cwd(), "public", v.attrs.poster);
      expect(existsSync(mp4), mp4).toBe(true);
      expect(existsSync(poster), poster).toBe(true);
      expect(statSync(mp4).size).toBeLessThanOrEqual(4 * 1024 * 1024);
    }
  });

  it("shows the video credit and the minutes label", async () => {
    const text = textOf(await render()).replace(/\s+/g, " ");
    expect(text).toContain(VIDEO_CREDIT);
    expect(text).toContain("動画で見る・約 1 分半");
    expect(text).toContain("動画で見る・約 1 分半");
    expect(text).not.toContain("約 0 分半");
  });
});

describe("forwarding-guide data has no parentheses", () => {
  it("shows no (, ), （ or ） in any string that reaches the screen", () => {
    const strings: string[] = [];
    const walk = (v: unknown, key = ""): void => {
      if (typeof v === "string") {
        // URLs and the Gmail filter are not screen text.
        if (key !== "href" && key !== "src" && key !== "poster" && v !== GMAIL_FILTER) strings.push(v);
      } else if (Array.isArray(v)) v.forEach((x) => walk(x, key));
      else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, k);
    };
    walk(guideData);
    expect(strings.length).toBeGreaterThan(20);
    for (const s of strings) expect(s, s).not.toMatch(/[()（）]/);
  });
});
