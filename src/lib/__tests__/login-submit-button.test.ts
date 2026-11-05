import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The login button shows that the press registered: spinner and 「送信中…」 while the form is
 * being sent. It is never `disabled`; a second press while sending is cancelled instead.
 */

const status = vi.hoisted(() => ({ pending: false }));
vi.mock("react-dom", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-dom")>()),
  useFormStatus: () => ({ pending: status.pending, data: null, method: null, action: null }),
}));

const { LoginSubmitButton } = await import("@/app/login/submit-button");

type ButtonProps = { type: string; disabled?: unknown; onClick: (e: { preventDefault: () => void }) => void };
const button = () => LoginSubmitButton() as ReactElement<ButtonProps>;
const html = () => renderToStaticMarkup(createElement(LoginSubmitButton));

beforeEach(() => {
  status.pending = false;
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

  it("is never disabled, idle or sending", () => {
    for (const pending of [false, true]) {
      status.pending = pending;
      expect(html()).not.toMatch(/\sdisabled(=|\s|>)/);
      expect(button().props.disabled).toBeUndefined();
      expect(button().props.type).toBe("submit");
    }
  });

  it("lets the first press through and cancels a second press while sending", () => {
    const first = { preventDefault: vi.fn() };
    button().props.onClick(first);
    expect(first.preventDefault).not.toHaveBeenCalled();

    status.pending = true;
    const second = { preventDefault: vi.fn() };
    button().props.onClick(second);
    expect(second.preventDefault).toHaveBeenCalledTimes(1);
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
