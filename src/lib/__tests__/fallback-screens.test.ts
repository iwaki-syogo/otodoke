import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { findAll, parseHtml, textOf, type HtmlNode } from "./html-tree";

/**
 * [Review 2026-11-06 E-11] Japanese 404 and error screens instead of Next's English ones.
 *
 * - 404 (src/app/not-found.tsx, src/app/app/not-found.tsx): for a URL no page answers and for
 *   notFound() (another person's parcel, a malformed id). The way back: the parcel list when
 *   signed in, else the top page.
 * - Errors (src/app/error.tsx, src/app/app/error.tsx, src/app/global-error.tsx): a short apology,
 *   「もう一度読み込む」 (Next's retry) and a way back; never the error's message or stack.
 *   global-error brings its own <html lang="ja"> and <body> (it replaces the root layout).
 */

const mocks = vi.hoisted(() => ({ pathname: "/", user: null as { id: string } | null, userError: null as unknown }));

vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  usePathname: () => mocks.pathname,
}));
vi.mock("@/lib/supabase/server", () => ({
  getUser: async () => {
    if (mocks.userError) throw mocks.userError;
    return mocks.user;
  },
}));

beforeEach(() => {
  mocks.pathname = "/";
  mocks.user = null;
  mocks.userError = null;
});
afterEach(() => {
  vi.restoreAllMocks();
});

const appDir = path.resolve(__dirname, "../../app");
const html = (el: Parameters<typeof renderToStaticMarkup>[0]) => parseHtml(renderToStaticMarkup(el));
const links = (root: HtmlNode) => findAll(root, (n) => n.tag === "a").map((a) => [a.attrs.href, textOf(a).trim()]);
const noEnglish = (root: HtmlNode) => expect(textOf(root)).not.toMatch(/[A-Za-z]/);

describe("the 404 screens", () => {
  const rootNotFound = async () => {
    const NotFound = (await import("@/app/not-found")).default;
    return html(await NotFound());
  };

  it("say 「ページが見つかりません」 in Japanese only", async () => {
    const root = await rootNotFound();
    expect(findAll(root, (n) => n.tag === "h1").map((h) => textOf(h).trim())).toEqual(["ページが見つかりません"]);
    noEnglish(root);
  });

  it("lead to the parcel list when signed in, and to the top page when not", async () => {
    mocks.user = { id: "u1" };
    expect(links(await rootNotFound())).toEqual([["/app", "荷物の一覧へ"]]);
    mocks.user = null;
    expect(links(await rootNotFound())).toEqual([["/", "トップへ"]]);
  });

  it("lead to the top page when the sign-in cannot be read", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.userError = new Error("network down");
    expect(links(await rootNotFound())).toEqual([["/", "トップへ"]]);
  });

  it("let Next's own signals through (they are not a failed sign-in read)", async () => {
    const { redirect } = await import("next/navigation");
    let signal: unknown;
    try {
      redirect("/login");
    } catch (err) {
      signal = err;
    }
    expect(signal).toBeDefined();
    mocks.userError = signal;
    const NotFound = (await import("@/app/not-found")).default;
    await expect(NotFound()).rejects.toBe(signal);
  });

  it("under /app, notFound() keeps the tabs and leads to the parcel list", async () => {
    const NotFound = (await import("@/app/app/not-found")).default;
    const root = html(createElement(NotFound));
    expect(textOf(root)).toContain("ページが見つかりません");
    expect(links(root)).toEqual([["/app", "荷物の一覧へ"]]);
    noEnglish(root);
  });

  it("the root 404 has a Japanese title", async () => {
    const { metadata } = await import("@/app/not-found");
    expect(metadata.title).toBe("ページが見つかりません");
  });
});

describe("the error screens", () => {
  const SECRET = "SECRET-db-detail relation parcels does not exist";
  const thrown = () => Object.assign(new Error(SECRET), { digest: "123456", stack: `Error: ${SECRET}\n    at secret (file.ts:1:1)` });
  const render = async (file: string) => {
    const Page = (await import(file)).default as (p: { error: unknown; retry: () => void }) => Parameters<typeof renderToStaticMarkup>[0];
    return html(createElement(Page as never, { error: thrown(), retry: () => {} } as never));
  };
  const buttonTexts = (root: HtmlNode) => findAll(root, (n) => n.tag === "button").map((b) => textOf(b).trim());

  it.each(["@/app/error", "@/app/app/error", "@/app/global-error"])("%s apologises and offers 「もう一度読み込む」, never the error itself", async (file) => {
    mocks.pathname = "/app/calendar";
    const root = await render(file);
    // The screen's words (global-error's <title> aside: it is the app's name).
    const text = textOf(findAll(root, (n) => n.tag === "h1")[0].parent!);
    expect(text).toContain("申し訳ありません");
    expect(text).toContain("このページを表示できませんでした。");
    expect(buttonTexts(root)).toEqual(["もう一度読み込む"]);
    for (const leak of [SECRET, "SECRET", "123456", "file.ts", "Error"]) expect(text).not.toContain(leak);
    expect(text).not.toMatch(/[A-Za-z]/);
  });

  it("outside /app the way back is the top page, left out on the top page itself", async () => {
    mocks.pathname = "/login";
    expect(links(await render("@/app/error"))).toEqual([["/", "トップへ"]]);
    mocks.pathname = "/";
    expect(links(await render("@/app/error"))).toEqual([]);
  });

  it("under /app the way back is the parcel list, left out on the list itself", async () => {
    mocks.pathname = "/app/parcels/1";
    expect(links(await render("@/app/app/error"))).toEqual([["/app", "荷物の一覧へ"]]);
    mocks.pathname = "/app";
    expect(links(await render("@/app/app/error"))).toEqual([]);
  });

  it("global-error brings its own document in Japanese, with the app's styles", async () => {
    const markup = renderToStaticMarkup(createElement((await import("@/app/global-error")).default as never, { error: thrown(), retry: () => {} } as never));
    expect(markup).toMatch(/^<html lang="ja">(<head><title>Otodoke<\/title><\/head>)?<body\b/);
    expect(links(parseHtml(markup))).toEqual([["/", "トップへ"]]);
    const source = readFileSync(path.join(appDir, "global-error.tsx"), "utf8");
    expect(source).toMatch(/^"use client";/);
    expect(source).toMatch(/import "\.\/globals\.css";/);
  });

  it("are client components that take Next's retry", () => {
    for (const f of ["error.tsx", "app/error.tsx", "global-error.tsx"]) {
      const source = readFileSync(path.join(appDir, f), "utf8");
      expect(source.startsWith('"use client";'), f).toBe(true);
      expect(source, f).toMatch(/\{ error, retry \}: \{ error: unknown; retry: \(\) => void \}/);
      expect(source, f).not.toMatch(/error\.(message|stack|digest)/);
    }
  });
});

describe("the files Next looks for", () => {
  it("are all there", () => {
    for (const f of ["not-found.tsx", "error.tsx", "global-error.tsx", "app/not-found.tsx", "app/error.tsx"]) expect(existsSync(path.join(appDir, f)), f).toBe(true);
  });
});
