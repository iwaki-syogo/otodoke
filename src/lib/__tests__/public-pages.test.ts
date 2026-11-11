import { existsSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { findAll, linksTo, parseHtml, textOf, type HtmlNode } from "./html-tree";

const probe = vi.hoisted(() => ({ contact: "public-probe@example.test" }));
vi.mock("@/components/wordmark", () => ({ Wordmark: () => "Otodoke" }));
vi.mock("@/app/privacy/contact", () => ({ CONTACT_EMAIL: probe.contact }));
// Public documents must not need a user or database, including from a shared component.
vi.mock("@/lib/supabase/server", () => ({
  getUser: () => { throw new Error("public document read a user"); },
  createClient: () => { throw new Error("public document read the database"); },
}));

const appDir = path.join(process.cwd(), "src/app");
const rejectedText = ["転送", "するだけ"].join("");

function wordingProblems(text: string): string[] {
  return [rejectedText, "本人と確かめる", "未確認", "制定日:", "管轄", "免除し", "アカウントを停止"].filter((word) => text.includes(word));
}

function missingRoutes(root: HtmlNode, exists = existsSync): string[] {
  return findAll(root, (n) => n.tag === "a" && n.attrs.href?.startsWith("/"))
    .map((n) => new URL(n.attrs.href, "https://example.test").pathname)
    .filter((route) => !exists(path.join(appDir, route === "/" ? "page.tsx" : `${route.slice(1)}/page.tsx`)));
}

async function render(which: "terms" | "support") {
  const page = which === "terms" ? await import("@/app/terms/page") : await import("@/app/support/page");
  return { root: parseHtml(renderToStaticMarkup(createElement(page.default))), page };
}

describe("public terms and support", () => {
  it.each(["terms", "support"] as const)("/%s is static and renders without a session or database", async (which) => {
    const { root, page } = await render(which);
    expect(page.dynamic).toBe("force-static");
    expect(findAll(root, (n) => n.tag === "h1").map(textOf)).toEqual([which === "terms" ? "利用規約" : "サポート"]);
    expect(page.metadata.title).toBe(which === "terms" ? "利用規約" : "サポート");
    expect(linksTo(root, "/")).toHaveLength(1);
    expect(linksTo(root, "/privacy")).toHaveLength(1);
    expect(linksTo(root, which === "terms" ? "/support" : "/terms")).toHaveLength(1);
    expect(missingRoutes(root)).toEqual([]);
    expect(wordingProblems(textOf(root))).toEqual([]);
    expect(textOf(root).match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g)).toEqual([probe.contact]);
    expect(findAll(root, (n) => n.tag === "a" && n.attrs.href?.startsWith("mailto:")).map((n) => n.attrs.href)).toEqual([`mailto:${probe.contact}`]);
    const main = findAll(root, (n) => n.tag === "main")[0];
    expect(main.attrs.class).toContain("w-full");
    expect(main.attrs.class).toContain("max-w-md");
    expect(findAll(root, (n) => n.tag === "a" && textOf(n) === probe.contact)[0].attrs.class).toContain("break-all");
  });

  it("keeps the operational terms and leaves legal decisions out of the public copy", async () => {
    const { root } = await render("terms");
    const text = textOf(root);
    for (const requirement of ["Otodoke 運営", "無料で利用できます", "禁止事項", "Anthropic", "読み取り待ちのメール", "目安", "外部サービス", "アカウントの削除", "パスワードを忘れて再設定"]) expect(text).toContain(requirement);
    expect(text).not.toContain("準拠法");
    expect(text).not.toContain("規約の変更");
    expect(text).not.toContain("サービスの変更・中断・終了");
  });

  it("support offers public help and clearly labels the settings that require login", async () => {
    const { root } = await render("support");
    expect(linksTo(root, "/guide/forwarding")).toHaveLength(1);
    expect(linksTo(root, "/login/forgot")).toHaveLength(1);
    for (const route of ["/app/settings/forwarding", "/app/settings/trouble", "/app/settings/demo", "/app/settings/delete"]) {
      const links = linksTo(root, route);
      expect(links, route).toHaveLength(1);
      expect(textOf(links[0])).toContain("ログインして");
    }
    expect(textOf(root)).toContain("前に暗号化して保存したメールは開けなくなります。荷物は残ります。");
    expect(textOf(root)).toContain("自動転送");
    expect(textOf(root)).toContain("解除");
  });

  it("the link and wording checks reject planted regressions", async () => {
    expect(missingRoutes(parseHtml('<a href="/missing-public-help">案内</a>'))).toEqual(["/missing-public-help"]);
    const { root } = await render("terms");
    expect(missingRoutes(root, (candidate) => !String(candidate).endsWith("support/page.tsx") && existsSync(candidate))).toEqual(["/support"]);
    expect(wordingProblems(`この案内は${rejectedText}です`)).toEqual([rejectedText]);
    expect(wordingProblems("本人と確かめる")).toEqual(["本人と確かめる"]);
  });

});
