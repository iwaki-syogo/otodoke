import { afterEach, describe, expect, it, vi } from "vitest";
import { mount } from "./hook-harness";

/**
 * [Review 2026-11-06 F-2] /app/settings#demo first draws the loading screen, where #demo is not
 * yet: Next finds no target then and drops the scroll (layout-router's InnerScrollHandler). The
 * loading screen's ScrollToHashOnReady scrolls to the fragment once the page has replaced it.
 */

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { harnessHooks } = await import("./hook-harness");
  return harnessHooks(actual);
});

const { ScrollToHashOnReady } = await import("@/components/scroll-to-hash");

afterEach(() => {
  vi.unstubAllGlobals();
});

function page(hash: string) {
  const demo = { scrollIntoView: vi.fn() };
  vi.stubGlobal("window", { location: { hash } });
  vi.stubGlobal("document", { getElementById: vi.fn((id: string) => (id === "demo" ? demo : null)) });
  return demo;
}

describe("ScrollToHashOnReady", () => {
  it("scrolls to the #fragment when the page replaces the loading screen, not before", () => {
    const demo = page("#demo");
    const view = mount(() => ScrollToHashOnReady());
    expect(view.tree).toEqual([]);
    expect(demo.scrollIntoView).not.toHaveBeenCalled();
    view.unmount();
    expect(demo.scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it.each(["", "#", "#nothing", "#%E0%A4%A"])("does nothing for the hash %j (none, empty, no such element, does not decode)", (hash) => {
    const demo = page(hash);
    const view = mount(() => ScrollToHashOnReady());
    expect(() => view.unmount()).not.toThrow();
    expect(demo.scrollIntoView).not.toHaveBeenCalled();
  });
});
