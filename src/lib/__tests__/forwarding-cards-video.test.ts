import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { FORWARDING_GUIDES, VIDEO_CREDIT, type ForwardingGuide } from "@/lib/forwarding-guide";
import { GuideCardBody } from "@/components/forwarding-steps";
import { findAll, parseHtml, textOf, type HtmlNode } from "./html-tree";

/**
 * The explainer videos in the cards of 設定 › メールの転送 (ForwardingGuides): they play in the card,
 * before any written step. The welcome page's cards are checked in welcome-page.test.ts.
 */

vi.mock("next/link", async () => {
  const { createElement: h } = await import("react");
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const Link = ({ href, children, prefetch, ...rest }: Record<string, unknown>) => h("a", { href: String(href), ...rest }, children as never);
  return { default: Link };
});

const WITH_VIDEO = FORWARDING_GUIDES.filter((g) => g.video);

async function settings(): Promise<HtmlNode> {
  const { ForwardingGuides } = await import("@/app/app/settings/forwarding-guide");
  return parseHtml(renderToStaticMarkup(createElement(ForwardingGuides)));
}

describe("videos in the cards of 設定 › メールの転送", () => {
  it("Gmail, iCloud and Outlook each have a video with the data's src and poster", async () => {
    expect(WITH_VIDEO.map((g) => g.id)).toEqual(["gmail", "icloud", "outlook"]);
    const cards = findAll(await settings(), (n) => n.tag === "details");
    expect(cards).toHaveLength(FORWARDING_GUIDES.length);
    for (const [i, guide] of FORWARDING_GUIDES.entries()) {
      const videos = findAll(cards[i], (n) => n.tag === "video");
      if (!guide.video) {
        expect(videos, guide.id).toHaveLength(0);
        continue;
      }
      expect(videos, guide.id).toHaveLength(1);
      expect(videos[0].attrs.poster).toBe(guide.video.poster);
      expect(videos[0].attrs.preload).toBe("none");
      expect("controls" in videos[0].attrs).toBe(true);
      expect(findAll(videos[0], (n) => n.tag === "source").map((s) => s.attrs.src)).toEqual([guide.video.src]);
    }
  });

  it("the video comes after 「目安」 and before the first list of steps", async () => {
    const html = renderToStaticMarkup(createElement((await import("@/app/app/settings/forwarding-guide")).ForwardingGuides));
    const cards = html.split("<details").slice(1);
    for (const card of cards.slice(0, 3)) {
      expect(card.indexOf("目安:")).toBeGreaterThan(-1);
      expect(card.indexOf("<video")).toBeGreaterThan(card.indexOf("目安:"));
      expect(card.indexOf("<video")).toBeLessThan(card.indexOf("<ol"));
    }
  });

  it("shows the credit once, under the cards", async () => {
    const root = await settings();
    expect(textOf(root).split(VIDEO_CREDIT)).toHaveLength(2);
    const credit = findAll(root, (n) => n.tag === "p" && textOf(n) === VIDEO_CREDIT);
    expect(credit).toHaveLength(1);
    expect(findAll(findAll(root, (n) => n.tag === "details")[0], (n) => textOf(n).includes(VIDEO_CREDIT) && n.tag === "p")).toHaveLength(0);
  });

  it("negative control: a guide without a video draws no <video>", () => {
    const guide: ForwardingGuide = { ...FORWARDING_GUIDES[0], video: undefined };
    const root = parseHtml(`<div>${renderToStaticMarkup(createElement(GuideCardBody, { guide }))}</div>`);
    expect(findAll(root, (n) => n.tag === "video")).toHaveLength(0);
    const withVideo = parseHtml(`<div>${renderToStaticMarkup(createElement(GuideCardBody, { guide: FORWARDING_GUIDES[0] }))}</div>`);
    expect(findAll(withVideo, (n) => n.tag === "video")).toHaveLength(1);
  });

  it("the Gmail link note is two paragraphs; the Outlook note stays one plain line", () => {
    const note = (id: string) => {
      const guide = FORWARDING_GUIDES.find((g) => g.id === id)!;
      const root = parseHtml(`<div>${renderToStaticMarkup(createElement(GuideCardBody, { guide }))}</div>`);
      return { guide, p: findAll(root, (n) => n.tag === "p" && textOf(n) === guide.linkNote) };
    };
    const gmail = note("gmail");
    expect(gmail.guide.linkNote!.split("\n\n")).toHaveLength(3);
    expect(gmail.p).toHaveLength(1);
    expect(String(gmail.p[0].attrs.class)).toContain("whitespace-pre-line");
    const outlook = note("outlook");
    expect(outlook.guide.linkNote).not.toContain("\n");
    expect(outlook.p).toHaveLength(1);
  });
});
