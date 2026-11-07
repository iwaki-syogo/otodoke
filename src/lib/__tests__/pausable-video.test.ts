import { describe, expect, it, vi } from "vitest";
import { mount } from "./hook-harness";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { harnessHooks } = await import("./hook-harness");
  return harnessHooks(actual);
});

const { PausableVideo } = await import("@/components/pausable-video");

/** The card's <details> closing pauses the video inside; outside a <details> nothing is listened to. */
function fakeDetails() {
  const handlers: Array<() => void> = [];
  return {
    open: true,
    handlers,
    addEventListener: (type: string, fn: () => void) => type === "toggle" && handlers.push(fn),
    removeEventListener: (type: string, fn: () => void) => void handlers.splice(handlers.indexOf(fn) >>> 0, type === "toggle" ? 1 : 0),
  };
}

describe("PausableVideo", () => {
  it("pauses when the details around it is closed, not while it is open", () => {
    const details = fakeDetails();
    const pause = vi.fn();
    const view = mount(() => PausableVideo({ controls: true }), () => ({ pause, closest: (sel: string) => (sel === "details" ? details : null) }));
    details.handlers.forEach((h) => h());
    expect(pause).not.toHaveBeenCalled();
    details.open = false;
    details.handlers.forEach((h) => h());
    expect(pause).toHaveBeenCalledTimes(1);
    view.unmount();
    expect(details.handlers).toHaveLength(0);
  });

  it("outside a details it does nothing", () => {
    const pause = vi.fn();
    const view = mount(() => PausableVideo({}), () => ({ pause, closest: () => null }));
    expect(pause).not.toHaveBeenCalled();
    view.unmount();
  });
});
