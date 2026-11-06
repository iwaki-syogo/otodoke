import { existsSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ACCOUNT_DELETED_PATH } from "@/lib/account-deletion";
import { findAll, linksTo, parseHtml, textOf } from "./html-tree";
import { mount } from "./hook-harness";

/**
 * The page after 設定「アカウントを削除」 (review E-2): opens without a session, says it is done,
 * reminds once to remove the automatic forwarding, and has the way back to the login page. The
 * keys opened in this tab are forgotten, as logging out (a new page load) forgets them.
 */

const tab = vi.hoisted(() => ({ forgetTabKey: vi.fn() }));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { harnessHooks } = await import("./hook-harness");
  return harnessHooks(actual);
});
// next/font only works inside the Next.js compiler.
vi.mock("@/components/wordmark", () => ({ Wordmark: () => "Otodoke" }));
vi.mock("@/lib/crypto/tab-key", () => tab);

const pageModule = await import("@/app/account-deleted/page");
const { ForgetTabKey } = await import("@/app/account-deleted/forget-tab-key");

beforeEach(() => {
  tab.forgetTabKey.mockClear();
});

describe("/account-deleted", () => {
  it("is the path the action goes to, outside /app (which sends a visitor without a session to /login)", () => {
    expect(existsSync(path.resolve(__dirname, `../../app${ACCOUNT_DELETED_PATH}/page.tsx`))).toBe(true);
    expect(ACCOUNT_DELETED_PATH.startsWith("/app")).toBe(false);
  });

  it("says it is done, reminds about the forwarding, and leads to the login page", () => {
    const root = parseHtml(renderToStaticMarkup(pageModule.default()));
    expect(findAll(root, (n) => n.tag === "h1").map(textOf)).toEqual(["アカウントを削除しました"]);
    expect(textOf(root)).toContain("ご利用ありがとうございました。Gmail などで設定した自動転送も、忘れずに外してください。");
    expect(linksTo(root, "/login").map(textOf)).toEqual(["ログイン画面へ"]);
    expect(linksTo(root, "/")).toHaveLength(1);
    // The words use no brackets (wording rule).
    expect(textOf(root)).not.toMatch(/[()（）「」]/);
  });

  it("is not for search engines", () => {
    expect(pageModule.metadata).toMatchObject({ title: "アカウントを削除しました", robots: { index: false } });
  });

  it("forgets the keys opened in this tab, once, when it opens", () => {
    const view = mount(() => ForgetTabKey());
    expect(tab.forgetTabKey).toHaveBeenCalledTimes(1);
    view.rerender();
    expect(tab.forgetTabKey).toHaveBeenCalledTimes(1);
    expect(view.text()).toBe("");
  });

  it("renders ForgetTabKey on the page", () => {
    const tree = pageModule.default();
    const children = (tree.props as { children: Array<{ type?: unknown }> }).children;
    expect(children.some((c) => c && c.type === ForgetTabKey)).toBe(true);
  });
});
