import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LOGIN_MESSAGES, OPEN_WITH_ANOTHER_PASSWORD } from "@/lib/login-errors";
import { fakeEvent, type Host } from "./element-tree";
import { mount, type Mounted } from "./hook-harness";

/**
 * 「ほかのパスワードで開く」 (src/app/login/other-password-form.tsx), after a sign-in whose password
 * does not open the key in use (R3-PW-1: a change that stopped half-way leaves the login at the old
 * password and the key at the new one; the reset next to it would lose the mail sealed before).
 * The button shows a field; 「開く」 hands the password to the sign-in's opener (password-flows.ts
 * openWithAnother, which wraps the key again for the login's password); the press is shown at once.
 */

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { harnessHooks } = await import("./hook-harness");
  return harnessHooks(actual);
});

const { OtherPasswordForm } = await import("@/app/login/other-password-form");

const EMAIL = "someone@example.test";
const OTHER = "となりの犬は柴で3歳";

const textOfHost = (h: Host | string): string => (typeof h === "string" ? h : h.children.map(textOfHost).join(""));
const drawn = () => new Promise<void>((resolve) => queueMicrotask(() => queueMicrotask(resolve)));
const field = (view: Mounted) => view.host((h) => h.type === "input" && h.props.type === "password");
const button = (view: Mounted) => view.host((h) => h.type === "button");

const opener = vi.fn();
const onOpened = vi.fn();

beforeEach(() => {
  opener.mockReset();
  onOpened.mockReset();
});

/** The field shown, and the other password typed in. */
async function typed() {
  const view = mount(() => OtherPasswordForm({ email: EMAIL, openWithAnother: opener, onOpened }));
  (button(view).props.onClick as () => void)();
  await drawn();
  (field(view).props.onChange as (e: unknown) => void)({ target: { value: OTHER } });
  await drawn();
  return view;
}
const press = (view: Mounted) => (view.host((h) => h.type === "form").props.onSubmit as (e: unknown) => Promise<void>)(fakeEvent());

describe("ほかのパスワードで開く", () => {
  it("is a button first, with no field", () => {
    const view = mount(() => OtherPasswordForm({ email: EMAIL, openWithAnother: opener, onOpened }));
    expect(textOfHost(button(view))).toBe(OPEN_WITH_ANOTHER_PASSWORD);
    expect(OPEN_WITH_ANOTHER_PASSWORD).toBe("ほかのパスワードで開く");
    expect(view.hosts((h) => h.type === "input" || h.type === "form")).toEqual([]);
  });

  it("shows the field and 「開く」; the press is shown at once and hands the password to the opener", async () => {
    let answer!: (v: unknown) => void;
    opener.mockReturnValue(new Promise((r) => (answer = r)));
    const view = await typed();
    expect(textOfHost(button(view))).toBe("開く");
    const done = press(view);
    await drawn();
    expect(textOfHost(button(view))).toBe("開いています…");
    expect(button(view).props["aria-busy"]).toBe(true);
    expect(button(view).props.disabled).toBeUndefined();
    // A second press meanwhile does nothing more.
    void press(view);
    await drawn();
    expect(opener).toHaveBeenCalledTimes(1);
    expect(opener).toHaveBeenCalledWith(OTHER);
    answer({ ok: true });
    await done;
    await drawn();
    expect(onOpened).toHaveBeenCalledTimes(1);
    // Opened: the press stays shown until the next page, and the field keeps nothing.
    expect(textOfHost(button(view))).toBe("開いています…");
    expect(field(view).props.value).toBe("");
  });

  it("a password that does not open it either: says so, empties the field, and can be tried again", async () => {
    opener.mockResolvedValue({ ok: false, code: "other_password_wrong" });
    const view = await typed();
    await press(view);
    await drawn();
    expect(view.text()).toContain(LOGIN_MESSAGES.other_password_wrong);
    expect(LOGIN_MESSAGES.other_password_wrong).toBe("このパスワードでも、メールの鍵を開けませんでした。");
    expect(field(view).props.value).toBe("");
    expect(textOfHost(button(view))).toBe("開く");
    expect(onOpened).not.toHaveBeenCalled();
  });

  it.each(["stale_session", "key_wrap_changed", "network"] as const)("%s is told with its fixed words", async (code) => {
    opener.mockResolvedValue({ ok: false, code });
    const view = await typed();
    await press(view);
    await drawn();
    expect(view.text()).toContain(LOGIN_MESSAGES[code]);
    expect(onOpened).not.toHaveBeenCalled();
  });

  it("an empty field sends nothing", async () => {
    const view = mount(() => OtherPasswordForm({ email: EMAIL, openWithAnother: opener, onOpened }));
    (button(view).props.onClick as () => void)();
    await drawn();
    await press(view);
    expect(opener).not.toHaveBeenCalled();
  });

  it("the field has no name, in a POST form without an action, and names the account for a password manager", async () => {
    const view = await typed();
    const form = view.host((h) => h.type === "form");
    expect(form.props.method).toBe("post");
    expect(form.props.action).toBeUndefined();
    expect(view.hosts((h) => "name" in h.props)).toEqual([]);
    expect(view.host((h) => h.type === "input" && h.props.autoComplete === "username").props).toMatchObject({ value: EMAIL, readOnly: true, hidden: true });
    expect(field(view).props.autoComplete).toBe("current-password");
    // Drawn by the server, it is the button alone (the field comes with the press, after the script).
    expect(renderToStaticMarkup(createElement(OtherPasswordForm, { email: EMAIL, openWithAnother: opener, onOpened }))).not.toContain("<input");
  });
});
