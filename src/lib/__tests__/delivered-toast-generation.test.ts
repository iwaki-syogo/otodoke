import { createElement, type ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CANNOT_UNDO_NOTE, UNDO_CHANGED_NOTICE, UNDO_FAILED_NOTICE, UNDO_UNCONFIRMED_NOTICE } from "@/lib/format";
import type { MarkReceivedResult, ReceivedReceipt, RestoreResult } from "@/lib/receipt";
import { fakeEvent, hostText, type Host } from "./element-tree";
import { mount, type Mounted } from "./hook-harness";

type Toast = { text: string; undo: ReceivedReceipt[] | null; note?: string | null };
type Outcome = "restored" | "failed" | "changed" | "mixed" | "throw";
// Real components/helpers, with hook scheduling, context and Server Action replies controlled
// by the existing harness. This does not model React DOM commits, RSC or Next's action queue.
const ctl = vi.hoisted(() => ({
  publish: null as null | ((toast: Toast) => void),
  context: null as unknown,
  mark: vi.fn(),
  restore: vi.fn(),
  transitionErrors: [] as unknown[],
}));

vi.mock("react", async (original) => {
  const actual = await original<typeof import("react")>();
  const { harnessHooks } = await import("./hook-harness");
  const hooks = harnessHooks(actual);
  return {
    ...hooks,
    // Each mounted component owns its pending cell; callbacks settle in the chosen order.
    useTransition: () => {
      const [pending, setPending] = hooks.useState(false);
      const inFlight = hooks.useRef(0);
      return [pending, (work: () => unknown) => {
        inFlight.current += 1;
        setPending(true);
        const finish = () => { inFlight.current -= 1; setPending(inFlight.current > 0); };
        try {
          void Promise.resolve(work()).then(finish, (error) => { ctl.transitionErrors.push(error); finish(); });
        } catch (error) { ctl.transitionErrors.push(error); finish(); }
      }];
    },
    useContext: (context: unknown) => {
      const provider = ctl.context as { _context?: unknown } | null;
      if (context !== provider && context !== provider?._context) throw new Error("unexpected context");
      return (toast: Toast) => {
        if (!ctl.publish) throw new Error("toast provider is not mounted");
        ctl.publish(toast);
      };
    },
  };
});
vi.mock("react-dom", () => ({ useFormStatus: () => ({ pending: false, data: null, method: null, action: null }) }));
vi.mock("@/app/app/parcel-actions", () => ({
  markDeliveredForUndo: (...args: unknown[]) => ctl.mark(...args),
  restoreStatuses: (...args: unknown[]) => ctl.restore(...args),
}));

const { DeliveredToastProvider, SwipeToDeliver, DeliverAll } = await import("@/app/app/delivered-controls");
const A = [1, 2, 3].map((n) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`);
const A_UNSAVED = "10000000-0000-4000-8000-000000000004";
const B = [1, 2, 3].map((n) => `20000000-0000-4000-8000-${String(n).padStart(12, "0")}`);
const views: Mounted[] = [];
const receipt = (id: string): ReceivedReceipt => ({
  id, receipt_id: `receipt-${id}`, received_at: "2026-11-12T01:00:00.000Z",
  updated_at: "2026-11-12T01:00:00.123456Z", previous_status: "shipped", previous_received_at: null,
});
const key = ({ id, receipt_id }: ReceivedReceipt) => ({ id, receipt_id });
const button = (view: Mounted, text: string) => view.host((host) => host.type === "button" && hostText(host).trim() === text);
const press = (host: Host) => (host.props.onClick as (event: unknown) => void)(fakeEvent());
const notices = (view: Mounted) => view.hosts((host) => host.props.role === "status");
const surface = (view: Mounted) => view.host((host) => typeof host.props.onPointerDown === "function");
const keep = (view: Mounted) => { views.push(view); return view; };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

// The harness redraws on microtasks. Wait for the next rendered control, never a mock call.
async function shown(predicate: () => boolean, reason: string) {
  for (let i = 0; i < 100; i += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error(`harness did not render: ${reason}`);
}

function provider() {
  return keep(mount(() => {
    const node = DeliveredToastProvider({ children: null }) as ReactElement<{ value: (toast: Toast) => void }>;
    ctl.publish = node.props.value;
    ctl.context = node.type;
    return node;
  }));
}

async function startSwipe(id: string) {
  const view = keep(mount(() => SwipeToDeliver({ id, status: "shipped", children: createElement("a", { href: `/app/parcels/${id}` }, "Synthetic parcel") })));
  (surface(view).props.onPointerDown as (event: unknown) => void)({ clientX: 300, clientY: 20 });
  (surface(view).props.onPointerMove as (event: unknown) => void)({ clientX: 150, clientY: 20 });
  await shown(() => (surface(view).props.style as { transform: string }).transform === "translateX(-150px)", "swipe reveal");
  (surface(view).props.onPointerUp as () => void)();
  await shown(() => view.text().includes("保存しています…"), "swipe saving");
  return view;
}

async function startAll(ids: string[]) {
  const view = keep(mount(() => DeliverAll({ items: ids.map((id) => ({ id, status: "shipped", received_at: null })) })));
  press(button(view, "すべて受け取り済みにする"));
  await shown(() => view.text().includes("やめる"), "full-list confirmation");
  press(button(view, "受け取り済みにする"));
  await shown(() => view.text().includes("保存しています…"), "full-list saving");
  return view;
}

function answer(outcome: Outcome, ids = A): RestoreResult {
  if (outcome === "mixed") return { restored: [ids[0]], changed: [ids[1]], failed: [ids[2]] };
  return { restored: outcome === "restored" ? ids : [], changed: outcome === "changed" ? ids : [], failed: outcome === "failed" ? ids : [] };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.setSystemTime(new Date("2026-11-12T01:00:00.000Z"));
  vi.stubGlobal("fetch", () => { throw new Error("external fetch is forbidden in toast tests"); });
  ctl.publish = null;
  ctl.context = null;
  ctl.transitionErrors.length = 0;
  ctl.mark.mockReset();
  ctl.restore.mockReset();
});
afterEach(() => {
  for (const view of views.splice(0)) view.unmount();
  vi.restoreAllMocks();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  expect(ctl.transitionErrors).toEqual([]);
});

describe("receipt toast generations under controlled reply order", () => {
  describe.each(["swipe", "full-list"] as const)("B is saved by %s", (writer) => {
    it.each(["restored", "failed", "changed", "mixed", "throw"] as const)("a late A undo %s keeps B's notice and B-only undo", async (outcome) => {
      const markB = deferred<MarkReceivedResult>();
      const undoA = deferred<RestoreResult>();
      const writtenB = [receipt(B[0])];
      const expectedText = writer === "swipe" ? "受け取り済みにしました" : "一部を保存できませんでした";
      ctl.mark.mockImplementation((ids: string[]) => ids[0] === A[0]
        ? Promise.resolve({ saved: A.length, written: A.map(receipt) }) : markB.promise);
      ctl.restore.mockImplementation((items: { id: string }[]) => items[0].id === A[0]
        ? undoA.promise : Promise.resolve({ restored: [B[0]], changed: [], failed: [] }));
      const toast = provider();
      await startAll([...A, A_UNSAVED]);
      await shown(() => toast.text().includes("元に戻す"), "A's undo notice");
      const savingB = writer === "swipe" ? await startSwipe(B[0]) : await startAll(B);
      press(button(toast, "元に戻す"));
      await shown(() => toast.text().includes("戻しています…"), "A undo pending while B saves");
      expect(savingB.text()).toContain("保存しています…");
      markB.resolve({ saved: writer === "swipe" ? 1 : 2, written: writtenB });
      await shown(() => toast.text().includes(expectedText) && (writer === "swipe" || toast.text().includes(CANNOT_UNDO_NOTE)), "B's new notice after saving");
      expect(button(toast, "戻しています…").props["aria-busy"]).toBe(true);
      expect(ctl.restore.mock.calls[0][0]).toEqual(A.map(receipt).map(key));
      if (outcome === "throw") undoA.reject(new Error("synthetic undo failure"));
      else undoA.resolve(answer(outcome));
      await shown(() => !toast.text().includes("戻しています…"), "A undo settled");

      expect(notices(toast)).toHaveLength(1);
      expect(toast.text()).toContain(expectedText);
      expect(toast.text()).not.toContain(UNDO_FAILED_NOTICE);
      expect(toast.text()).not.toContain(UNDO_CHANGED_NOTICE);
      if (writer === "full-list") expect(toast.text()).toContain(CANNOT_UNDO_NOTE);
      expect(button(toast, "元に戻す").props["aria-busy"]).toBeUndefined();
      expect(button(toast, "元に戻す").props["aria-disabled"]).toBeUndefined();

      press(button(toast, "元に戻す"));
      await shown(() => notices(toast).length === 0, "B's own undo clears B's notice");
      expect(ctl.restore.mock.calls.map(([items]) => items)).toEqual([A.map(receipt).map(key), writtenB.map(key)]);
    });
  });

  it.each(["restored", "failed", "changed", "mixed", "throw"] as const)("the current A undo still reports %s normally", async (outcome) => {
    ctl.mark.mockResolvedValue({ saved: A.length, written: A.map(receipt) });
    const undoA = deferred<RestoreResult>();
    ctl.restore.mockReturnValue(undoA.promise);
    const toast = provider();
    await startAll(A);
    await shown(() => toast.text().includes("元に戻す"), "A's undo notice");
    press(button(toast, "元に戻す"));
    await shown(() => toast.text().includes("戻しています…"), "A pending undo");
    if (outcome === "throw") undoA.reject(new Error("synthetic undo failure"));
    else undoA.resolve(answer(outcome));
    await shown(() => !toast.text().includes("戻しています…"), "A's own result");
    if (outcome === "restored") expect(notices(toast)).toHaveLength(0);
    else {
      if (outcome === "throw") {
        expect(toast.text()).not.toContain(UNDO_FAILED_NOTICE);
        expect(toast.text()).toContain(UNDO_UNCONFIRMED_NOTICE);
      } else expect(toast.text()).toContain(outcome === "changed" ? UNDO_CHANGED_NOTICE : UNDO_FAILED_NOTICE);
      if (outcome === "mixed") expect(toast.text()).toContain(UNDO_CHANGED_NOTICE);
      expect(toast.hosts((host) => host.type === "button")).toHaveLength(0);
    }
    expect(ctl.restore).toHaveBeenCalledWith(A.map(receipt).map(key));
  });

  it("an old queued close callback cannot dismiss a newer B notice", async () => {
    const timers = vi.spyOn(globalThis, "setTimeout");
    ctl.mark.mockImplementation(async (ids: string[]) => ids[0] === A[0]
      ? { saved: A.length, written: A.map(receipt) } : { saved: ids.length, written: ids.map(receipt) });
    const toast = provider();
    await startAll([...A, A_UNSAVED]);
    await shown(() => toast.text().includes("元に戻す"), "A's notice");
    const oldClose = timers.mock.calls.find(([, delay]) => delay === 6000)?.[0];
    expect(oldClose).toBeTypeOf("function");
    await vi.advanceTimersByTimeAsync(4000);
    await startSwipe(B[0]);
    await shown(() => toast.text().includes("受け取り済みにしました"), "B's notice");
    // Model a callback already queued when its cleanup runs, beyond clearTimeout's control.
    (oldClose as () => void)();
    await Promise.resolve();
    expect(notices(toast)).toHaveLength(1);
    expect(toast.text()).toContain("元に戻す");
    await vi.advanceTimersByTimeAsync(2001);
    expect(notices(toast)).toHaveLength(1);
    ctl.restore.mockResolvedValue({ restored: [B[0]], changed: [], failed: [] });
    press(button(toast, "元に戻す"));
    await shown(() => notices(toast).length === 0, "B undo after A's old deadline");
    expect(ctl.restore).toHaveBeenCalledWith([key(receipt(B[0]))]);
  });

  it("the current notice still closes at its own six-second deadline", async () => {
    ctl.mark.mockResolvedValue({ saved: 1, written: [receipt(A[0])] });
    const toast = provider();
    await startSwipe(A[0]);
    await shown(() => toast.text().includes("元に戻す"), "the current notice");
    await vi.advanceTimersByTimeAsync(5999);
    expect(notices(toast)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(notices(toast)).toHaveLength(0);
  });
});
