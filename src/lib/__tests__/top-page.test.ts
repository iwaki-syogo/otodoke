import { existsSync, readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { findAll, parseHtml, textOf } from "./html-tree";

/**
 * The top page (src/app/page.tsx) with password-v1: signed out, the main button makes an account
 * (/signup: the address and a password), and the header's 「ログイン」 signs in; signed in, both go
 * to the parcels. README names 「アカウントを作る」 for the top page and /login.
 */

const session = vi.hoisted(() => ({ user: null as { id: string; email: string } | null }));

// next/font only works inside the Next.js compiler.
vi.mock("@/components/wordmark", () => ({ Wordmark: () => "Otodoke" }));
vi.mock("@/lib/supabase/server", () => ({ getUser: async () => session.user }));

const Home = (await import("@/app/page")).default;

const links = async () => findAll(parseHtml(renderToStaticMarkup(await Home())), (n) => n.tag === "a").map((a) => [a.attrs.href, textOf(a).trim()]);

beforeEach(() => {
  session.user = null;
});

describe("the top page", () => {
  it("signed out: 「アカウントを作る」 goes to /signup and a 「ログイン」 button under it to /login", async () => {
    const all = await links();
    expect(all).toContainEqual(["/signup", "アカウントを作る"]);
    expect(all).toContainEqual(["/login", "ログイン"]);
    expect(all.filter(([href]) => href === "/signup" || href === "/login")).toHaveLength(2);
    expect(JSON.stringify(all)).not.toContain("メールアドレスで始める");
  });

  it("signed out: the two buttons are in the page body, in that order, and the header has no 「ログイン」", async () => {
    const root = parseHtml(renderToStaticMarkup(await Home()));
    const header = findAll(root, (n) => n.tag === "header")[0];
    expect(findAll(header, (n) => n.tag === "a")).toEqual([]);
    const section = findAll(root, (n) => n.tag === "section")[0];
    expect(findAll(section, (n) => n.tag === "a").map((a) => [a.attrs.href, textOf(a).trim()])).toEqual([
      ["/signup", "アカウントを作る"],
      ["/login", "ログイン"],
    ]);
  });

  it("signed in: both go to the parcels", async () => {
    session.user = { id: "00000000-0000-4000-8000-00000000000a", email: "qa@example.com" };
    const all = await links();
    expect(all.filter(([href]) => href === "/app")).toEqual([
      ["/app", "荷物を見る"],
      ["/app", "荷物を見る"],
    ]);
    expect(all.map(([href]) => href)).not.toContain("/signup");
    expect(all.map(([href]) => href)).not.toContain("/login");
  });

  it("shows the three screenshots in order with their alt texts, all lazy", async () => {
    const root = parseHtml(renderToStaticMarkup(await Home()));
    const imgs = findAll(root, (n) => n.tag === "img");
    expect(imgs.slice(0, 3).map((i) => i.attrs.alt)).toEqual([
      "荷物の一覧。店も運送会社もまとめて、届く日と対面での受け取りが分かる",
      "カレンダー。家にいる必要のある日に赤い印",
      "荷物の詳細。読み取った値の横に、元のメールの一文",
    ]);
    expect(imgs.slice(0, 3).map((i) => decodeURIComponent(i.attrs.src))).toEqual([
      expect.stringContaining("/screens/list.webp"),
      expect.stringContaining("/screens/calendar.webp"),
      expect.stringContaining("/screens/detail.webp"),
    ]);
    expect(imgs.slice(0, 3).map((i) => [i.attrs.width, i.attrs.height])).toEqual([
      ["720", "1415"],
      ["720", "1415"],
      ["720", "492"],
    ]);
    expect(imgs.length).toBe(4);
    for (const img of imgs) {
      expect(img.attrs.loading).toBe("lazy");
      expect(img.attrs.fetchpriority).toBeUndefined();
    }
    expect(renderToStaticMarkup(await Home())).not.toContain("rel=\"preload\"");
  });

  it("the demo video link opens YouTube in a new tab safely", async () => {
    const root = parseHtml(renderToStaticMarkup(await Home()));
    const a = findAll(root, (n) => n.tag === "a" && n.attrs.href === "https://youtu.be/BLPMP_bYJ8c")[0];
    expect(a.attrs.target).toBe("_blank");
    expect(a.attrs.rel).toContain("noopener");
    expect(textOf(a).trim()).toBe("デモ動画（3 分）");
    expect(findAll(a, (n) => n.tag === "img")).toHaveLength(1);
  });
});

describe("share metadata", () => {
  it("layout sets metadataBase and a large Twitter card", async () => {
    const { metadata } = await import("@/app/layout");
    expect(String(metadata.metadataBase)).toBe("https://otodoke.app/");
    expect((metadata.twitter as { card: string }).card).toBe("summary_large_image");
    expect(metadata.openGraph).toMatchObject({ siteName: "Otodoke", type: "website", locale: "ja_JP" });
    // Child routes inherit openGraph, so a title or description here would override every page's own.
    expect(metadata.openGraph).not.toHaveProperty("title");
    expect(metadata.openGraph).not.toHaveProperty("description");
  });

  it("opengraph-image.png is 1200x630", () => {
    const b = readFileSync(new URL("../../app/opengraph-image.png", import.meta.url));
    expect(b.subarray(1, 4).toString()).toBe("PNG");
    expect([b.readUInt32BE(16), b.readUInt32BE(20)]).toEqual([1200, 630]);
  });

  it("every image the top page and README name exists in the repo", () => {
    const root = new URL("../../../", import.meta.url);
    for (const f of ["list.webp", "calendar.webp", "detail.webp", "video-thumb.jpg"]) {
      expect(existsSync(new URL(`public/screens/${f}`, root))).toBe(true);
    }
    const top = readFileSync(new URL("README.md", root), "utf8").split("\n").slice(0, 30).join("\n");
    const srcs = [...top.matchAll(/<img[^>]*\ssrc="([^"]+)"/g)].map((m) => m[1]);
    expect(srcs.length).toBeGreaterThanOrEqual(4);
    for (const src of srcs) expect(existsSync(new URL(src, root))).toBe(true);
    expect(existsSync(new URL("src/app/twitter-image.png", root))).toBe(false);
    for (const n of ["list", "calendar", "detail"]) {
      expect(top).toMatch(new RegExp(`<img src="public/screens/${n}\\.webp"[^>]*\\salign="top"`));
    }
    // detail.webp is a lossy WebP ("VP8 " chunk): 14-bit little-endian width/height at bytes 26-29.
    const w = readFileSync(new URL("public/screens/detail.webp", root));
    expect(w.subarray(0, 4).toString()).toBe("RIFF");
    expect(w.subarray(8, 16).toString()).toBe("WEBPVP8 ");
    expect([w.readUInt16LE(26) & 0x3fff, w.readUInt16LE(28) & 0x3fff]).toEqual([720, 492]);
  });

  it("the video thumbnail has empty alt, and the strip is a focusable labelled region placed after the Feature cards", async () => {
    const html = renderToStaticMarkup(await Home());
    const root = parseHtml(html);
    const link = findAll(root, (n) => n.tag === "a" && n.attrs.href === "https://youtu.be/BLPMP_bYJ8c")[0];
    expect(findAll(link, (n) => n.tag === "img")[0].attrs.alt).toBe("");
    const strip = findAll(root, (n) => n.attrs.role === "region")[0];
    expect(strip.attrs["aria-label"]).toBeTruthy();
    expect(strip.attrs.tabindex).toBe("0");
    expect(findAll(strip, (n) => n.tag === "img")).toHaveLength(3);
    expect(strip.attrs.class.split(/\s+/)).toContain("items-start");
    expect(html.indexOf("根拠が見える")).toBeGreaterThan(-1);
    expect(html.indexOf('role="region"')).toBeGreaterThan(html.indexOf("根拠が見える"));
    expect(html.indexOf("<footer")).toBeGreaterThan(html.indexOf("youtu.be"));
  });
});
