import { describe, expect, it, vi } from "vitest";
import { fakeEvent, findHosts, hostText, type Host } from "./element-tree";
import { mount } from "./hook-harness";

/**
 * [Review 2026-11-06 E-11] 「もう一度読み込む」 on the error screens (src/components/error-screen.tsx)
 * calls Next's retry() once from a press and spins with 「読み込んでいます…」 until the page comes
 * back or a new error takes this one's place; then it can be pressed again. Never `disabled`, and
 * the error's own words never show.
 */

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { harnessHooks } = await import("./hook-harness");
  return harnessHooks(actual);
});

const { ErrorScreen } = await import("@/components/error-screen");

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};
const press = (h: Host) => (h.props.onClick as (e: unknown) => void)(fakeEvent({}));

describe("ErrorScreen: 「もう一度読み込む」", () => {
  it("retries once from a press and spins until a new error takes this one's place", async () => {
    const retry = vi.fn();
    let error: unknown = new Error("secret detail");
    const view = mount(() => ErrorScreen({ error, retry, back: { href: "/app", label: "荷物の一覧へ" } }));
    const retryButton = () => view.host((h) => h.type === "button");
    expect(hostText(retryButton())).toBe("もう一度読み込む");
    const first = retryButton();
    press(first);
    press(first);
    expect(retry).toHaveBeenCalledTimes(1);
    await flush();
    expect(hostText(retryButton())).toBe("読み込んでいます…");
    expect(findHosts(view.tree, (h) => String(h.props.className ?? "").includes("animate-spin"))).toHaveLength(1);
    expect(retryButton().props["aria-busy"]).toBe(true);
    expect(retryButton().props.disabled).toBeUndefined();
    // The page failed again: a new error, and the button can be pressed again.
    error = new Error("again");
    view.rerender();
    expect(hostText(retryButton())).toBe("もう一度読み込む");
    press(retryButton());
    expect(retry).toHaveBeenCalledTimes(2);
    expect(view.text()).not.toContain("secret detail");
  });

  it("retries a thrown null or undefined too", async () => {
    for (const error of [null, undefined]) {
      const retry = vi.fn();
      const view = mount(() => ErrorScreen({ error, retry, back: null }));
      press(view.host((h) => h.type === "button"));
      await flush();
      expect(retry).toHaveBeenCalledTimes(1);
      expect(view.text()).toContain("読み込んでいます…");
      expect(findHosts(view.tree, (h) => h.type === "a")).toHaveLength(0);
    }
  });
});
