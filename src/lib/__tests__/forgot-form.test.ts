import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LOGIN_MESSAGES } from "@/lib/login-errors";
import { RESET_LOSES_MAIL } from "@/lib/mail-notices";
import type { TokenField } from "@/lib/turnstile";
import { fakeEvent, type Host } from "./element-tree";
import { findAll, parseHtml, textOf } from "./html-tree";
import { mount, type Mounted } from "./hook-harness";

/**
 * /login/forgot (src/app/login/forgot/): the address and the reset mail. What a reset costs is
 * said before anything is sent (RESET_LOSES_MAIL). The answer is the server's, the same for every
 * address; the press is shown at once.
 */

const actions = vi.hoisted(() => ({ sendResetMail: vi.fn() }));
const widget = vi.hoisted(() => ({ token: null as { current: TokenField } | null, round: -1 }));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { harnessHooks } = await import("./hook-harness");
  return harnessHooks(actual);
});
vi.mock("next/link", async () => {
  const { createElement: h } = await import("react");
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const Link = ({ href, children, prefetch, ...rest }: Record<string, unknown>) => h("a", { href: String(href), ...rest }, children as never);
  return { default: Link };
});
vi.mock("@/components/wordmark", () => ({ Wordmark: () => "Otodoke" }));
vi.mock("@/app/login/turnstile-widget", () => ({
  TurnstileWidget: (props: { tokenRef: { current: TokenField }; round: number }) => {
    widget.token = props.tokenRef;
    widget.round = props.round;
    return null;
  },
}));
vi.mock("@/app/login/actions", () => ({ sendResetMail: actions.sendResetMail, signInWithAuthSecret: vi.fn() }));
vi.mock("@/app/login/session-actions", () => ({ readSignedInAddress: vi.fn() }));
vi.mock("@/app/app/settings/key-actions", () => ({ readMailKey: vi.fn(), registerMailKey: vi.fn(), activateMailKey: vi.fn() }));

const { ForgotForm } = await import("@/app/login/forgot/forgot-form");
const ForgotPage = (await import("@/app/login/forgot/page")).default;

const textOfHost = (h: Host | string): string => (typeof h === "string" ? h : h.children.map(textOfHost).join(""));
const button = (view: Mounted) => view.host((h) => h.type === "button");
const drawn = () => new Promise<void>((resolve) => queueMicrotask(() => queueMicrotask(resolve)));

async function filled(email: string) {
  const view = mount(() => ForgotForm());
  widget.token!.current.value = "0.token";
  (view.host((h) => h.type === "input").props.onChange as (e: unknown) => void)({ target: { value: email } });
  await drawn();
  return view;
}
const press = (view: Mounted) => (view.host((h) => h.type === "form").props.onSubmit as (e: unknown) => Promise<void>)(fakeEvent());

beforeEach(() => {
  actions.sendResetMail.mockReset();
});

describe("the reset mail", () => {
  it("shows the press at once, sends the address and the token, and answers with the server's words", async () => {
    let answer!: (v: unknown) => void;
    actions.sendResetMail.mockReturnValue(new Promise((r) => (answer = r)));
    const view = await filled("someone@example.test");
    const done = press(view);
    await drawn();
    expect(textOfHost(button(view))).toBe("送っています…");
    expect(button(view).props["aria-busy"]).toBe(true);
    await vi.waitFor(() => expect(actions.sendResetMail).toHaveBeenCalledWith({ email: "someone@example.test", captchaToken: "0.token" }));
    answer({ ok: true, code: "reset_sent" });
    await done;
    await drawn();
    expect(view.text()).toContain(LOGIN_MESSAGES.reset_sent);
    expect(textOfHost(button(view))).toBe("再設定のメールを送る");
    expect(widget.round).toBe(1);
  });

  it.each(["rate", "captcha", "network", "invalid_email", "not_configured", "other", "mail_busy"] as const)("%s gets its fixed words", async (code) => {
    actions.sendResetMail.mockResolvedValue({ ok: false, code });
    const view = await filled("someone@example.test");
    await press(view);
    await drawn();
    expect(view.text()).toContain(LOGIN_MESSAGES[code]);
    expect(view.text()).not.toContain(LOGIN_MESSAGES.reset_sent);
  });

  it("an Action that does not answer is told as no connection, not left spinning", async () => {
    actions.sendResetMail.mockRejectedValue(new Error("offline"));
    const view = await filled("someone@example.test");
    await press(view);
    await drawn();
    expect(view.text()).toContain(LOGIN_MESSAGES.network);
    expect(textOfHost(button(view))).toBe("再設定のメールを送る");
  });

  it("an address that cannot be one is told at once, and nothing is sent", async () => {
    const view = await filled("someone");
    await press(view);
    await drawn();
    expect(view.text()).toContain(LOGIN_MESSAGES.invalid_email);
    expect(actions.sendResetMail).not.toHaveBeenCalled();
  });
});

describe("the page", () => {
  it("says what a reset costs before anything is sent, and has no named field", () => {
    const root = parseHtml(renderToStaticMarkup(ForgotPage()));
    expect(textOf(root)).toContain(RESET_LOSES_MAIL);
    expect(RESET_LOSES_MAIL).toBe("パスワードを決め直すと、前に暗号化して保存したメールは開けなくなります。荷物は残ります。");
    const [form] = findAll(root, (n) => n.tag === "form");
    expect(form.attrs.method).toBe("post");
    expect(form.attrs).not.toHaveProperty("action");
    expect(findAll(form, (n) => "name" in n.attrs)).toEqual([]);
  });
});
