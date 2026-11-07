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
let extra: Array<[string, () => void]>; // window focus + document pointerdown / keydown
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
  extra = [];
  vi.stubGlobal("window", {
    addEventListener: (type: string, fn: () => void) => extra.push(["w:" + type, fn]),
    removeEventListener: (type: string, fn: () => void) => void (extra = extra.filter(([t, f]) => !(t === "w:" + type && f === fn))),
  });
  vi.stubGlobal("document", {
    get visibilityState() {
      return visibility;
    },
    addEventListener: (type: string, fn: () => void) => (type === "visibilitychange" ? listeners.push(fn) : extra.push(["d:" + type, fn])),
    removeEventListener: (type: string, fn: () => void) => {
      if (type === "visibilitychange") listeners = listeners.filter((l) => l !== fn);
      else extra = extra.filter(([t, f]) => !(t === "d:" + type && f === fn));
    },
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const fire = (type: string) => extra.filter(([t]) => t === type).forEach(([, f]) => f());
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

  it("a window focus after it stopped starts it again and refreshes once (not within 10 s of the last)", () => {
    const view = mount(() => RefreshUntilApproval());
    s(400);
    const stopped = refresh.mock.calls.length;
    s(100);
    expect(refresh).toHaveBeenCalledTimes(stopped);
    fire("w:focus");
    expect(refresh).toHaveBeenCalledTimes(stopped + 1);
    s(20);
    expect(refresh).toHaveBeenCalledTimes(stopped + 2);
    fire("w:focus"); // 0 s after the last refresh
    expect(refresh).toHaveBeenCalledTimes(stopped + 2);
    view.unmount();
  });

  it("a pointerdown or a keydown after it stopped starts it again but does not refresh at once", () => {
    for (const type of ["d:pointerdown", "d:keydown"]) {
      refresh.mockReset();
      const view = mount(() => RefreshUntilApproval());
      s(400);
      const stopped = refresh.mock.calls.length;
      fire(type);
      expect(refresh).toHaveBeenCalledTimes(stopped);
      s(20);
      expect(refresh).toHaveBeenCalledTimes(stopped + 1);
      view.unmount();
    }
  });

  it("a pointerdown while it is running does not restart the 20 s clock", () => {
    const view = mount(() => RefreshUntilApproval());
    s(15);
    fire("d:pointerdown");
    s(5);
    expect(refresh).toHaveBeenCalledTimes(1);
    view.unmount();
  });

  it("stops and removes its listeners on unmount", () => {
    const view = mount(() => RefreshUntilApproval());
    expect(listeners).toHaveLength(1);
    expect(extra.map(([t]) => t).sort()).toEqual(["d:keydown", "d:pointerdown", "w:focus"]);
    view.unmount();
    expect(listeners).toHaveLength(0);
    expect(extra).toHaveLength(0);
    s(120);
    expect(refresh).not.toHaveBeenCalled();
  });
});
