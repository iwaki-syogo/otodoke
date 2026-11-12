import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { PARTLY_RESTORED_NOTICE, UNDO_CHANGED_NOTICE, UNDO_FAILED_NOTICE } from "@/lib/format";
import type { ReceivedReceipt } from "@/lib/receipt";
import { fakeEvent, hostText, type Host } from "./element-tree";
import { mount, type Mounted } from "./hook-harness";

const ctl = vi.hoisted(() => ({ mark: vi.fn(), restore: vi.fn(), toast: vi.fn(), publish: (value: unknown) => { void value; } }));
vi.mock("react", async (original) => {
  const actual = await original<typeof import("react")>();
  const { harnessHooks } = await import("./hook-harness");
  return { ...harnessHooks(actual), useContext: () => ctl.toast, useTransition: () => [false, (work: () => unknown) => void work()],
    createContext: (initial: unknown) => {
      const context = actual.createContext(initial);
      Object.defineProperty(context, "Provider", { value: ({ value, children }: { value: typeof ctl.publish; children: unknown }) => {
        ctl.publish = value;
        return children;
      } });
      return context;
    },
  };
});
vi.mock("@/app/app/parcel-actions", () => ({
  markDeliveredForUndo: (...args: unknown[]) => ctl.mark(...args),
  restoreStatuses: (...args: unknown[]) => ctl.restore(...args),
}));
const { DeliveredToastProvider, SwipeToDeliver, DeliverAll } = await import("@/app/app/delivered-controls");
const received = (id: string): ReceivedReceipt => ({ id, receipt_id: `receipt-${id}`, received_at: "2026-11-12T01:00:00.000Z",
  updated_at: "2026-11-12T01:00:00.123456Z", previous_status: "delivered", previous_received_at: null });
const button = (view: Mounted, text: string) => view.host((node) => node.type === "button" && hostText(node).trim() === text);
const press = (node: Host) => (node.props.onClick as (event: unknown) => void)(fakeEvent());
const key = (receipt: ReceivedReceipt) => ({ id: receipt.id, receipt_id: receipt.receipt_id });

beforeEach(() => { ctl.mark.mockReset(); ctl.restore.mockReset(); ctl.toast.mockReset(); });
afterEach(() => { vi.useRealTimers(); });

describe("B-2 received UI uses server receipts and truthful undo outcomes", () => {
  it("a swipe keeps the server's actual prior state rather than the old card props", async () => {
    const receipt = received("one");
    ctl.mark.mockResolvedValue({ saved: 1, written: [receipt] });
    let props = { id: "one", status: "shipped", receivedAt: null as string | null, children: "old card" };
    const view = mount(() => SwipeToDeliver(props));
    ctl.toast.mockImplementation(() => {
      props = { ...props, status: "delivered", receivedAt: receipt.received_at, children: "server refreshed" };
      view.rerender();
    });
    press(button(view, "受け取った"));
    await vi.waitFor(() => expect(view.text()).toContain("server refreshed"));
    expect(ctl.toast.mock.calls[0][0].undo).toEqual([receipt]);
    expect(ctl.toast.mock.calls[0][0].undo[0].previous_status).toBe("delivered");
    expect(ctl.toast.mock.calls[0][0].undo[0]).not.toHaveProperty("written_at");
    view.unmount();
  });

  it("the full-list press keeps every returned receipt after new server props remove the cards", async () => {
    const receipt = received("one");
    ctl.mark.mockResolvedValue({ saved: 1, written: [receipt] });
    let items = [{ id: "one", status: "shipped", received_at: null }];
    const view = mount(() => DeliverAll({ items }));
    press(button(view, "すべて受け取り済みにする"));
    await vi.waitFor(() => expect(view.text()).toContain("やめる"));
    press(button(view, "受け取り済みにする"));
    await vi.waitFor(() => expect(view.text()).not.toContain("やめる"));
    items = [];
    view.rerender();
    await vi.waitFor(() => expect(view.text()).toContain("すべて受け取り済みにする"));
    expect(ctl.toast.mock.calls[0][0].undo).toEqual([receipt]);
    view.unmount();
  });

  it.each(["changed", "failed", "mixed", "restored"] as const)("the toast reports %s and sends only opaque receipt keys", async (kind) => {
    const receipts = [received("one"), received("two")];
    const result = kind === "changed" ? { restored: ["one"], changed: ["two"], failed: [] }
      : kind === "failed" ? { restored: [], changed: [], failed: ["one", "two"] }
      : kind === "mixed" ? { restored: [], changed: ["one"], failed: ["two"] }
      : { restored: ["one", "two"], changed: [], failed: [] };
    ctl.restore.mockResolvedValue(result);
    const view = mount(() => DeliveredToastProvider({ children: null }));
    ctl.publish({ text: "受け取り済みにしました", undo: receipts });
    await vi.waitFor(() => expect(view.text()).toContain("元に戻す"));
    press(button(view, "元に戻す"));
    if (kind === "restored") await vi.waitFor(() => expect(view.hosts((node) => node.props.role === "status").length).toBe(0));
    else {
      const expected = kind === "changed" ? UNDO_CHANGED_NOTICE : UNDO_FAILED_NOTICE;
      await vi.waitFor(() => expect(view.text()).toContain(expected));
      if (kind === "mixed") expect(view.text()).toContain(UNDO_CHANGED_NOTICE);
      expect(view.text()).not.toContain(PARTLY_RESTORED_NOTICE);
      expect(view.text()).not.toContain("受け取り済みのまま");
      expect(view.hosts((node) => node.type === "button")).toHaveLength(0);
    }
    expect(ctl.restore).toHaveBeenCalledWith(receipts.map(key));
    view.unmount();
  });
});
