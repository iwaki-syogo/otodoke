import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { KEY_SESSION_STALE, LOGIN_MESSAGES } from "@/lib/login-errors";
import { RESET_LOSES_MAIL } from "@/lib/mail-notices";
import { fakeEvent, type Host } from "./element-tree";
import { findAll, parseHtml, textOf } from "./html-tree";
import { mount, type Mounted } from "./hook-harness";

/**
 * /reset-password (src/app/reset-password/): the form only on a session a reset link made in the
 * last 15 minutes, with the account it is for and what a reset costs; the way to a new mail
 * otherwise. The form runs finishPasswordReset, moves on to /app inside the tab, and offers
 * 「もう一度試す」 when it did not go through.
 */

const USER = "00000000-0000-4000-8000-00000000000a";
const EMAIL = "someone@example.test";
const PASSWORD = "あたらしいパスワードです";

const mocks = vi.hoisted(() => ({ fresh: vi.fn(), finish: vi.fn(), to: [] as string[], real: null as unknown as (...args: unknown[]) => unknown }));
const keys = vi.hoisted(() => ({ read: vi.fn(), register: vi.fn() }));

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
vi.mock("@/components/leave-for", () => ({
  LeaveFor: ({ href }: { href: string }) => {
    mocks.to.push(href);
    return null;
  },
}));
vi.mock("@/lib/auth-session", () => ({ freshCookieSession: mocks.fresh }));
vi.mock("@/lib/crypto/password-flows", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/crypto/password-flows")>();
  mocks.real = actual.finishPasswordReset as never;
  return { ...actual, finishPasswordReset: mocks.finish };
});
vi.mock("@/app/reset-password/actions", () => ({ finishReset: vi.fn() }));
vi.mock("@/app/app/settings/key-actions", () => ({ readMailKey: keys.read, registerMailKey: keys.register }));
// The seam test runs the real reset steps: master is made quickly there.
vi.mock("@/lib/crypto/password-v1", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/crypto/password-v1")>();
  return { ...actual, deriveMaster: async () => crypto.subtle.importKey("raw", new Uint8Array(32), "HKDF", false, ["deriveBits", "deriveKey"]) };
});

const ResetPasswordPage = (await import("@/app/reset-password/page")).default;
const { ResetForm } = await import("@/app/reset-password/reset-form");

const page = async () => parseHtml(renderToStaticMarkup(await ResetPasswordPage()));
const textOfHost = (h: Host | string): string => (typeof h === "string" ? h : h.children.map(textOfHost).join(""));
const button = (view: Mounted) => view.host((h) => h.type === "button");
const drawn = () => new Promise<void>((resolve) => queueMicrotask(() => queueMicrotask(resolve)));
const type = (view: Mounted, id: string, value: string) => (view.host((h) => h.type === "input" && h.props.id === id).props.onChange as (e: unknown) => void)({ target: { value } });
const press = (view: Mounted) => (view.host((h) => h.type === "form").props.onSubmit as (e: unknown) => Promise<void>)(fakeEvent());

async function filled(password = PASSWORD, again = password) {
  const view = mount(() => ResetForm({ email: EMAIL, userId: USER }));
  type(view, "reset-password", password);
  type(view, "reset-password-again", again);
  await drawn();
  return view;
}

beforeEach(() => {
  mocks.fresh.mockReset();
  mocks.finish.mockReset();
  mocks.to = [];
});

describe("the page, by the session", () => {
  it("a reset link's session: the account, what a reset costs, and the form", async () => {
    mocks.fresh.mockResolvedValue({ ok: true, session: { userId: USER, email: EMAIL, amr: [] } });
    const root = await page();
    expect(mocks.fresh).toHaveBeenCalledWith("reset");
    expect(textOf(root)).toContain(`このアカウント: ${EMAIL}`);
    expect(textOf(root)).toContain(RESET_LOSES_MAIL);
    const [form] = findAll(root, (n) => n.tag === "form");
    expect(findAll(form, (n) => n.tag === "input" && n.attrs.type === "password")).toHaveLength(2);
  });

  it("no session: asks to open the mail's link, and offers a new mail", async () => {
    mocks.fresh.mockResolvedValue({ ok: false, reason: "signed_out" });
    const root = await page();
    expect(textOf(root)).toContain("メールのリンクから開いてください。");
    expect(findAll(root, (n) => n.tag === "form")).toHaveLength(0);
    expect(findAll(root, (n) => n.tag === "a").map((a) => [a.attrs.href, textOf(a)])).toContainEqual(["/login/forgot", "再設定のメールを送る"]);
  });

  it("a session too old for it (or one that signed in with the password): the expired words, and a new mail", async () => {
    mocks.fresh.mockResolvedValue({ ok: false, reason: "stale" });
    const root = await page();
    expect(textOf(root)).toContain(LOGIN_MESSAGES.reset_expired);
    expect(findAll(root, (n) => n.tag === "form")).toHaveLength(0);
  });

  it("Supabase could not be asked: says so, never as a missing link", async () => {
    mocks.fresh.mockResolvedValue({ ok: false, reason: "unknown" });
    const text = textOf(await page());
    expect(text).toContain(LOGIN_MESSAGES.network);
    expect(text).not.toContain("メールのリンクから開いてください。");
  });
});

describe("the form", () => {
  it("shows the press at once, runs the reset with the session's address, and moves on to /app in the tab", async () => {
    let answer!: (v: unknown) => void;
    mocks.finish.mockReturnValue(new Promise((r) => (answer = r)));
    const view = await filled();
    const done = press(view);
    await drawn();
    expect(textOfHost(button(view))).toBe("再設定しています…");
    expect(button(view).props["aria-busy"]).toBe(true);
    expect(mocks.finish.mock.calls[0][0]).toEqual({ email: EMAIL, userId: USER, password: PASSWORD });
    answer({ ok: true });
    await done;
    await drawn();
    expect(mocks.to).toEqual(["/app"]);
    expect(textOfHost(button(view))).toBe("再設定しています…");
  });

  it("when only the activation failed: the fixed words, and 「もう一度試す」 runs it again", async () => {
    mocks.finish.mockResolvedValueOnce({ ok: false, code: "key_failed" }).mockResolvedValueOnce({ ok: true });
    const view = await filled();
    await press(view);
    await drawn();
    expect(view.text()).toContain(LOGIN_MESSAGES.key_failed);
    expect(textOfHost(button(view))).toBe("もう一度試す");
    await press(view);
    await drawn();
    expect(mocks.finish).toHaveBeenCalledTimes(2);
    expect(mocks.to).toEqual(["/app"]);
  });

  it.each(["reset_expired", "signed_out"] as const)("%s: the words and the way to a new mail, no retry", async (code) => {
    mocks.finish.mockResolvedValue({ ok: false, code });
    const view = await filled();
    await press(view);
    await drawn();
    expect(view.text()).toContain(LOGIN_MESSAGES[code]);
    expect(view.hosts((h) => h.type === "button")).toHaveLength(0);
    expect(view.hosts((h) => h.type === "a").map((a) => a.props.href)).toEqual(["/login/forgot"]);
  });

  it("a password that breaks the rule, or two that differ, are told before anything is made", async () => {
    let view = await filled("aaaaaaaaaaaa");
    await press(view);
    await drawn();
    expect(view.text()).toContain("推測されやすいパスワードです");
    view = await filled(PASSWORD, "ちがう");
    await press(view);
    await drawn();
    expect(view.text()).toContain("2 回の入力が違います");
    expect(mocks.finish).not.toHaveBeenCalled();
  });

  it("seam: a reset link older than 15 minutes, as the key Action answers it, shows the expired reset and the way to a new mail", async () => {
    mocks.finish.mockImplementation(mocks.real);
    keys.read.mockResolvedValue({ ok: true, key: null });
    keys.register.mockResolvedValue({ ok: false, error: KEY_SESSION_STALE });
    const view = await filled();
    await press(view);
    await vi.waitFor(() => expect(view.text()).toContain(LOGIN_MESSAGES.reset_expired));
    expect(view.text()).not.toContain(LOGIN_MESSAGES.stale_session);
    expect(view.hosts((h) => h.type === "a").map((a) => [a.props.href, textOfHost(a)])).toEqual([["/login/forgot", "再設定のメールを送る"]]);
    expect(view.hosts((h) => h.type === "button")).toHaveLength(0);
    expect(mocks.to).toEqual([]);
  });

  it("keeps the session's address for a password manager, in a field without a name", async () => {
    const view = await filled();
    const username = view.host((h) => h.type === "input" && h.props.autoComplete === "username");
    expect(username.props).toMatchObject({ value: EMAIL, readOnly: true, hidden: true });
    expect(username.props).not.toHaveProperty("name");
    expect(view.hosts((h) => h.type === "input" && h.props.type === "password").map((h) => h.props.autoComplete)).toEqual(["new-password", "new-password"]);
  });
});
