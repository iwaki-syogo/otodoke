import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "./hook-harness";

/** RefreshUntilApproval: router.refresh() while visible, every 20 s, for 5 minutes after the last return. */

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { harnessHooks } = await import("./hook-harness");
  return harnessHooks(actual);
});

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

const { RefreshUntilApproval } = await import("@/components/refresh-until-approval");

let visibility: "visible" | "hidden";
let listeners: Array<() => void>;
const setVisibility = (v: "visible" | "hidden") => {
  visibility = v;
  for (const l of [...listeners]) l();
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  refresh.mockReset();
  visibility = "visible";
  listeners = [];
  vi.stubGlobal("document", {
    get visibilityState() {
      return visibility;
    },
    addEventListener: (type: string, fn: () => void) => type === "visibilitychange" && listeners.push(fn),
    removeEventListener: (type: string, fn: () => void) => {
      if (type === "visibilitychange") listeners = listeners.filter((l) => l !== fn);
    },
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const s = (n: number) => vi.advanceTimersByTime(n * 1000);

describe("RefreshUntilApproval", () => {
  it("draws nothing", () => {
    const view = mount(() => RefreshUntilApproval());
    expect(view.tree).toEqual([]);
    view.unmount();
  });

  it("refreshes every 20 s while visible, and stops after 5 minutes", () => {
    const view = mount(() => RefreshUntilApproval());
    s(19);
    expect(refresh).not.toHaveBeenCalled();
    s(1);
    expect(refresh).toHaveBeenCalledTimes(1);
    s(280);
    expect(refresh).toHaveBeenCalledTimes(14); // 20 s ... 280 s
    s(600);
    expect(refresh).toHaveBeenCalledTimes(14);
    view.unmount();
  });

  it("does not refresh while hidden, and refreshes once on coming back (not within 10 s of the last)", () => {
    const view = mount(() => RefreshUntilApproval());
    s(20);
    expect(refresh).toHaveBeenCalledTimes(1);
    setVisibility("hidden");
    s(120);
    expect(refresh).toHaveBeenCalledTimes(1);
    setVisibility("visible");
    expect(refresh).toHaveBeenCalledTimes(2);
    setVisibility("hidden");
    s(5);
    setVisibility("visible"); // 5 s after the last refresh
    expect(refresh).toHaveBeenCalledTimes(2);
    view.unmount();
  });

  it("starts again 5 minutes after it stopped, when the person comes back", () => {
    const view = mount(() => RefreshUntilApproval());
    s(400);
    const stopped = refresh.mock.calls.length;
    setVisibility("hidden");
    setVisibility("visible");
    expect(refresh).toHaveBeenCalledTimes(stopped + 1);
    s(20);
    expect(refresh).toHaveBeenCalledTimes(stopped + 2);
    view.unmount();
  });

  it("stops and removes its listener on unmount", () => {
    const view = mount(() => RefreshUntilApproval());
    expect(listeners).toHaveLength(1);
    view.unmount();
    expect(listeners).toHaveLength(0);
    s(120);
    expect(refresh).not.toHaveBeenCalled();
  });
});
