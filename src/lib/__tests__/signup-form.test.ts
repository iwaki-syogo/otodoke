import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PASSWORD_RULE } from "@/lib/crypto/password-v1";
import { LOGIN_MESSAGES } from "@/lib/login-errors";
import type { TokenField } from "@/lib/turnstile";
import { fakeEvent, type Host } from "./element-tree";
import { findAll, parseHtml, textOf } from "./html-tree";
import { mount, type Mounted } from "./hook-harness";

/**
 * /signup (src/app/signup/): the address and the password twice. Only the login secret is sent;
 * the address must be ASCII (decision 9); once sent, the same tab waits for the confirmation
 * (onboarding screen 1: signup-confirm-wait.test.ts) and offers 「メールを送り直す」.
 * The press is shown at once.
 */

const actions = vi.hoisted(() => ({ signUp: vi.fn(), resend: vi.fn() }));
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
vi.mock("@/app/login/actions", () => ({ signUpWithAuthSecret: actions.signUp, resendConfirmation: actions.resend, signInWithAuthSecret: vi.fn() }));
vi.mock("@/app/login/session-actions", () => ({ readSignedInAddress: vi.fn() }));
vi.mock("@/app/app/settings/key-actions", () => ({ readMailKey: vi.fn(), registerMailKey: vi.fn(), activateMailKey: vi.fn(), rewrapMailKey: vi.fn() }));
// The steps are password-flows.test.ts's; here master is made quickly.
vi.mock("@/lib/crypto/password-v1", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/crypto/password-v1")>();
  return { ...actual, deriveMaster: async () => crypto.subtle.importKey("raw", new Uint8Array(32), "HKDF", false, ["deriveBits", "deriveKey"]) };
});

const { SignupForm } = await import("@/app/signup/signup-form");
const SignupPage = (await import("@/app/signup/page")).default;

const EMAIL = "someone@example.test";
const PASSWORD = "うちの猫は三毛で7歳";
const TOKEN = "0.token";

const textOfHost = (h: Host | string): string => (typeof h === "string" ? h : h.children.map(textOfHost).join(""));
const button = (view: Mounted) => view.host((h) => h.type === "button");
/** The waiting screen's 「メールを送り直す」 (it has 「確認しました」 too). */
const resendButton = (view: Mounted) => view.hosts((h) => h.type === "button").at(-1)!;
const type = (view: Mounted, id: string, value: string) => (view.host((h) => h.type === "input" && h.props.id === id).props.onChange as (e: unknown) => void)({ target: { value } });
const press = (view: Mounted) => (view.host((h) => h.type === "form").props.onSubmit as (e: unknown) => Promise<void>)(fakeEvent());
const drawn = () => new Promise<void>((resolve) => queueMicrotask(() => queueMicrotask(resolve)));

async function filled(email = EMAIL, password = PASSWORD, again = password) {
  const view = mount(() => SignupForm());
  widget.token!.current.value = TOKEN;
  type(view, "signup-email", email);
  type(view, "signup-password", password);
  type(view, "signup-password-again", again);
  await drawn();
  return view;
}

beforeEach(() => {
  actions.signUp.mockReset();
  actions.resend.mockReset();
  widget.token = null;
});

describe("making the account", () => {
  it("shows the press at once, sends the address with a login secret only, then says the mail went", async () => {
    let answer!: (v: unknown) => void;
    actions.signUp.mockReturnValue(new Promise((r) => (answer = r)));
    const view = await filled();
    const done = press(view);
    await drawn();
    expect(textOfHost(button(view))).toBe("作っています…");
    expect(button(view).props["aria-busy"]).toBe(true);
    expect(button(view).props.disabled).toBeUndefined();
    await vi.waitFor(() => expect(actions.signUp).toHaveBeenCalledTimes(1));
    const sent = actions.signUp.mock.calls[0][0];
    expect(Object.keys(sent).sort()).toEqual(["authSecret", "captchaToken", "email"]);
    expect(sent).toMatchObject({ email: EMAIL, captchaToken: TOKEN });
    expect(sent.authSecret).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(sent)).not.toContain(PASSWORD);

    answer({ ok: true, code: "signup_exists_or_sent" });
    await done;
    await drawn();
    expect(view.text()).toContain("確認のメールを送りました");
    expect(view.text()).toContain(EMAIL);
    expect(view.hosts((h) => h.type === "input")).toHaveLength(0);
    expect(view.hosts((h) => h.type === "button").map(textOfHost)).toEqual(["確認しました", "メールを送り直す"]);
    expect(widget.round).toBe(1);
  });

  it("「メールを送り直す」 asks for the confirmation mail again, to the same address, and says what came back", async () => {
    actions.signUp.mockResolvedValue({ ok: true, code: "signup_exists_or_sent" });
    actions.resend.mockResolvedValue({ ok: true, code: "confirmation_sent" });
    const view = await filled();
    await press(view);
    await drawn();
    const click = () => (resendButton(view).props.onClick as (e: unknown) => void)(fakeEvent());
    widget.token!.current.value = "0.second-token";
    click();
    await drawn();
    expect(textOfHost(resendButton(view))).toBe("送っています…");
    // The toast of the onboarding words.
    await vi.waitFor(() => expect(view.text()).toContain("送り直しました"));
    expect(view.hosts((h) => h.props.role === "status").map(textOfHost)).toContain("送り直しました");
    expect(actions.resend).toHaveBeenCalledWith({ email: EMAIL, captchaToken: "0.second-token" });
    await vi.waitFor(() => expect(textOfHost(resendButton(view))).toBe("メールを送り直す"));

    actions.resend.mockResolvedValue({ ok: false, code: "rate" });
    click();
    await vi.waitFor(() => expect(view.text()).toContain(LOGIN_MESSAGES.rate));
  });

  it("an address with characters outside ASCII is refused in the browser, before anything is made", async () => {
    const view = await filled("ｓomeone@example.test");
    await press(view);
    await drawn();
    expect(view.text()).toContain(LOGIN_MESSAGES.email_not_ascii);
    expect(actions.signUp).not.toHaveBeenCalled();
  });

  it("a password that breaks the rule, or two that differ, are told before anything is sent", async () => {
    let view = await filled(EMAIL, "1234567890");
    await press(view);
    await drawn();
    expect(view.text()).toContain("推測されやすいパスワードです");
    view = await filled(EMAIL, PASSWORD, `${PASSWORD}!`);
    await press(view);
    await drawn();
    expect(view.text()).toContain("2 回の入力が違います");
    expect(actions.signUp).not.toHaveBeenCalled();
  });

  it.each(["email_not_ascii", "invalid_email", "rate", "captcha", "network", "not_configured", "other"] as const)("the server's %s is told with its fixed words", async (code) => {
    actions.signUp.mockResolvedValue({ ok: false, code });
    const view = await filled();
    await press(view);
    await drawn();
    expect(view.text()).toContain(LOGIN_MESSAGES[code]);
    expect(textOfHost(button(view))).toBe("アカウントを作る");
  });
});

describe("the page", () => {
  it("states the rule and the way to log in, and has no word for those who signed in by a mail's link before", () => {
    const root = parseHtml(renderToStaticMarkup(SignupPage()));
    const text = textOf(root);
    expect(text).toContain(PASSWORD_RULE);
    // Otodoke was made new for the contest: this public page does not read as if people used it
    // before. Those who signed in by a mail's link set a password from 「パスワードを忘れた」 on /login.
    expect(text).not.toContain("前にメールのリンクでログインしていた方は");
    expect(text).not.toMatch(/ログインしていた|メールのリンクでログイン/);
    const anchors = findAll(root, (n) => n.tag === "a").map((a) => [a.attrs.href, textOf(a)]);
    expect(anchors).toContainEqual(["/login", "ログイン"]);
    expect(findAll(root, (n) => n.tag === "h1").map(textOf)).toEqual(["アカウントを作る"]);
  });

  it("the privacy policy can be read before the account is made: one link, right after the form, worded as on the top page", () => {
    const html = renderToStaticMarkup(SignupPage());
    const anchors = findAll(parseHtml(html), (n) => n.tag === "a" && n.attrs.href === "/privacy");
    expect(anchors.map(textOf)).toEqual(["プライバシーポリシー"]);
    // Right after the form, before the way to log in (the judges looked for it there).
    expect(html.indexOf('href="/privacy"')).toBeGreaterThan(html.indexOf("</form>"));
    expect(html.indexOf('href="/privacy"')).toBeLessThan(html.indexOf('href="/login"'));
  });
});
