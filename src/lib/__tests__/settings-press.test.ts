import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeEvent } from "./element-tree";
import { mount } from "./hook-harness";

/**
 * 設定's slow buttons show the press at once (review G2-4): a spinner and 「〜しています…」 from the
 * press until the result. Never `disabled` while busy (a form sent before the script runs is a
 * plain POST, and a disabled button drops out of it): aria-disabled and pointer-events-none, and a
 * second press is cancelled by a ref (it can come before React has drawn the first).
 */

const status = vi.hoisted(() => ({ pending: false }));
const seal = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { harnessHooks } = await import("./hook-harness");
  return harnessHooks(actual);
});
vi.mock("react-dom", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-dom")>()),
  useFormStatus: () => ({ pending: status.pending, data: null, method: null, action: null }),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn(), back: vi.fn(), prefetch: vi.fn() }) }));
vi.mock("@/app/app/settings/key-actions", () => ({ sealStoredMail: seal.fn, registerMailKey: vi.fn(), activateMailKey: vi.fn(), rewrapMailKey: vi.fn(), readMailKey: vi.fn(), readRetiredMailKeys: vi.fn(), readSealedMail: vi.fn() }));
vi.mock("@/app/app/settings/password-actions", () => ({ changeLoginSecret: vi.fn() }));

const { PressButton } = await import("@/app/app/settings/press");
const { SealBanner } = await import("@/app/app/settings/password-panel");

const settings = (file: string) => readFileSync(path.resolve(__dirname, "../../app/app/settings", file), "utf8");
const html = () => renderToStaticMarkup(createElement(PressButton, { label: "読み取る", busyLabel: "読み取っています…", className: "x" }));
const DISABLED = /\sdisabled(=|\s|>)/;
/** `disabled={busy...}` in source, not `aria-disabled={busy...}`. */
const DISABLED_WHILE_BUSY = /(?<![-\w])disabled=\{busy/;

beforeEach(() => {
  status.pending = false;
  seal.fn.mockReset();
});

describe("PressButton (a Server Action form's submit button)", () => {
  it("idle: its label, no spinner, not busy", () => {
    const out = html();
    expect(out).toContain("読み取る");
    expect(out).not.toContain("animate-spin");
    expect(out).not.toContain("aria-disabled");
    expect(out).not.toMatch(DISABLED);
  });

  it("while the action runs: the spinner and the busy words, aria-disabled and no pointer events, never disabled", () => {
    status.pending = true;
    const out = html();
    expect(out).toContain("読み取っています…");
    expect(out).toContain("animate-spin");
    expect(out).toContain('aria-disabled="true"');
    expect(out).toContain('aria-busy="true"');
    expect(out).toContain("pointer-events-none");
    expect(out).not.toMatch(DISABLED);
  });

  function setup(valid = true) {
    const button = { form: { checkValidity: vi.fn(() => valid) } };
    const view = mount(() => PressButton({ label: "外す", busyLabel: "外しています…", className: "x" }));
    const press = () => {
      const event = fakeEvent(button);
      (view.host((h) => h.type === "button").props.onClick as (e: unknown) => void)(event);
      return event.defaultPrevented;
    };
    return { view, press, button };
  }

  it("lets the first press through and cancels a second one, before React has drawn the first", () => {
    const { press } = setup();
    expect(press()).toBe(false);
    expect(press()).toBe(true);
  });

  it("takes a press again once the action is over (a redirect back to the page keeps the button)", async () => {
    const { view, press } = setup();
    expect(press()).toBe(false);
    status.pending = true;
    view.rerender();
    expect(press()).toBe(true);
    status.pending = false;
    view.rerender();
    await Promise.resolve();
    expect(press()).toBe(false);
  });

  it("a press the browser refuses to send (an invalid form) does not lock it", () => {
    const { press, button } = setup(false);
    expect(press()).toBe(false);
    button.form.checkValidity.mockReturnValue(true);
    expect(press()).toBe(false);
    expect(press()).toBe(true);
  });
});

describe("「暗号化する」 (batches of Server Action calls from the browser)", () => {
  it("shows the spinner and the count left at once, runs once however often it is pressed, and is never disabled", async () => {
    let finish: (v: unknown) => void = () => {};
    seal.fn.mockImplementation(() => new Promise((resolve) => (finish = resolve)));
    const view = mount(() => SealBanner({ count: 3 }));
    const button = () => view.host((h) => h.type === "button");
    (button().props.onClick as () => void)();
    (button().props.onClick as () => void)();
    await Promise.resolve();
    expect(seal.fn).toHaveBeenCalledTimes(1);
    expect(view.text()).toContain("暗号化しています…あと 3 通");
    expect(button().props["aria-disabled"]).toBe(true);
    expect(String(button().props.className)).toContain("pointer-events-none");
    expect(button().props.disabled).toBeUndefined();
    finish({ ok: true, sealed: 3, failed: [], next: "c", remaining: 0 });
    await new Promise((r) => setTimeout(r, 0));
    expect(view.text()).toContain("すべて暗号化しました。");
    expect(seal.fn).toHaveBeenCalledTimes(1);
  });
});

describe("every slow button of 設定 shows its press", () => {
  it("each Server Action form submits with PressButton, not a bare button", () => {
    for (const file of ["dropped/page.tsx", "trouble/page.tsx", "demo-loader.tsx"]) {
      const forms = [...settings(file).matchAll(/<form action=\{[^}]+\}[\s\S]*?<\/form>/g)].map((m) => m[0]);
      expect(forms.length, file).toBeGreaterThan(0);
      for (const form of forms) {
        expect(form, file).not.toMatch(/<button\b/);
        expect(form + settings(file), file).toMatch(/<PressButton|<LoadButton|<ClearButton/);
      }
    }
    // The ones named in the review, each with its busy words.
    const all = settings("dropped/page.tsx") + settings("trouble/page.tsx") + settings("demo-loader.tsx");
    for (const [label, busy] of [
      ["読み取る", "読み取っています…"],
      ["これは荷物", "記録しています…"],
      ["外す", "外しています…"],
      ["サンプルのメールを読み込む", "読み込んでいます…"],
      ["消す", "消しています…"],
    ]) {
      expect(all).toContain(`label="${label}" busyLabel="${busy}"`);
    }
  });

  it("the password panel's buttons: the spinner, a ref guard, and no disabled while busy", () => {
    const panel = settings("password-panel.tsx");
    expect(panel).not.toMatch(DISABLED_WHILE_BUSY);
    expect(panel).not.toMatch(/(?<![-\w])disabled=/);
    // 「鍵を作る」 and 「変える」 through the shared submit button, 「暗号化する」 as before.
    expect(panel.match(/<PendingSubmitButton pending=\{busy && !needsTick\}/g)).toHaveLength(2);
    expect(panel.match(/pressLabel\(busy,/g)).toHaveLength(1);
    // Every run starts by taking the ref, and gives it back when it ends.
    expect(panel.match(/running\.current = true;/g)).toHaveLength(3);
    expect(panel.match(/running\.current = false;/g)).toHaveLength(3);
    for (const words of ["作っています…", "変えています…", "暗号化しています…"]) expect(panel).toContain(words);
  });

  it("negative control: the checks catch a bare button and a disabled-while-busy one", () => {
    const bare = '<form action={readWaitingMail}><button type="submit">読み取る</button></form>';
    expect(bare).toMatch(/<button\b/);
    expect('<button disabled={busy} className={primary}>').toMatch(DISABLED_WHILE_BUSY);
    expect('<button disabled={busy || !old} className={primary}>').toMatch(DISABLED_WHILE_BUSY);
    expect("<button aria-disabled={busy || undefined}>").not.toMatch(DISABLED_WHILE_BUSY);
  });
});
