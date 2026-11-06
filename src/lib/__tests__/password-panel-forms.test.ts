import { beforeEach, describe, expect, it, vi } from "vitest";
import { PASSWORD_MIN_LENGTH } from "@/lib/crypto/password-v1";
import { LOGIN_MESSAGES } from "@/lib/login-errors";
import { RESET_LOSES_MAIL } from "@/lib/mail-notices";
import type { TokenField } from "@/lib/turnstile";
import { fakeEvent, type Host } from "./element-tree";
import { mount, type Mounted } from "./hook-harness";

/**
 * The forms of 設定's password panel (src/app/app/settings/password-panel.tsx), pressed:
 *  - 「鍵を作る」 (no key in use): the password signs in once more, then the key is made; a key that
 *    does not open with it offers 「ほかのパスワードで開く」, below the form and not in it.
 *  - 「パスワードを変える」: the new password's rule in the browser, the press at once, and each
 *    answer in its fixed words; the fields stay after a refusal the same change fixes.
 * The steps themselves are password-flows.test.ts's; the bot check is captcha-enforced-forms.test.ts's.
 */

const flows = vi.hoisted(() => ({ signIn: vi.fn(), change: vi.fn() }));
const router = vi.hoisted(() => ({ refresh: vi.fn() }));
const other = vi.hoisted(() => ({ props: null as { email: string; openWithAnother: unknown; onOpened: () => void } | null }));

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
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: router.refresh, push: vi.fn(), replace: vi.fn(), back: vi.fn(), prefetch: vi.fn() }) }));
vi.mock("@/app/login/turnstile-widget", () => ({
  TurnstileWidget: (props: { tokenRef: { current: TokenField } }) => {
    props.tokenRef.current.value = "0.token";
    return null;
  },
}));
vi.mock("@/app/login/other-password-form", async () => {
  const { createElement: h } = await import("react");
  return {
    OtherPasswordForm: (props: { email: string; openWithAnother: unknown; onOpened: () => void }) => {
      other.props = props;
      return h("form", { "data-other-password": "" });
    },
  };
});
vi.mock("@/lib/crypto/password-flows", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/crypto/password-flows")>()), signInAndOpenKey: flows.signIn, changePassword: flows.change }));
vi.mock("@/app/login/actions", () => ({ signInWithAuthSecret: vi.fn() }));
vi.mock("@/app/login/session-actions", () => ({ readSignedInAddress: vi.fn() }));
vi.mock("@/app/app/settings/key-actions", () => ({ readMailKey: vi.fn(), registerMailKey: vi.fn(), activateMailKey: vi.fn(), rewrapMailKey: vi.fn(), sealStoredMail: vi.fn(), readSealedMail: vi.fn() }));
vi.mock("@/app/app/settings/password-actions", () => ({ changeLoginSecret: vi.fn() }));

const { MakeKeyForm, ChangeForm } = await import("@/app/app/settings/password-panel");

const USER = "00000000-0000-4000-8000-00000000000a";
const EMAIL = "qa@example.com";
const PASSWORD = "うちの猫は三毛で7歳";
const NEW_PASSWORD = "となりの犬は柴で3歳";

const textOfHost = (h: Host | string): string => (typeof h === "string" ? h : h.children.map(textOfHost).join(""));
const drawn = () => new Promise<void>((resolve) => queueMicrotask(() => queueMicrotask(resolve)));
const byLabel = (view: Mounted, label: string) => view.host((h) => h.type === "input" && h.props["aria-label"] === label);
const type = (view: Mounted, label: string, value: string) => (byLabel(view, label).props.onChange as (e: unknown) => void)({ target: { value } });
const button = (view: Mounted) => view.host((h) => h.type === "button");
/** The panel's own form (the stand-in for 「ほかのパスワードで開く」 is a form too). */
const ownForm = (view: Mounted) => view.host((h) => h.type === "form" && !("data-other-password" in h.props));
const press = (view: Mounted) => (ownForm(view).props.onSubmit as (e: unknown) => Promise<void>)(fakeEvent());
const contains = (h: Host, pred: (n: Host) => boolean): boolean => h.children.some((c) => typeof c !== "string" && (pred(c) || contains(c, pred)));

beforeEach(() => {
  flows.signIn.mockReset();
  flows.change.mockReset();
  router.refresh.mockReset();
  other.props = null;
});

describe("設定: 鍵を作る", () => {
  async function typed() {
    const view = mount(() => MakeKeyForm({ email: EMAIL }));
    type(view, "パスワード", PASSWORD);
    await drawn();
    return view;
  }

  it("shows 「作っています…」 at once, signs in with the session's address, and draws the page again once the key is made", async () => {
    let answer!: (v: unknown) => void;
    flows.signIn.mockReturnValue(new Promise((r) => (answer = r)));
    const view = await typed();
    expect(textOfHost(button(view))).toBe("鍵を作る");
    const done = press(view);
    await drawn();
    expect(textOfHost(button(view))).toBe("作っています…");
    expect(button(view).props.disabled).toBeUndefined();
    void press(view);
    await drawn();
    expect(flows.signIn).toHaveBeenCalledTimes(1);
    expect(flows.signIn.mock.calls[0][0]).toEqual({ email: EMAIL, password: PASSWORD, captchaToken: "0.token" });
    answer({ ok: true, userId: USER, key: "made" });
    await done;
    await drawn();
    expect(router.refresh).toHaveBeenCalledTimes(1);
    expect(byLabel(view, "パスワード").props.value).toBe("");
  });

  it("a refused sign-in is the password (the address is the session's)", async () => {
    flows.signIn.mockResolvedValue({ ok: false, code: "credentials" });
    const view = await typed();
    await press(view);
    await drawn();
    expect(view.text()).toContain(LOGIN_MESSAGES.wrong_password);
    expect(view.text()).not.toContain(LOGIN_MESSAGES.credentials);
  });

  it.each(["stale_session", "signed_out"] as const)("%s offers the login, back to 設定", async (code) => {
    flows.signIn.mockResolvedValue({ ok: true, userId: USER, key: "failed", code });
    const view = await typed();
    await press(view);
    await drawn();
    expect(view.text()).toContain(LOGIN_MESSAGES[code]);
    expect(view.hosts((h) => h.type === "a").map((a) => [a.props.href, textOfHost(a)])).toEqual([["/login?next=%2Fapp%2Fsettings", "ログイン"]]);
  });

  it("a key that does not open with it: says so, offers another password below the form, and the reset", async () => {
    const openWithAnother = vi.fn();
    flows.signIn.mockResolvedValue({ ok: true, userId: USER, key: "not_opened", openWithAnother });
    const view = await typed();
    await press(view);
    await drawn();
    expect(view.text()).toContain(LOGIN_MESSAGES.key_not_opened);
    expect(view.text()).toContain(RESET_LOSES_MAIL);
    expect(other.props).toMatchObject({ email: EMAIL, openWithAnother });
    // A form of its own: never inside the panel's (a form in a form is not HTML).
    expect(contains(ownForm(view), (n) => n.type === "form")).toBe(false);
    expect(view.hosts((h) => h.type === "a").map((a) => [a.props.href, textOfHost(a)])).toEqual([["/login/forgot", "再設定する"]]);
    other.props!.onOpened();
    expect(router.refresh).toHaveBeenCalledTimes(1);
  });
});

describe("設定: パスワードを変える", () => {
  async function typed(next = NEW_PASSWORD, again = next) {
    const view = mount(() => ChangeForm({ userId: USER, email: EMAIL, withCheck: true }));
    type(view, "今のパスワード", PASSWORD);
    type(view, "新しいパスワード", next);
    type(view, "新しいパスワードをもう一度", again);
    await drawn();
    return view;
  }
  const fields = (view: Mounted) => ["今のパスワード", "新しいパスワード", "新しいパスワードをもう一度"].map((l) => byLabel(view, l).props.value);

  it("a new password against the rule is told in the browser, and nothing is sent", async () => {
    const view = await typed("みじかい");
    await press(view);
    await drawn();
    expect(view.text()).toContain(`${PASSWORD_MIN_LENGTH} 文字以上にしてください`);
    const twice = await typed(NEW_PASSWORD, "となりの犬は柴で4歳");
    await press(twice);
    await drawn();
    expect(twice.text()).toContain("2 回の入力が違います");
    expect(flows.change).not.toHaveBeenCalled();
  });

  it("shows 「変えています…」 at once, sends both with the session's address, then says it changed and empties the fields", async () => {
    let answer!: (v: unknown) => void;
    flows.change.mockReturnValue(new Promise((r) => (answer = r)));
    const view = await typed();
    const done = press(view);
    await drawn();
    expect(textOfHost(button(view))).toBe("変えています…");
    expect(flows.change.mock.calls[0][0]).toEqual({ email: EMAIL, userId: USER, current: PASSWORD, next: NEW_PASSWORD, captchaToken: "0.token" });
    answer({ ok: true });
    await done;
    await drawn();
    expect(view.text()).toContain("変えました。前のメールも新しいパスワードで開けます。");
    expect(fields(view)).toEqual(["", "", ""]);
  });

  it("a refusal the same change fixes keeps the fields, with words that say so", async () => {
    flows.change.mockResolvedValue({ ok: false, code: "secret_change_refused_key_new" });
    const view = await typed();
    await press(view);
    await drawn();
    expect(view.text()).toContain("パスワードを変えられませんでした。同じ新しいパスワードで、もう一度お試しください。");
    expect(fields(view)).toEqual([PASSWORD, NEW_PASSWORD, NEW_PASSWORD]);
    flows.change.mockResolvedValue({ ok: true });
    await press(view);
    await drawn();
    expect(flows.change.mock.calls[1][0]).toMatchObject({ current: PASSWORD, next: NEW_PASSWORD });
    expect(view.text()).toContain("変えました。");
  });

  it("an unknown outcome empties the fields (the current password may not be the one any more)", async () => {
    flows.change.mockResolvedValue({ ok: false, code: "secret_change_unknown" });
    const view = await typed();
    await press(view);
    await drawn();
    expect(view.text()).toContain(LOGIN_MESSAGES.secret_change_unknown);
    expect(fields(view)).toEqual(["", "", ""]);
  });

  it.each(["wrong_current_password", "same_secret", "rate", "stale_session"] as const)("%s is told with its fixed words", async (code) => {
    flows.change.mockResolvedValue({ ok: false, code });
    const view = await typed();
    await press(view);
    await drawn();
    expect(view.text()).toContain(LOGIN_MESSAGES[code]);
  });
});
