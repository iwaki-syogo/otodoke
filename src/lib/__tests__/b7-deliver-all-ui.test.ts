import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeEvent, hostText, type Host } from "./element-tree";
import { mount, type Mounted } from "./hook-harness";

const WRITTEN = "2026-11-12T01:00:00.000Z";
type Done = { saved: number; written: { id: string; received_at: string }[] };
const control = vi.hoisted(() => ({ mark: vi.fn(), toast: vi.fn() }));
vi.mock("react", async (original) => {
  const actual = await original<typeof import("react")>();
  const { harnessHooks } = await import("./hook-harness");
  return { ...harnessHooks(actual), useTransition: () => [false, (work: () => unknown) => void work()], useContext: () => control.toast };
});
vi.mock("@/app/app/parcel-actions", () => ({
  markDeliveredForUndo: (...args: unknown[]) => control.mark(...args),
  restoreStatuses: vi.fn(),
}));
const { DeliverAll } = await import("@/app/app/delivered-controls");
const items = [
  { id: "00000000-0000-4000-8000-000000000001", status: "shipped", received_at: null },
  { id: "00000000-0000-4000-8000-000000000002", status: "ordered", received_at: null },
];
const button = (view: Mounted, text: string) => view.host((node) => node.type === "button" && hostText(node).trim() === text);
const press = (node: Host) => (node.props.onClick as (event: unknown) => void)(fakeEvent());
async function confirm(view: Mounted) {
  press(button(view, "すべて受け取り済みにする"));
  // Wait for the confirmation state that the next press will actually use.
  await vi.waitFor(() => expect(view.text()).toContain("やめる"));
  press(button(view, "受け取り済みにする"));
}
async function settled(view: Mounted) {
  await vi.waitFor(() => expect(view.text()).not.toContain("やめる"));
}

beforeEach(() => {
  control.mark.mockReset();
  control.toast.mockReset();
  vi.stubGlobal("fetch", () => { throw new Error("external fetch is forbidden in B7 UI tests"); });
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("B7: DeliverAll reports the full request's actual outcome", () => {
  it("partial saving is visible after the pending answer and offers undo only for confirmed writes", async () => {
    let finish!: (done: Done) => void;
    control.mark.mockImplementation(() => new Promise<Done>((resolve) => { finish = resolve; }));
    const view = mount(() => DeliverAll({ items }));
    await confirm(view);
    expect(view.text()).toContain("やめる");
    expect(control.toast).not.toHaveBeenCalled();
    finish({ saved: 1, written: [{ id: items[0].id, received_at: WRITTEN }] });
    await vi.waitFor(() => expect(view.text()).toContain("保存できなかった荷物があります。開き直してください。"));
    expect(control.toast).toHaveBeenCalledWith({
      text: "一部を保存できませんでした",
      undo: [{ ...items[0], written_at: WRITTEN }],
      note: null,
    });
    expect(control.toast.mock.calls[0][0].text).not.toBe("受け取り済みにしました");
    view.unmount();
  });

  it("duplicate IDs do not turn complete saving into partial saving or duplicate undo entries", async () => {
    control.mark.mockResolvedValue({ saved: 2, written: items.map((item) => ({ id: item.id, received_at: WRITTEN })) });
    const view = mount(() => DeliverAll({ items: [...items, items[0]] }));
    await confirm(view);
    await settled(view);
    expect(view.text()).not.toContain("保存できなかった");
    expect(control.toast).toHaveBeenCalledWith({ text: "受け取り済みにしました", undo: items.map((item) => ({ ...item, written_at: WRITTEN })), note: null });
    view.unmount();
  });

  it("all already received is a complete result with no undo", async () => {
    control.mark.mockResolvedValue({ saved: 2, written: [] });
    const view = mount(() => DeliverAll({ items }));
    await confirm(view);
    await settled(view);
    expect(control.toast).toHaveBeenCalledWith({ text: "受け取り済みにしました", undo: null, note: null });
    view.unmount();
  });

  it("partial saving without a new write says partial and offers no unrelated undo", async () => {
    control.mark.mockResolvedValue({ saved: 1, written: [] });
    const view = mount(() => DeliverAll({ items }));
    await confirm(view);
    await vi.waitFor(() => expect(view.text()).toContain("保存できなかった荷物があります。開き直してください。"));
    expect(control.toast).toHaveBeenCalledWith({ text: "一部を保存できませんでした", undo: null, note: null });
    view.unmount();
  });

  it.each(["nothing", "rejected"])("shows a failed result and no success toast when the server confirms %s", async (failure) => {
    if (failure === "nothing") control.mark.mockResolvedValue({ saved: 0, written: [] });
    else control.mark.mockRejectedValue(new Error("synthetic failure"));
    const view = mount(() => DeliverAll({ items }));
    await confirm(view);
    await vi.waitFor(() => expect(view.text()).toContain("保存できませんでした。もう一度押してください。"));
    expect(control.toast).not.toHaveBeenCalled();
    view.unmount();
  });
});
