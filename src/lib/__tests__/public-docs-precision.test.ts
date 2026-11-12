import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AI_CONSENT_TEXT } from "@/lib/ai-consent-text";
import { PLAINTEXT_DROP_NOTICE } from "@/lib/mail-notices";
import { PUBLIC_PAGE_TEXT } from "@/lib/public-pages";
import { findAll, linksTo, parseHtml, textOf, type HtmlNode } from "./html-tree";

vi.mock("next/link", async () => {
  const { createElement: h } = await import("react");
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const Link = ({ href, children, prefetch, ...rest }: Record<string, unknown>) => h("a", { href: String(href), ...rest }, children as never);
  return { default: Link };
});
vi.mock("@/components/wordmark", () => ({ Wordmark: () => "Otodoke" }));

async function policy() {
  const Page = (await import("@/app/privacy/page")).default;
  return parseHtml(renderToStaticMarkup(createElement(Page)));
}

function term(root: HtmlNode, name: string) {
  const labels = findAll(root, (node) => node.tag === "dt" && textOf(node) === name);
  expect(labels, name).toHaveLength(1);
  const value = labels[0].parent!.children.find((node): node is HtmlNode => typeof node !== "string" && node.tag === "dd");
  expect(value, name).toBeDefined();
  return value!;
}

describe("public documents describe the implemented storage boundaries", () => {
  it("keeps the three approved consent sentences character for character", () => {
    expect(AI_CONSENT_TEXT.body).toBe("届いたメールは、Anthropic の Claude で読み取ります。");
    expect(AI_CONSENT_TEXT.detail).toBe("メールの件名・差出人・本文を送り、荷物の情報を取り出します。");
    expect(AI_CONSENT_TEXT.waitingRetention).toBe("許可を待つメールは、届いてから 14 日で消えます。");
  });

  it("keeps the existing terms block unchanged while public copy is revised", () => {
    // These normative terms are frozen by the owner for this change, including their wording.
    const source = readFileSync(path.join(process.cwd(), "src/lib/public-pages.ts"), "utf8");
    const block = source.slice(source.indexOf("  terms: {"), source.indexOf("  support: {"));
    expect(createHash("sha256").update(block).digest("hex")).toBe("235aa104a695ab8ddca802fecb2349d9d7d22c115d30dd1426c38244bbe0cb71");
  });

  it("adds daily cleanup beside the approved waiting sentence without replacing it", async () => {
    const waiting = term(await policy(), "許可待ちのメール");
    expect(findAll(waiting, (node) => node.tag === "p" && textOf(node) === AI_CONSENT_TEXT.waitingRetention)).toHaveLength(1);
    expect(textOf(waiting)).toContain("期限を過ぎたメールは、毎日の掃除で消します。");
  });

  it("explains key, no-key personal mail and no-key samples once, and links settings to that section", async () => {
    const root = await policy();
    const storage = term(root, "保存と暗号化");
    expect(textOf(storage)).toContain("買い物に関係するメールは、読み取り後に");
    expect(textOf(storage)).toMatch(/鍵がある場合.+暗号化して保存します/);
    expect(textOf(storage)).toMatch(/鍵がない場合.+あなたのメール.+残しません/);
    expect(textOf(storage)).toMatch(/鍵がないサンプル.+暗号化せずに保存します/);
    expect(findAll(root, (node) => node.attrs.id === "mail-storage")).toHaveLength(1);
    const { MailHandling } = await import("@/app/app/settings/mail-handling");
    const settings = parseHtml(renderToStaticMarkup(createElement(MailHandling)));
    expect(linksTo(settings, "/privacy#mail-storage")).toHaveLength(1);
  });

  it("distinguishes receipt undo's usable period from daily physical cleanup and cascade deletion", async () => {
    const root = await policy();
    const receipt = term(root, "受け取りを元に戻す記録");
    const text = textOf(receipt);
    expect(text).toContain("受け取りを元に戻すため");
    expect(text).toContain("変更前後の状態");
    expect(text).toMatch(/24 時間で使えなくなります/);
    expect(text).toContain("毎日の掃除で消します");
    expect(text).toMatch(/荷物やアカウントを削除.+この記録も消えます/);
    expect(findAll(root, (node) => node.attrs.id === "receipt-records")).toHaveLength(1);
    const { MailHandling } = await import("@/app/app/settings/mail-handling");
    const settings = parseHtml(renderToStaticMarkup(createElement(MailHandling)));
    expect(linksTo(settings, "/privacy#receipt-records")).toHaveLength(1);
  });

  it("counts screen-event retention from its original record and describes bounded pruning", async () => {
    const root = await policy();
    const screen = textOf(term(root, "読まなかったメールの件名と差出人のドメイン"));
    const forgotten = textOf(term(root, "「これは荷物」で覚えた差出人"));
    for (const text of [screen, forgotten]) {
      expect(text).toContain("記録してから 14 日");
      expect(text).toContain("毎日の掃除");
    }
    expect(textOf(term(root, "メールの送信とログインを試した記録"))).toMatch(/1 時間を過ぎた記録.+順に消します/);
    expect(textOf(term(root, "Claude を使った回数"))).toContain("呼び出した日の 2 日後");
  });

  it("limits the legacy plaintext notice to read personal mail and a planned deletion", () => {
    expect(PLAINTEXT_DROP_NOTICE).toContain("暗号化前に読み取った実メール");
    expect(PLAINTEXT_DROP_NOTICE).toContain("順に暗号化します");
    expect(PLAINTEXT_DROP_NOTICE).toMatch(/鍵がない.+11 月 14 日.+消す予定です/);
  });

  it("says samples do not need the user's own mail", () => {
    const sample = PUBLIC_PAGE_TEXT.support.sections.find((section) => section.title === "サンプルで試す");
    expect(sample?.paragraphs[0]).toContain("あなたのメールを送らずに試せます。");
    expect(sample?.paragraphs[0]).not.toContain("実際のメールを使わずに試せます。");
  });
});
