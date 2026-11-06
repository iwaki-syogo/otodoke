import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeEvent } from "./element-tree";
import { mount } from "./hook-harness";
import { read, SRC, withoutComments } from "./source-scan";
import path from "node:path";

/**
 * R3-PW-13: after the logout, 「戻る」 must not bring back the opened key or the mail opened with it
 * (a browser that keeps the page in its back/forward cache shows it again with its memory).
 *  - 設定's logout forgets the key at the press, and leaves the POST to the browser.
 *  - Under /app, leaving a page forgets the key (pagehide), and a page shown again from that cache
 *    is loaded anew (pageshow, persisted), so the server decides what it shows.
 */

const tab = vi.hoisted(() => ({ forgetTabKey: vi.fn() }));
vi.mock("@/lib/crypto/tab-key", () => ({ forgetTabKey: tab.forgetTabKey, setTabKey: vi.fn(), useTabKey: () => null }));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { harnessHooks } = await import("./hook-harness");
  return harnessHooks(actual);
});

const { TabKeyGuard } = await import("@/app/app/tab-key-guard");
const { LogoutForm } = await import("@/app/app/settings/logout-form");

/** A window that records its listeners, and a reload. */
function fakeWindow() {
  const listeners = new Map<string, Set<(e: unknown) => void>>();
  const reload = vi.fn();
  return {
    reload,
    listeners,
    fire: (type: string, event: unknown = {}) => {
      for (const l of listeners.get(type) ?? []) l(event);
    },
    window: {
      addEventListener: (type: string, l: (e: unknown) => void) => listeners.set(type, (listeners.get(type) ?? new Set()).add(l)),
      removeEventListener: (type: string, l: (e: unknown) => void) => listeners.get(type)?.delete(l),
      location: { reload },
    },
  };
}

let win: ReturnType<typeof fakeWindow>;
beforeEach(() => {
  tab.forgetTabKey.mockReset();
  win = fakeWindow();
  vi.stubGlobal("window", win.window);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("under /app, a page left or shown again from the back/forward cache", () => {
  it("leaving the page forgets the key", () => {
    mount(() => TabKeyGuard());
    expect(tab.forgetTabKey).not.toHaveBeenCalled();
    win.fire("pagehide", { persisted: true });
    expect(tab.forgetTabKey).toHaveBeenCalledTimes(1);
  });

  it("a page shown again from that cache is loaded anew; one loaded as usual is not", () => {
    mount(() => TabKeyGuard());
    win.fire("pageshow", { persisted: false });
    expect(win.reload).not.toHaveBeenCalled();
    win.fire("pageshow", { persisted: true });
    expect(win.reload).toHaveBeenCalledTimes(1);
  });

  it("the listeners go when the guard does", () => {
    const view = mount(() => TabKeyGuard());
    view.unmount();
    win.fire("pagehide");
    win.fire("pageshow", { persisted: true });
    expect(tab.forgetTabKey).not.toHaveBeenCalled();
    expect(win.reload).not.toHaveBeenCalled();
  });

  it("every page of /app has the guard (the app's layout draws it)", () => {
    const layout = withoutComments(read(path.join(SRC, "app/app/layout.tsx")));
    expect(layout).toContain('import { TabKeyGuard } from "./tab-key-guard";');
    expect(layout).toContain("<TabKeyGuard />");
  });
});

describe("設定's logout", () => {
  it("forgets the key at the press, and lets the browser post the form (nothing prevented)", () => {
    const form = LogoutForm() as unknown as { type: string; props: { action: string; method: string; onSubmit: (e: unknown) => void } };
    expect(form.type).toBe("form");
    expect(form.props).toMatchObject({ action: "/auth/signout", method: "post" });
    const event = fakeEvent();
    form.props.onSubmit(event);
    expect(tab.forgetTabKey).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(false);
  });
});
