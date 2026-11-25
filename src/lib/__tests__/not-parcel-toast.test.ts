import { type ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EXCLUDED_TOAST, EXCLUDED_TOAST_AUTO, EXCLUDE_BUTTON_LABEL, EXCLUDE_FAILED, RESTORED_RULE_TOAST, RESTORED_TOAST, RESTORE_BUTTON_LABEL, RESTORE_FAILED } from "@/lib/not-parcel-text";
import { fakeEvent, hostText, type Host } from "./element-tree";
import { mount, type Mounted } from "./hook-harness";

/**
 * The Web side of 「これは荷物ではありません」, at the controls (real components, hooks driven by the harness):
 * - the button on the parcel page: ok moves to /app?excluded=<id>; a refusal stays and says so;
 * - the notice on the list: shown once for 6000 ms with 元に戻す, and the query is taken off the address;
 * - 元に戻す: the success sentence, a failure sentence that is not the taking-out one, and a second press that
 *   cannot start a second request;
 * - 一覧に戻す on 外した荷物.
 */

type Toast = { text: string; undo: unknown; exclusion?: string | null };
const ID = "10000000-0000-4000-8000-000000000001";
const ctl = vi.hoisted(() => ({
  publish: null as null | ((toast: unknown) => void),
  context: null as unknown,
  replace: vi.fn(),
  exclude: vi.fn(),
  restoreExcluded: vi.fn(),
  seen: vi.fn(),
  query: "",
  transitionErrors: [] as unknown[],
}));

vi.mock("react", async (original) => {
  const actual = await original<typeof import("react")>();
  const { harnessHooks } = await import("./hook-harness");
  const hooks = harnessHooks(actual);
  return {
    ...hooks,
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
      return (toast: unknown) => {
        if (!ctl.publish) throw new Error("toast provider is not mounted");
        ctl.publish(toast);
      };
    },
  };
});
vi.mock("react-dom", () => ({ useFormStatus: () => ({ pending: false, data: null, method: null, action: null }) }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: ctl.replace, push: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(ctl.query),
}));
vi.mock("@/app/app/parcel-actions", () => ({
  markDeliveredForUndo: vi.fn(),
  restoreStatuses: vi.fn(),
  excludeParcel: (...args: unknown[]) => ctl.exclude(...args),
  restoreExcluded: (...args: unknown[]) => ctl.restoreExcluded(...args),
  markAutoExcludedSeen: (...args: unknown[]) => ctl.seen(...args),
}));

const { DeliveredToastProvider, ExcludedToast } = await import("@/app/app/delivered-controls");
const { NotParcelButton } = await import("@/app/app/parcels/[id]/not-parcel-button");
const { RestoreExcludedButton } = await import("@/app/app/excluded/restore-button");
const { RestoreWithNotice } = await import("@/app/app/excluded/restore-with-notice");
const { MarkAutoSeen } = await import("@/app/app/excluded/mark-auto-seen");

const views: Mounted[] = [];
const keep = (view: Mounted) => { views.push(view); return view; };
const button = (view: Mounted, text: string) => view.host((host) => host.type === "button" && hostText(host).trim() === text);
const press = (host: Host) => (host.props.onClick as (event: unknown) => void)(fakeEvent());
const notices = (view: Mounted) => view.hosts((host) => host.props.role === "status");
const alerts = (view: Mounted) => view.hosts((host) => host.props.role === "alert");

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}

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
    ctl.publish = node.props.value as (toast: unknown) => void;
    ctl.context = node.type;
    return node;
  }));
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  ctl.publish = null;
  ctl.context = null;
  ctl.transitionErrors.length = 0;
  ctl.replace.mockReset();
  ctl.exclude.mockReset();
  ctl.restoreExcluded.mockReset();
  ctl.seen.mockReset();
  ctl.seen.mockResolvedValue({ ok: true });
  ctl.query = "";
});
afterEach(() => {
  for (const view of views.splice(0)) view.unmount();
  vi.clearAllTimers();
  vi.useRealTimers();
  expect(ctl.transitionErrors).toEqual([]);
});

describe("the button on the parcel page", () => {
  it("says 「外す」 and, on ok, moves to the list with the id in the query", async () => {
    ctl.exclude.mockResolvedValue({ ok: true });
    const view = keep(mount(() => NotParcelButton({ id: ID })));
    expect(button(view, EXCLUDE_BUTTON_LABEL)).toBeDefined();
    press(button(view, EXCLUDE_BUTTON_LABEL));
    await shown(() => ctl.replace.mock.calls.length === 1, "move to the list");
    expect(ctl.exclude).toHaveBeenCalledWith(ID);
    expect(ctl.replace).toHaveBeenCalledWith(`/app?excluded=${ID}`);
    expect(alerts(view)).toHaveLength(0);
  });

  it.each(["refused", "thrown"] as const)("a %s answer stays on the page and says the taking-out sentence (negative control)", async (kind) => {
    if (kind === "refused") ctl.exclude.mockResolvedValue({ ok: false, error: EXCLUDE_FAILED });
    else ctl.exclude.mockRejectedValue(new Error("network"));
    const view = keep(mount(() => NotParcelButton({ id: ID })));
    press(button(view, EXCLUDE_BUTTON_LABEL));
    await shown(() => alerts(view).length === 1, "failure sentence");
    expect(view.text()).toContain(EXCLUDE_FAILED);
    expect(ctl.replace).not.toHaveBeenCalled();
  });
});

describe("the notice on the list", () => {
  it("shows the taking-out sentence with 元に戻す, takes the query off once, and goes after 6000 ms", async () => {
    const toast = provider();
    keep(mount(() => ExcludedToast({ id: ID })));
    await shown(() => toast.text().includes(EXCLUDED_TOAST), "notice");
    expect(button(toast, "元に戻す")).toBeDefined();
    expect(ctl.replace).toHaveBeenCalledTimes(1);
    expect(ctl.replace).toHaveBeenCalledWith("/app");
    await vi.advanceTimersByTimeAsync(5999);
    expect(notices(toast)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await shown(() => notices(toast).length === 0, "notice closed");
  });

  it("is drawn once however often the control renders again (back, a second render)", async () => {
    const toast = provider();
    const control = keep(mount(() => ExcludedToast({ id: ID })));
    await shown(() => toast.text().includes(EXCLUDED_TOAST), "notice");
    control.rerender();
    control.rerender();
    await Promise.resolve();
    expect(ctl.replace).toHaveBeenCalledTimes(1);
    expect(notices(toast)).toHaveLength(1);
  });

  it("元に戻す puts the parcel back and says the putting-back sentence, with no button left", async () => {
    ctl.restoreExcluded.mockResolvedValue({ ok: true });
    const toast = provider();
    keep(mount(() => ExcludedToast({ id: ID })));
    await shown(() => toast.text().includes(EXCLUDED_TOAST), "notice");
    press(button(toast, "元に戻す"));
    await shown(() => toast.text().includes(RESTORED_TOAST), "restored");
    expect(ctl.restoreExcluded).toHaveBeenCalledWith(ID);
    expect(toast.hosts((host) => host.type === "button")).toHaveLength(0);
  });

  it.each(["refused", "thrown"] as const)("a %s 元に戻す says it could not put it back, in words other than the taking-out failure", async (kind) => {
    if (kind === "refused") ctl.restoreExcluded.mockResolvedValue({ ok: false });
    else ctl.restoreExcluded.mockRejectedValue(new Error("network"));
    const toast = provider();
    keep(mount(() => ExcludedToast({ id: ID })));
    await shown(() => toast.text().includes(EXCLUDED_TOAST), "notice");
    press(button(toast, "元に戻す"));
    await shown(() => toast.text().includes(RESTORE_FAILED), "restore failed");
    expect(toast.text()).not.toContain(EXCLUDE_FAILED);
    expect(toast.text()).not.toContain(RESTORED_TOAST);
    expect(RESTORE_FAILED).not.toBe(EXCLUDE_FAILED);
  });

  it("pressed twice at once, it asks once and ends in the one result; it stays while waiting", async () => {
    const answer = deferred<{ ok: boolean }>();
    ctl.restoreExcluded.mockReturnValue(answer.promise);
    const toast = provider();
    keep(mount(() => ExcludedToast({ id: ID })));
    await shown(() => toast.text().includes(EXCLUDED_TOAST), "notice");
    const first = button(toast, "元に戻す");
    press(first);
    press(first);
    await shown(() => toast.text().includes("戻しています…"), "pending");
    press(button(toast, "戻しています…"));
    await vi.advanceTimersByTimeAsync(20_000);
    expect(notices(toast)).toHaveLength(1);
    expect(ctl.restoreExcluded).toHaveBeenCalledTimes(1);
    answer.resolve({ ok: true });
    await shown(() => toast.text().includes(RESTORED_TOAST), "restored");
    expect(ctl.restoreExcluded).toHaveBeenCalledTimes(1);
  });
});

describe("一覧に戻す on 外した荷物", () => {
  it("asks to put the parcel back; a refusal or a thrown call says the putting-back sentence, never the taking-out one", async () => {
    ctl.restoreExcluded.mockResolvedValue({ ok: true });
    const ok = keep(mount(() => RestoreExcludedButton({ id: ID })));
    press(button(ok, RESTORE_BUTTON_LABEL));
    await shown(() => ctl.restoreExcluded.mock.calls.length === 1, "restore call");
    expect(ctl.restoreExcluded).toHaveBeenCalledWith(ID);
    await Promise.resolve();
    expect(alerts(ok)).toHaveLength(0);

    for (const failure of ["refused", "thrown"] as const) {
      if (failure === "refused") ctl.restoreExcluded.mockResolvedValue({ ok: false });
      else ctl.restoreExcluded.mockRejectedValue(new Error("network"));
      const view = keep(mount(() => RestoreExcludedButton({ id: ID })));
      press(button(view, RESTORE_BUTTON_LABEL));
      await shown(() => alerts(view).length === 1, "failure sentence");
      expect(view.text()).toContain(RESTORE_FAILED);
      expect(view.text()).not.toContain(EXCLUDE_FAILED);
    }
  });
});

describe("taking ?excluded off the address keeps the other values", () => {
  it.each([
    [`excluded=${ID}&demo=busy`, "/app?demo=busy"],
    [`sample=1&excluded=${ID}&x=a%20b`, "/app?sample=1&x=a+b"],
    [`excluded=${ID}`, "/app"],
  ])("?%s goes to %s", async (query, expected) => {
    ctl.query = query;
    const toast = provider();
    keep(mount(() => ExcludedToast({ id: ID })));
    await shown(() => toast.text().includes(EXCLUDED_TOAST), "notice");
    expect(ctl.replace).toHaveBeenCalledTimes(1);
    expect(ctl.replace).toHaveBeenCalledWith(expected);
  });
});

describe("the second sentence of the notice", () => {
  it("ExcludedToast shows the sentence the list gave it, with 元に戻す", async () => {
    const toast = provider();
    keep(mount(() => ExcludedToast({ id: ID, text: EXCLUDED_TOAST_AUTO })));
    await shown(() => toast.text().includes(EXCLUDED_TOAST_AUTO), "second sentence");
    expect(toast.text()).not.toContain(EXCLUDED_TOAST + "。");
    expect(button(toast, "元に戻す")).toBeDefined();
  });

  it("without a sentence it shows the plain one (the first-stage form)", async () => {
    const toast = provider();
    keep(mount(() => ExcludedToast({ id: ID })));
    await shown(() => toast.text().includes(EXCLUDED_TOAST), "plain sentence");
    expect(toast.text()).not.toContain(EXCLUDED_TOAST_AUTO);
  });
});

describe("一覧に戻す on 外した荷物 says what happened", () => {
  it.each([["rule", RESTORED_RULE_TOAST, RESTORED_TOAST], ["user", RESTORED_TOAST, RESTORED_RULE_TOAST]])("a %s mark: the sentence after it worked, and not the other one", async (kind, expected, other) => {
    ctl.restoreExcluded.mockResolvedValue({ ok: true });
    const toast = provider();
    const view = keep(mount(() => RestoreExcludedButton((RestoreWithNotice({ id: ID, kind }) as ReactElement<{ id: string; onRestored: () => void }>).props)));
    press(button(view, RESTORE_BUTTON_LABEL));
    await shown(() => toast.text().includes(expected), "sentence");
    expect(toast.text()).not.toContain(other);
    expect(toast.hosts((host) => host.type === "button")).toHaveLength(0);
  });

  it("a refusal shows no sentence of success (negative control)", async () => {
    ctl.restoreExcluded.mockResolvedValue({ ok: false });
    const toast = provider();
    const view = keep(mount(() => RestoreExcludedButton((RestoreWithNotice({ id: ID, kind: "rule" }) as ReactElement<{ id: string; onRestored: () => void }>).props)));
    press(button(view, RESTORE_BUTTON_LABEL));
    await shown(() => alerts(view).length === 1, "failure sentence");
    expect(notices(toast)).toHaveLength(0);
    expect(view.text()).toContain(RESTORE_FAILED);
  });
});

describe("C7: the client part says seen once, after it is shown", () => {
  it("calls the action once with the time and the account it was given, however often it renders again", async () => {
    const view = keep(mount(() => MarkAutoSeen({ seenUntil: "2026-11-17T03:30:00+00:00", expectedUserId: "00000000-0000-4000-8000-00000000000a" })));
    view.rerender();
    view.rerender();
    await Promise.resolve();
    expect(ctl.seen).toHaveBeenCalledTimes(1);
    expect(ctl.seen).toHaveBeenCalledWith("2026-11-17T03:30:00+00:00", "00000000-0000-4000-8000-00000000000a");
  });

  it("a rejected write throws nothing and changes nothing (the row only stays)", async () => {
    ctl.seen.mockRejectedValue(new Error("network"));
    keep(mount(() => MarkAutoSeen({ seenUntil: "2026-11-17T03:30:00+00:00", expectedUserId: "00000000-0000-4000-8000-00000000000a" })));
    await Promise.resolve();
    await Promise.resolve();
    expect(ctl.seen).toHaveBeenCalledTimes(1);
    expect(ctl.transitionErrors).toEqual([]);
  });
});
