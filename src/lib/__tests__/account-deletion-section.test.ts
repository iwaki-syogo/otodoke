import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ACCOUNT_DELETE_CONFIRM, ACCOUNT_DELETE_FAILED } from "@/lib/account-deletion";
import { fakeEvent, type Host } from "./element-tree";
import { mount, type Mounted } from "./hook-harness";

/**
 * The section 設定「アカウントを削除」 (review E-2).
 *
 * - The first press deletes nothing: there is no form until the confirmation step, which says what
 *   goes, that it cannot be undone, and to remove the automatic forwarding.
 * - 「削除する」 shows the press: spinner, 「削除しています…」, aria-busy; never `disabled`. A second
 *   press is cancelled, also one that comes before React has drawn the first.
 * - A failure shows the action's fixed words in an alert, and a press sends again.
 * - Focus goes to the question when the step opens, and back to the button when it closes.
 */

const action = vi.hoisted(() => ({ state: null as { error: string } | null, pending: false, formAction: () => {} }));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { harnessHooks } = await import("./hook-harness");
  return { ...harnessHooks(actual), useActionState: () => [action.state, action.formAction, action.pending] };
});
vi.mock("@/app/app/settings/account-actions", () => ({ deleteAccount: vi.fn() }));

const { AccountDeletion } = await import("@/app/app/settings/account-deletion");

const focusable = () => ({ dataset: {}, focus: vi.fn() });
const isButton = (label: string) => (h: Host) => h.type === "button" && textOfHost(h).includes(label);
function textOfHost(h: Host | string): string {
  return typeof h === "string" ? h : h.children.map(textOfHost).join("");
}

/** Presses the button that reads `label`; returns whether the press was cancelled. */
function press(view: Mounted, label: string): boolean {
  const event = fakeEvent({});
  (view.host(isButton(label)).props.onClick as (e: unknown) => void)(event);
  return event.defaultPrevented;
}

async function opened(): Promise<Mounted> {
  const view = mount(() => AccountDeletion(), focusable);
  press(view, "アカウントを削除");
  await Promise.resolve();
  return view;
}

beforeEach(() => {
  action.state = null;
  action.pending = false;
});

describe("the first press deletes nothing", () => {
  it("before it there is one button and no form", () => {
    const view = mount(() => AccountDeletion(), focusable);
    expect(view.hosts((h) => h.type === "form")).toEqual([]);
    expect(view.hosts((h) => h.type === "button").map(textOfHost)).toEqual(["アカウントを削除"]);
    expect(view.text()).not.toContain("削除する");
    // Static markup (the settings page) too.
    const html = renderToStaticMarkup(createElement(AccountDeletion));
    expect(html).toContain("アカウントを削除");
    expect(html).not.toContain("<form");
    expect(html).not.toContain(ACCOUNT_DELETE_CONFIRM.value);
  });

  it("opens the confirmation step: what goes, no undo, the forwarding; only then the form with the field", async () => {
    const view = await opened();
    const text = view.text();
    expect(text).toContain("アカウントを削除しますか？");
    // The password goes with the account; there is no passphrase any more (password-v1).
    expect(text).toContain("Otodoke の荷物と、Otodoke に保存したメール、転送先アドレスを、アカウントごと消します。お使いのメールの受信箱は、そのままです。元に戻せません。");
    expect(text).not.toContain("合言葉");
    expect(text).toContain("元に戻せません。");
    expect(text).toContain("Gmail などで設定した自動転送も外してください。");
    const form = view.host((h) => h.type === "form");
    expect(form.props.action).toBe(action.formAction);
    const hidden = view.host((h) => h.type === "input");
    expect(hidden.props).toMatchObject({ type: "hidden", name: ACCOUNT_DELETE_CONFIRM.name, value: ACCOUNT_DELETE_CONFIRM.value });
    expect(view.host(isButton("削除する")).props.type).toBe("submit");
    expect(view.host(isButton("やめる")).props.type).toBe("button");
  });

  it("やめる closes the step again", async () => {
    const view = await opened();
    press(view, "やめる");
    await Promise.resolve();
    expect(view.hosts((h) => h.type === "form")).toEqual([]);
    expect(view.hosts((h) => h.type === "button").map(textOfHost)).toEqual(["アカウントを削除"]);
  });

  it("moves the focus to the question when it opens and back to the button when it closes, not on the first draw", async () => {
    const view = mount(() => AccountDeletion(), focusable);
    const opener = view.nodeOf<{ focus: ReturnType<typeof vi.fn> }>(view.host(isButton("アカウントを削除")));
    expect(opener.focus).not.toHaveBeenCalled();
    press(view, "アカウントを削除");
    await Promise.resolve();
    const title = view.nodeOf<{ focus: ReturnType<typeof vi.fn> }>(view.host((h) => h.type === "h2"));
    expect(title.focus).toHaveBeenCalledTimes(1);
    expect(view.host((h) => h.type === "h2").props.tabIndex).toBe(-1);
    press(view, "やめる");
    await Promise.resolve();
    expect(opener.focus).toHaveBeenCalledTimes(1);
  });
});

describe("「削除する」 shows the press and is sent once", () => {
  it("lets the first press through and cancels a second one that comes before React has drawn the first", async () => {
    const view = await opened();
    expect(press(view, "削除する")).toBe(false);
    expect(press(view, "削除する")).toBe(true);
  });

  it("while deleting: spinner, 「削除しています…」, aria-busy, never disabled; presses are cancelled and やめる does nothing", async () => {
    const view = await opened();
    expect(press(view, "削除する")).toBe(false);
    action.pending = true;
    view.rerender();
    const button = view.host(isButton("削除しています…"));
    expect(button.props["aria-busy"]).toBe(true);
    expect(button.props.disabled).toBeUndefined();
    expect(view.hosts((h) => h.type === "span" && String(h.props.className).includes("animate-spin"))).toHaveLength(1);
    expect(view.text()).not.toContain("削除する");
    expect(press(view, "削除しています…")).toBe(true);
    expect(view.host(isButton("やめる")).props["aria-disabled"]).toBe(true);
    press(view, "やめる");
    await Promise.resolve();
    expect(view.hosts((h) => h.type === "form")).toHaveLength(1);
  });

  it("is never disabled in the source either", () => {
    const html = renderToStaticMarkup(createElement(AccountDeletion));
    expect(html).not.toMatch(/\sdisabled(=|\s|>)/);
  });
});

describe("after a failure", () => {
  it("shows the action's fixed words in an alert, and a press sends again", async () => {
    const view = await opened();
    expect(press(view, "削除する")).toBe(false);
    action.pending = true;
    view.rerender();
    action.pending = false;
    action.state = { error: ACCOUNT_DELETE_FAILED };
    view.rerender();
    const alert = view.host((h) => h.type === "p" && h.props.role === "alert");
    expect(textOfHost(alert)).toBe(ACCOUNT_DELETE_FAILED);
    expect(view.host(isButton("削除する")).props["aria-busy"]).toBeUndefined();
    expect(press(view, "削除する")).toBe(false);
  });

  it("hides the words while the next try runs", async () => {
    const view = await opened();
    action.state = { error: ACCOUNT_DELETE_FAILED };
    view.rerender();
    expect(view.text()).toContain(ACCOUNT_DELETE_FAILED);
    action.pending = true;
    view.rerender();
    expect(view.text()).not.toContain(ACCOUNT_DELETE_FAILED);
  });

  it("closing the step and opening it again starts without the old words", async () => {
    const view = await opened();
    action.state = { error: ACCOUNT_DELETE_FAILED };
    view.rerender();
    press(view, "やめる");
    await Promise.resolve();
    press(view, "アカウントを削除");
    await Promise.resolve();
    expect(view.text()).toContain("アカウントを削除しますか？");
    expect(view.text()).not.toContain(ACCOUNT_DELETE_FAILED);
    // A new failure shows again.
    action.state = { error: ACCOUNT_DELETE_FAILED };
    view.rerender();
    expect(view.text()).toContain(ACCOUNT_DELETE_FAILED);
  });
});

describe("the words", () => {
  it("use no brackets (wording rule)", async () => {
    const view = await opened();
    action.state = { error: ACCOUNT_DELETE_FAILED };
    view.rerender();
    expect(view.text()).not.toMatch(/[()（）「」]/);
  });
});
