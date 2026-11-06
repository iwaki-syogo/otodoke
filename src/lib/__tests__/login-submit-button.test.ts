import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TURNSTILE_RESPONSE_FIELD, TURNSTILE_WAIT_MS } from "@/lib/turnstile";
import { fakeEvent } from "./element-tree";
import { mount, type Mounted } from "./hook-harness";

/**
 * The login button shows that the press registered: spinner and 「送信中…」 from the press until
 * the form has been sent. It is never `disabled`; a second press while holding or sending is
 * cancelled instead.
 *
 * A press before the bot check has its token is held (cancelled, spinner on) until the form's
 * `cf-turnstile-response` has a token, for at most TURNSTILE_WAIT_MS (10 s). Then the button
 * clicks itself once, and that click goes through to the form, token or not (Supabase decides).
 * No hold when the token is there, when the field is marked unavailable (the script could not
 * load), or when the address is not valid yet (the browser shows its message).
 */

const status = vi.hoisted(() => ({ pending: false }));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { harnessHooks } = await import("./hook-harness");
  return harnessHooks(actual);
});
vi.mock("react-dom", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-dom")>()),
  useFormStatus: () => ({ pending: status.pending, data: null, method: null, action: null }),
}));

const { LoginSubmitButton } = await import("@/app/login/submit-button");

const html = () => renderToStaticMarkup(createElement(LoginSubmitButton));
const TOKEN = "0.token-from-cloudflare";

/**
 * A mounted button with the form, token field and button node its press reads. `press()` returns
 * whether the press was cancelled. `selfClicks` are the clicks the button made itself, each
 * recorded as cancelled or not (not = the browser goes on to send the form).
 */
function setup({ token = "", unavailable = false, valid = true } = {}) {
  const field = { value: token, dataset: (unavailable ? { turnstile: "unavailable" } : {}) as Record<string, string> };
  const form = {
    elements: { namedItem: vi.fn((name: string) => (name === TURNSTILE_RESPONSE_FIELD ? field : null)) },
    checkValidity: vi.fn(() => valid),
  };
  const selfClicks: boolean[] = [];
  const button = { form, isConnected: true, click: vi.fn(() => selfClicks.push(press())) };
  const view: Mounted = mount(() => LoginSubmitButton());
  function press(): boolean {
    const event = fakeEvent(button);
    (view.host((h) => h.type === "button").props.onClick as (e: unknown) => void)(event);
    return event.defaultPrevented;
  }
  return { field, form, button, view, press, selfClicks };
}

const buttonProps = (view: Mounted) => view.host((h) => h.type === "button").props;

beforeEach(() => {
  status.pending = false;
});
afterEach(() => {
  vi.useRealTimers();
});

describe("login submit button", () => {
  it("reads 「リンクを送る」 with no spinner when idle", () => {
    const out = html();
    expect(out).toContain("リンクを送る");
    expect(out).not.toContain("送信中");
    expect(out).not.toContain("animate-spin");
    expect(out).not.toContain("aria-busy");
  });

  it("shows a spinner and 「送信中…」 while sending", () => {
    status.pending = true;
    const out = html();
    expect(out).toContain("送信中…");
    expect(out).toContain("animate-spin");
    expect(out).toContain('aria-busy="true"');
    expect(out).not.toContain("リンクを送る");
  });

  it("is never disabled, idle, holding or sending", async () => {
    vi.useFakeTimers();
    for (const pending of [false, true]) {
      status.pending = pending;
      expect(html()).not.toMatch(/\sdisabled(=|\s|>)/);
      const { view } = setup({ token: TOKEN });
      expect(buttonProps(view).disabled).toBeUndefined();
      expect(buttonProps(view).type).toBe("submit");
    }
    status.pending = false;
    const holding = setup();
    holding.press();
    await Promise.resolve();
    expect(buttonProps(holding.view)["aria-busy"]).toBe(true);
    expect(buttonProps(holding.view).disabled).toBeUndefined();
  });

  it("lets the first press through when the token is there, and cancels a second press while sending", () => {
    const s = setup({ token: TOKEN });
    expect(s.press()).toBe(false);
    expect(s.button.click).not.toHaveBeenCalled();

    status.pending = true;
    s.view.rerender();
    expect(s.press()).toBe(true);
  });

  it("is what the login page uses, inside the form that posts to the server action", () => {
    const page = readFileSync(path.resolve(__dirname, "../../app/login/page.tsx"), "utf8");
    const form = page.slice(page.indexOf("<form action={sendMagicLink}"), page.indexOf("</form>"));
    expect(form).toContain("<LoginSubmitButton />");
    expect(form).not.toMatch(/<button\b/);
    const source = readFileSync(path.resolve(__dirname, "../../app/login/submit-button.tsx"), "utf8");
    expect(source.startsWith('"use client";')).toBe(true);
    expect(source).not.toMatch(/\bdisabled\s*=/);
  });
});

describe("a press before the bot check has its token", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("waits up to 10 seconds", () => {
    expect(TURNSTILE_WAIT_MS).toBe(10_000);
  });

  it("is held, with the spinner, until the token arrives, then sends once", async () => {
    const s = setup();
    expect(s.press()).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(s.view.text()).toContain("送信中…");
    expect(buttonProps(s.view)["aria-busy"]).toBe(true);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(s.button.click).not.toHaveBeenCalled();
    s.field.value = TOKEN;
    await vi.advanceTimersByTimeAsync(100);
    expect(s.button.click).toHaveBeenCalledTimes(1);
    // The button's own click is not cancelled: the browser sends the form, with the token.
    expect(s.selfClicks).toEqual([false]);
    await vi.advanceTimersByTimeAsync(TURNSTILE_WAIT_MS);
    expect(s.button.click).toHaveBeenCalledTimes(1);
  });

  it("sends without a token once 10 seconds have passed (Supabase decides)", async () => {
    const s = setup();
    expect(s.press()).toBe(true);
    await vi.advanceTimersByTimeAsync(TURNSTILE_WAIT_MS - 100);
    expect(s.button.click).not.toHaveBeenCalled();
    expect(s.view.text()).toContain("送信中…");
    await vi.advanceTimersByTimeAsync(100);
    expect(s.button.click).toHaveBeenCalledTimes(1);
    expect(s.selfClicks).toEqual([false]);
    expect(s.field.value).toBe("");
  });

  it("ignores more presses while held (Enter in the address field is a press too)", async () => {
    const s = setup();
    expect(s.press()).toBe(true);
    expect(s.press()).toBe(true);
    await vi.advanceTimersByTimeAsync(500);
    expect(s.press()).toBe(true);
    s.field.value = TOKEN;
    await vi.advanceTimersByTimeAsync(100);
    expect(s.button.click).toHaveBeenCalledTimes(1);
    expect(s.selfClicks).toEqual([false]);
  });

  it("sends at once when the check could not load, and stops holding as soon as it fails", async () => {
    const blocked = setup({ unavailable: true });
    expect(blocked.press()).toBe(false);

    const failing = setup();
    expect(failing.press()).toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);
    failing.field.dataset.turnstile = "unavailable";
    await vi.advanceTimersByTimeAsync(100);
    expect(failing.button.click).toHaveBeenCalledTimes(1);
    expect(failing.selfClicks).toEqual([false]);
  });

  it("does not hold an address the browser will refuse: its message shows and nothing is sent", async () => {
    const s = setup({ valid: false });
    expect(s.press()).toBe(false);
    expect(s.form.checkValidity).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(TURNSTILE_WAIT_MS);
    expect(s.button.click).not.toHaveBeenCalled();
  });

  it("sends nothing when the form was drawn anew during the hold", async () => {
    const s = setup();
    expect(s.press()).toBe(true);
    s.button.isConnected = false;
    s.view.unmount();
    s.field.value = TOKEN;
    await vi.advanceTimersByTimeAsync(TURNSTILE_WAIT_MS);
    expect(s.button.click).not.toHaveBeenCalled();
  });
});
