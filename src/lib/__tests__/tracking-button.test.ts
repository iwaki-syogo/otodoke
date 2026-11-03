import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The Sagawa popup (TrackingButton with a "copy" link). There is no DOM here, so the popup is
 * rendered to HTML with its state forced: `useState(false)` (whether it is open) answers true,
 * and `useState("idle")` (the copy state) answers whatever `copyState` holds.
 */
const forced = vi.hoisted(() => ({ copyState: "idle" as string }));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState: (init: unknown) => {
      const noop = () => {};
      if (init === false) return [true, noop];
      if (init === "idle") return [forced.copyState, noop];
      return [typeof init === "function" ? (init as () => unknown)() : init, noop];
    },
  };
});

const { TrackingButton } = await import("@/app/app/parcels/[id]/tracking-button");

const PAGE_NAME = "テスト運送のお問い合わせページ";
const URL_ = "https://tracking.example.test/input";
const NUMBER = "123456789012";
const SHOWN = "1234-5678-9012";

function popup(copyState: "idle" | "done" | "failed" = "idle"): string {
  forced.copyState = copyState;
  return renderToStaticMarkup(
    createElement(TrackingButton, {
      link: { kind: "copy", url: URL_, pageName: PAGE_NAME },
      number: NUMBER,
      shown: SHOWN,
      carrierName: "テスト運送",
    }),
  );
}

const text = (html: string) => html.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
const stepsOf = (html: string) => html.match(/<ol[\s\S]*<\/ol>/)?.[0] ?? "";
/** What a button reads: its text without the parts hidden from screen readers (a label kept only for width). */
const visible = (html: string) => html.replace(/<span\b[^>]*aria-hidden="true"[^>]*>[\s\S]*?<\/span>/g, "");
const buttonsOf = (html: string) => [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].map((m) => ({ attrs: m[1], label: text(visible(m[2])) }));
const anchorsOf = (html: string) => [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)].map((m) => ({ attrs: m[1], label: text(m[2]) }));

afterEach(() => {
  forced.copyState = "idle";
});

describe("Sagawa popup: each step is a row with a small control on its right", () => {
  it("renders the popup when open (the forced state works)", () => {
    expect(popup()).toContain('role="dialog"');
  });

  it("step 1 shows the number and a small 「コピー」 button", () => {
    const steps = stepsOf(popup());
    expect(steps).toContain(SHOWN);
    expect(buttonsOf(steps).map((b) => b.label)).toContain("コピー");
  });

  it("step 1 says 「コピー ✓」 after copying", () => {
    expect(buttonsOf(stepsOf(popup("done"))).map((b) => b.label)).toContain("コピー ✓");
    expect(popup("done")).not.toContain("コピーしました");
    expect(popup("done")).not.toContain("コピー済み");
  });

  it("step 1 shows the number without extra letter spacing, so 14 characters stay on one line at phone width", () => {
    const number = stepsOf(popup()).match(/<span class="([^"]*)">1234-5678-9012<\/span>/)?.[1] ?? "";
    expect(number).toMatch(/\bfont-mono\b/);
    expect(number).not.toMatch(/\btracking-/);
  });

  it("the controls of steps 1 and 2 share one minimum width and center their labels", () => {
    const steps = stepsOf(popup());
    const copyButton = [...steps.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].find((m) => m[2].includes("コピー"))?.[1] ?? "";
    const openLink = anchorsOf(steps).find((a) => /開く\s*↗/.test(a.label))?.attrs ?? "";
    for (const [name, attrs] of [["copy", copyButton], ["open", openLink]] as const) {
      expect(attrs, name).toMatch(/\bmin-w-20\b/);
      expect(attrs, name).toMatch(/\btext-center\b/);
    }
  });

  it("step 1 keeps the copy button on the number's row at one width before and after copying", () => {
    for (const state of ["idle", "done"] as const) {
      const steps = stepsOf(popup(state));
      const row = steps.match(/<div class="([^"]*)"><span[^>]*>1234-5678-9012<\/span>/)?.[1] ?? "";
      expect(row, state).toMatch(/\bflex\b/);
      expect(row, state).not.toMatch(/\bflex-wrap\b/);
      const copyButton = [...steps.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].find((m) => m[2].includes("コピー"));
      expect(copyButton, state).toBeDefined();
      // Both labels are always rendered in one grid cell, so the width is the wider one's (or the shared minimum).
      expect(copyButton![1], state).toMatch(/\bshrink-0\b/);
      expect(copyButton![1], state).toMatch(/\bwhitespace-nowrap\b/);
      expect(copyButton![1], state).toMatch(/\bgrid\b/);
      expect(text(copyButton![2]), state).toMatch(/^コピー\s*コピー\s*✓$/);
    }
  });

  it("step 1 shows the number large and selectable when copying failed", () => {
    const steps = stepsOf(popup("failed"));
    expect(text(steps)).toContain("長押ししてコピー");
    const selectable = [...steps.matchAll(/<[a-z]+\b[^>]*class="[^"]*\bselect-all\b[^"]*"[^>]*>([\s\S]*?)<\/[a-z]+>/g)].map((m) => text(m[1]));
    expect(selectable).toContain(SHOWN);
  });

  it("step 2 names the carrier's page from link.pageName and opens it with a real link in a new tab", () => {
    const steps = stepsOf(popup());
    expect(text(steps)).toContain(PAGE_NAME);
    const open = anchorsOf(steps).filter((a) => /開く\s*↗/.test(a.label));
    expect(open).toHaveLength(1);
    expect(open[0].attrs).toContain(`href="${URL_}"`);
    expect(open[0].attrs).toContain('target="_blank"');
    expect(open[0].attrs).toContain('rel="noopener noreferrer"');
    // The old full-width filled link read "…に移動".
    expect(text(steps)).not.toContain("に移動");
  });

  it("step 3 tells the user to paste and press 『お問い合わせ開始』", () => {
    expect(text(stepsOf(popup()))).toContain("送り状番号を貼り付けて『お問い合わせ開始』を押す");
  });

  it("has no full-width or filled buttons in the steps", () => {
    for (const state of ["idle", "done"] as const) {
      const steps = stepsOf(popup(state));
      expect(steps, state).not.toMatch(/class="[^"]*\bw-full\b/);
      expect(steps, state).not.toMatch(/class="[^"]*\bbg-sky-600\b/);
    }
  });

  it("still has a close button", () => {
    expect(buttonsOf(popup()).map((b) => b.label)).toContain("閉じる");
  });
});

describe("Sagawa popup: behaviour kept from before", () => {
  const source = readFileSync(path.resolve(__dirname, "../../app/app/parcels/[id]/tracking-button.tsx"), "utf8");

  it("does not write the carrier's page name into the component", () => {
    expect(source).not.toContain("佐川のお荷物お問い合わせサービス");
  });

  it("closes on Escape and on a tap on the backdrop", () => {
    expect(source).toContain('"Escape"');
    expect(source).toMatch(/e\.target\s*===\s*e\.currentTarget/);
  });

  it("copies synchronously first and only then tries the Clipboard API", () => {
    const sync = source.indexOf("copyNow(");
    const api = source.indexOf("navigator.clipboard.writeText");
    expect(sync).toBeGreaterThan(-1);
    expect(api).toBeGreaterThan(sync);
  });

  it("moves focus into the popup when it opens", () => {
    expect(source).toMatch(/\.focus\(\)/);
  });
});
