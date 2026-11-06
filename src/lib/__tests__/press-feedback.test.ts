import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { expand, fakeEvent, findHosts, hostText, type Host } from "./element-tree";
import { mount, type Mounted } from "./hook-harness";

/**
 * [Review 2026-11-06 F-3 / D2-1 / D2-8] A press that sends a request shows it at once: a spinner
 * and 「〜しています…」 from the press until the answer is drawn. One press at a time, held by a ref
 * before anything is awaited (iPhone Safari can fire one tap twice). A native form's submit button
 * is never `disabled` while sending (its name=value would drop out of the POST).
 *
 * The shared parts (src/components/pending-button.tsx): PendingButton + usePendingAction for a
 * press handled in code, SubmitButton for a form. Used by 「届いた」 (the swipe, the parcel page),
 * 「すべて受取済にする」, 「元に戻す」, 「届いていない」 and the 登録／編集 form.
 */

const ctl = vi.hoisted(() => ({
  transitionPending: false,
  formPending: false,
  toast: vi.fn(),
  markDelivered: vi.fn(),
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { harnessHooks } = await import("./hook-harness");
  return {
    ...harnessHooks(actual),
    // A transition runs its callback at once; whether one is pending is what the test says.
    useTransition: () => [ctl.transitionPending, (fn: () => unknown) => void fn()],
    // The one context these components read is the toast's.
    useContext: () => ctl.toast,
  };
});
vi.mock("react-dom", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-dom")>()),
  useFormStatus: () => ({ pending: ctl.formPending, data: null, method: null, action: null }),
}));
vi.mock("@/app/app/parcel-actions", () => ({
  markDelivered: (...a: unknown[]) => ctl.markDelivered(...a),
  restoreStatuses: vi.fn(async () => {}),
  markNotDelivered: vi.fn(async () => ({ ok: true })),
}));

const { PendingButton, SubmitButton, usePendingAction } = await import("@/components/pending-button");
const { SwipeToDeliver, DeliverAll } = await import("@/app/app/delivered-controls");
const { MarkDeliveredButton } = await import("@/app/app/parcels/[id]/mark-delivered-button");

const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};
const buttons = (nodes: Array<Host | string>) => findHosts(nodes, (h) => h.type === "button");
const buttonIn = (view: Mounted, text: string) => view.host((h) => h.type === "button" && hostText(h).includes(text));
/** Presses `h` as the browser would; answers whether the press was cancelled. */
const press = (h: Host, target: Record<string, unknown> = {}) => {
  const e = fakeEvent(target);
  (h.props.onClick as (e: unknown) => void)(e);
  return e.defaultPrevented;
};
const spinners = (nodes: Array<Host | string>) => findHosts(nodes, (h) => String(h.props.className ?? "").includes("animate-spin"));

beforeEach(() => {
  ctl.transitionPending = false;
  ctl.formPending = false;
  ctl.toast.mockReset();
  ctl.markDelivered.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("PendingButton", () => {
  const draw = (pending: boolean, onClick = vi.fn()) => ({
    onClick,
    nodes: expand(createElement(PendingButton as never, { pending, pendingLabel: "保存しています…", onClick, className: "inline-flex gap-2" } as never, "届いた")),
  });

  it("reads its words with no spinner when idle, and a press goes to its handler", () => {
    const { nodes, onClick } = draw(false);
    const [b] = buttons(nodes);
    expect(hostText(b)).toBe("届いた");
    expect(spinners(nodes)).toHaveLength(0);
    expect(b.props["aria-busy"]).toBeUndefined();
    expect(b.props.type).toBe("button");
    expect(press(b)).toBe(false);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("shows the spinner and the pending words while pending, never disabled, and drops a press", () => {
    const { nodes, onClick } = draw(true);
    const [b] = buttons(nodes);
    expect(hostText(b)).toBe("保存しています…");
    expect(spinners(nodes)).toHaveLength(1);
    expect(b.props["aria-busy"]).toBe(true);
    expect(b.props["aria-disabled"]).toBe(true);
    expect(String(b.props.className)).toContain("pointer-events-none");
    expect(b.props.disabled).toBeUndefined();
    expect(press(b)).toBe(true);
    expect(onClick).not.toHaveBeenCalled();
  });
});

describe("usePendingAction", () => {
  it("runs one request at a time: a second press before the first is answered does nothing", async () => {
    let release!: () => void;
    const work = vi.fn(() => new Promise<void>((r) => (release = r)));
    let api!: ReturnType<typeof usePendingAction>;
    mount(() => {
      api = usePendingAction();
      return null;
    });
    api.run(work);
    api.run(work);
    expect(work).toHaveBeenCalledTimes(1);
    release();
    await flush();
    api.run(work);
    expect(work).toHaveBeenCalledTimes(2);
  });

  it("is pending while its transition is", () => {
    let api!: ReturnType<typeof usePendingAction>;
    ctl.transitionPending = true;
    mount(() => {
      api = usePendingAction();
      return null;
    });
    expect(api.pending).toBe(true);
  });
});

describe("SubmitButton", () => {
  const setup = (props: Record<string, unknown> = {}) => {
    const view = mount(() => SubmitButton({ pendingLabel: "保存しています…", className: "flex gap-2", children: "保存", ...props } as Parameters<typeof SubmitButton>[0]));
    const button = () => view.host((h) => h.type === "button");
    return { view, button, press: (target: Record<string, unknown> = {}) => press(button(), target) };
  };

  it("is a submit button that is never disabled, idle or sending", () => {
    for (const pending of [false, true]) {
      ctl.formPending = pending;
      const { button } = setup();
      expect(button().props.type).toBe("submit");
      expect(button().props.disabled).toBeUndefined();
    }
  });

  it("shows the spinner and the pending words while the form is sent, and cancels a press then", () => {
    ctl.formPending = true;
    const { view, press: p, button } = setup();
    expect(view.text()).toBe("保存しています…");
    expect(spinners(view.tree)).toHaveLength(1);
    expect(button().props["aria-busy"]).toBe(true);
    expect(String(button().props.className)).toContain("pointer-events-none");
    expect(p()).toBe(true);
  });

  it("cancels a second press before the form starts sending, and takes a press again once the answer is drawn", () => {
    const { view, press: p } = setup();
    expect(p()).toBe(false);
    expect(p()).toBe(true);
    ctl.formPending = true;
    view.rerender();
    ctl.formPending = false;
    view.rerender();
    expect(p()).toBe(false);
  });

  it("does not hold a press the browser refuses (a required field left empty)", () => {
    const form = { ok: false, checkValidity: () => form.ok };
    const { press: p } = setup();
    expect(p({ form })).toBe(false);
    form.ok = true;
    expect(p({ form })).toBe(false);
    expect(p({ form })).toBe(true);
  });

  it("takes a press again after a while when nothing started sending", () => {
    vi.useFakeTimers();
    const { press: p } = setup();
    expect(p()).toBe(false);
    expect(p()).toBe(true);
    vi.advanceTimersByTime(3000);
    expect(p()).toBe(false);
  });

  it("with leavesPage (a form posting to a URL): spins from the press until the page is left, and resets on a return from the back-forward cache", async () => {
    let onShow: ((e: { persisted: boolean }) => void) | null = null;
    vi.stubGlobal("window", {
      addEventListener: (type: string, fn: (e: { persisted: boolean }) => void) => {
        if (type === "pageshow") onShow = fn;
      },
      removeEventListener: () => {},
    });
    const { view, press: p } = setup({ leavesPage: true, children: "ログアウト", pendingLabel: "ログアウトしています…" });
    expect(p()).toBe(false);
    await flush();
    expect(view.text()).toBe("ログアウトしています…");
    expect(p()).toBe(true);
    onShow!({ persisted: false });
    await flush();
    expect(view.text()).toBe("ログアウトしています…");
    onShow!({ persisted: true });
    await flush();
    expect(view.text()).toBe("ログアウト");
    expect(p()).toBe(false);
  });
});

describe("the swipe's 「届いた」 (SwipeToDeliver)", () => {
  const card = createElement("a", { href: "/app/parcels/p1" }, "カード");
  const setup = () => mount(() => SwipeToDeliver({ id: "p1", status: "shipped", children: card }));
  const panelButton = (view: Mounted) => view.host((h) => h.type === "button");

  it("shows the spinner and 「保存しています…」 from the press until saved, and saves once", async () => {
    let release!: (n: number) => void;
    ctl.markDelivered.mockImplementation(() => new Promise((r) => (release = r)));
    const view = setup();
    press(panelButton(view));
    press(panelButton(view));
    await flush();
    expect(ctl.markDelivered).toHaveBeenCalledTimes(1);
    expect(ctl.markDelivered).toHaveBeenCalledWith(["p1"]);
    expect(hostText(panelButton(view))).toBe("保存しています…");
    expect(spinners(view.tree)).toHaveLength(1);
    expect(panelButton(view).props["aria-busy"]).toBe(true);
    release(1);
    await flush();
    expect(ctl.toast).toHaveBeenCalledWith({ text: "届いたにしました", undo: [{ id: "p1", status: "shipped" }] });
  });

  it("[D2-8] says it could not save when nothing was saved (0), instead of 「届いたにしました」 and a spinner that never stops", async () => {
    ctl.markDelivered.mockResolvedValue(0);
    const view = setup();
    press(panelButton(view));
    await flush();
    expect(ctl.toast).not.toHaveBeenCalled();
    expect(view.text()).toContain("保存できませんでした。もう一度スワイプしてください。");
    expect(hostText(panelButton(view))).toBe("届いた");
    // And it can be tried again.
    ctl.markDelivered.mockResolvedValue(1);
    press(panelButton(view));
    await flush();
    expect(ctl.markDelivered).toHaveBeenCalledTimes(2);
    expect(ctl.toast).toHaveBeenCalledTimes(1);
  });
});

describe("「すべて受取済にする」 (DeliverAll)", () => {
  const items = [
    { id: "a", status: "shipped" },
    { id: "b", status: "ordered" },
  ];

  it("asks once more, then saves once, showing the spinner and 「保存しています…」 meanwhile", async () => {
    let release!: (n: number) => void;
    ctl.markDelivered.mockImplementation(() => new Promise((r) => (release = r)));
    const view = mount(() => DeliverAll({ items }));
    press(buttonIn(view, "すべて受取済にする"));
    await flush();
    const confirm = buttonIn(view, "2 件を受取済にする");
    press(confirm);
    press(confirm);
    expect(ctl.markDelivered).toHaveBeenCalledTimes(1);
    ctl.transitionPending = true;
    view.rerender();
    expect(view.text()).toContain("保存しています…");
    expect(spinners(view.tree)).toHaveLength(1);
    release(2);
    await flush();
    ctl.transitionPending = false;
    view.rerender();
    expect(ctl.toast).toHaveBeenCalledWith({ text: "2 件を受取済にしました", undo: items });
  });

  it("[D2-8] says it could not save when nothing was saved (0)", async () => {
    ctl.markDelivered.mockResolvedValue(0);
    const view = mount(() => DeliverAll({ items }));
    press(buttonIn(view, "すべて受取済にする"));
    await flush();
    press(buttonIn(view, "2 件を受取済にする"));
    await flush();
    expect(ctl.toast).not.toHaveBeenCalled();
    expect(view.text()).toContain("保存できませんでした。もう一度押してください。");
  });
});

describe("[D2-1] 「届いた」 on the parcel page (MarkDeliveredButton)", () => {
  it("saves the parcel once from a press", async () => {
    ctl.markDelivered.mockResolvedValue(1);
    const view = mount(() => MarkDeliveredButton({ id: "p1" }));
    press(buttonIn(view, "届いた"));
    press(buttonIn(view, "届いた"));
    await flush();
    expect(ctl.markDelivered).toHaveBeenCalledTimes(1);
    expect(ctl.markDelivered).toHaveBeenCalledWith(["p1"]);
    expect(view.text()).not.toContain("保存できませんでした");
  });

  it("shows the spinner and 「保存しています…」 while pending", () => {
    ctl.transitionPending = true;
    const view = mount(() => MarkDeliveredButton({ id: "p1" }));
    expect(hostText(view.host((h) => h.type === "button"))).toBe("保存しています…");
    expect(spinners(view.tree)).toHaveLength(1);
  });

  it("says it could not save when nothing was saved (0) or the save failed", async () => {
    for (const answer of [() => Promise.resolve(0), () => Promise.reject(new Error("boom"))]) {
      ctl.markDelivered.mockImplementation(answer);
      const view = mount(() => MarkDeliveredButton({ id: "p1" }));
      press(buttonIn(view, "届いた"));
      await flush();
      expect(view.text()).toContain("保存できませんでした。もう一度押してください。");
    }
  });
});

describe("the presses wired to the shared parts", () => {
  const read = (rel: string) => readFileSync(path.resolve(__dirname, "../../app/app", rel), "utf8");

  it("the 登録／編集 form saves and deletes through SubmitButton, with 「保存しています…」 and 「消しています…」", () => {
    const source = read("parcels/manual-form.tsx");
    expect(source).toMatch(/import\s*\{\s*SubmitButton\s*\}\s*from\s*["']@\/components\/pending-button["']/);
    expect(source).toMatch(/<SubmitButton\b[^>]*pendingLabel="保存しています…"/);
    expect(source).toMatch(/<SubmitButton\b[^>]*pendingLabel="消しています…"/);
    expect(source).not.toContain("useFormStatus");
  });

  it("「元に戻す」 shows 「戻しています…」, and the notice does not close while it is on the way", () => {
    const source = read("delivered-controls.tsx");
    expect(source).toMatch(/<PendingButton\b[^>]*pendingLabel=\{UNDOING\}[^>]*onClick=\{undo\}/);
    expect(source).toContain('const UNDOING = "戻しています…";');
    expect(source).toMatch(/if \(!toast \|\| pending\) return;/);
  });

  it("the category sheet says 「保存しています…」 while a choice is saved", () => {
    const source = read("category-sheet.tsx");
    expect(source).toMatch(/pending \? \(\s*<p role="status"[^>]*>\s*<Spinner \/>\s*保存しています…/);
    expect(source).toMatch(/if \(saving\.current\) return;\s*saving\.current = true;/);
  });

  it("the passphrase form spins with 「開いています…」, one press at a time", () => {
    const source = read("unlock-form.tsx");
    expect(source).toMatch(/<Spinner tone="light" \/>\s*開いています…/);
    expect(source).toMatch(/if \(opening\.current \|\| !passphrase\) return;\s*opening\.current = true;/);
  });

  it("no submit button under /app (settings aside, G1/G2) is disabled: only the passphrase form's, which never posts", () => {
    const root = path.resolve(__dirname, "../../app/app");
    const files = (dir: string): string[] =>
      readdirSync(dir).flatMap((name) => {
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) return full === path.join(root, "settings") ? [] : files(full);
        return /\.tsx$/.test(name) ? [full] : [];
      });
    const found = files(root).filter((f) => {
      const source = readFileSync(f, "utf8");
      return [...source.matchAll(/<button\b[^>]*>/g)].some((m) => /type="submit"/.test(m[0]) && /\bdisabled=/.test(m[0]));
    });
    expect(found.map((f) => path.relative(root, f))).toEqual(["unlock-form.tsx"]);
    // That form never posts: its submit is always cancelled and handled in code.
    expect(read("unlock-form.tsx")).toMatch(/async function submit\(e: React\.FormEvent\) \{\s*e\.preventDefault\(\);/);
  });
});
