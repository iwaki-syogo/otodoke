import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { findAll, hasClasses, parseHtml, textOf } from "./html-tree";

/**
 * /app's loading screen stands in for a moment while any page under /app is on its way, before that
 * page's own. On the way to the first-run guide it draws the guide's frame, not the parcel list's:
 * the list is never shown, even in grey, before the guide (onboarding-wording.md, screen 3).
 */

const at = vi.hoisted(() => ({ path: "/app/welcome" }));
vi.mock("next/navigation", () => ({ usePathname: () => at.path }));

const Loading = (await import("@/app/app/loading")).default;
const draw = () => parseHtml(renderToStaticMarkup(createElement(Loading)));
const cards = (root: ReturnType<typeof parseHtml>) => findAll(root, (n) => hasClasses(n, "rounded-2xl", "border", "bg-white", "p-4"));

describe("/app's loading screen", () => {
  it("on the way to /app/welcome: the guide's heading and frame, no parcel card", () => {
    at.path = "/app/welcome";
    const root = draw();
    expect(findAll(root, (n) => n.tag === "h1").map(textOf)).toEqual(["最後に、メールの自動転送を設定しますか？"]);
    expect(cards(root)).toHaveLength(0);
    expect(findAll(root, (n) => n.attrs.role === "status")).toHaveLength(1);
  });

  it("negative control: on the way to the list (or another page), the list's frame as before", () => {
    for (const path of ["/app", "/app/calendar", "/app/welcomeback"]) {
      at.path = path;
      const root = draw();
      expect(cards(root)).toHaveLength(5);
      expect(findAll(root, (n) => n.tag === "h1")).toHaveLength(0);
    }
  });
});
