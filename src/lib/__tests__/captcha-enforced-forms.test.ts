import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { LOGIN_MESSAGES } from "@/lib/login-errors";
import { CAPTCHA_ENFORCED, TURNSTILE_WAIT_MS, type TokenField } from "@/lib/turnstile";
import { fakeEvent } from "./element-tree";
import { mount, type Mounted } from "./hook-harness";

/**
 * Every press that asks Supabase Auth for something, with CAPTCHA enforced: CAPTCHA_ENFORCED is
 * set to true when Supabase's CAPTCHA protection is turned on, with the password sign-in on the
 * web and on iOS. Supabase then wants a Turnstile token for the sign-in (/login, and 設定's
 * 「鍵を作る」), the signup and its 「送り直す」, the reset mail, and 「パスワードを変える」
 * (changeLoginSecret checks the current password with a sign-in).
 *
 *  - A press waits for the token, past the TURNSTILE_WAIT_MS after which it goes without one while
 *    CAPTCHA is off, and the Action gets it.
 *  - A token is checked once: after a press the widget moves on to a new one (`round`), and the
 *    next press waits for that one and sends it, never the one used.
 *
 * Not here: opening the key again (UnlockForm) and /reset-password's finishReset (updateUser
 * only) do not ask Supabase Auth to check a token, and have no bot check.
 */

const actions = vi.hoisted(() => ({
  signIn: vi.fn(),
  signUp: vi.fn(),
  resend: vi.fn(),
  resetMail: vi.fn(),
  change: vi.fn(),
  readAddress: vi.fn(),
  readMailKey: vi.fn(),
}));
/** The widget as the form drew it last: where its token goes, and its round. */
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
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn(), back: vi.fn(), prefetch: vi.fn() }) }));
vi.mock("@/components/leave-for", () => ({ LeaveFor: () => null }));
// The real widget empties the token when `round` moves on (and resets Turnstile): the next token
// comes from Turnstile, here from the test.
vi.mock("@/app/login/turnstile-widget", () => ({
  TurnstileWidget: (props: { tokenRef: { current: TokenField }; round: number }) => {
    if (widget.token === props.tokenRef && widget.round !== props.round) props.tokenRef.current.value = "";
    widget.token = props.tokenRef;
    widget.round = props.round;
    return null;
  },
}));
// tokenForPress reads CAPTCHA_ENFORCED inside turnstile.ts (its default), which a mocked export
// does not reach: it is given true here the same way. A form that passed its own value would win.
vi.mock("@/lib/turnstile", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/turnstile")>();
  return {
    ...actual,
    CAPTCHA_ENFORCED: true,
    tokenForPress: (field: TokenField, options: Parameters<typeof actual.tokenForPress>[1] = {}) => actual.tokenForPress(field, { captchaEnforced: true, ...options }),
  };
});
vi.mock("@/app/login/actions", () => ({ signInWithAuthSecret: actions.signIn, signUpWithAuthSecret: actions.signUp, resendConfirmation: actions.resend, sendResetMail: actions.resetMail }));
vi.mock("@/app/login/session-actions", () => ({ readSignedInAddress: actions.readAddress }));
vi.mock("@/app/app/settings/key-actions", () => ({ readMailKey: actions.readMailKey, registerMailKey: vi.fn(), activateMailKey: vi.fn(), rewrapMailKey: vi.fn(), sealStoredMail: vi.fn(), readSealedMail: vi.fn() }));
vi.mock("@/app/app/settings/password-actions", () => ({ changeLoginSecret: actions.change }));
// The steps are password-flows.test.ts's; here master is made quickly.
vi.mock("@/lib/crypto/password-v1", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/crypto/password-v1")>();
  return { ...actual, deriveMaster: async () => crypto.subtle.importKey("raw", new Uint8Array(32), "HKDF", false, ["deriveBits", "deriveKey"]) };
});

const { LoginForm } = await import("@/app/login/login-form");
const { SignupForm } = await import("@/app/signup/signup-form");
const { ForgotForm } = await import("@/app/login/forgot/forgot-form");
const { MakeKeyForm, ChangeForm } = await import("@/app/app/settings/password-panel");

const USER = "00000000-0000-4000-8000-00000000000a";
const EMAIL = "someone@example.test";
const PASSWORD = "うちの猫は三毛で7歳";
const NEW_PASSWORD = "となりの犬は柴で3歳";
/** What Supabase answers a token it does not take (a used one among them). */
const REFUSED = { ok: false, code: "captcha" };

const drawn = () => new Promise<void>((resolve) => queueMicrotask(() => queueMicrotask(resolve)));
const input = (view: Mounted, pick: (props: Record<string, unknown>) => boolean) => view.host((h) => h.type === "input" && pick(h.props));
const type = (view: Mounted, pick: (props: Record<string, unknown>) => boolean, value: string) => (input(view, pick).props.onChange as (e: unknown) => void)({ target: { value } });
const byId = (id: string) => (p: Record<string, unknown>) => p.id === id;
const byLabel = (label: string) => (p: Record<string, unknown>) => p["aria-label"] === label;
const submit = (view: Mounted) => void (view.host((h) => h.type === "form").props.onSubmit as (e: unknown) => Promise<void>)(fakeEvent());

interface Press {
  name: string;
  /** The Server Action the token goes to, and where it is in what the Action gets. */
  action: Mock;
  /** The form, filled in, with no token yet. */
  open: () => Promise<Mounted>;
  press: (view: Mounted) => void;
}

const PRESSES: Press[] = [
  {
    name: "/login: ログイン",
    action: actions.signIn,
    open: async () => {
      const view = mount(() => LoginForm({ next: "/app" }));
      type(view, byId("login-email"), EMAIL);
      type(view, byId("login-password"), PASSWORD);
      return view;
    },
    press: submit,
  },
  {
    name: "/signup: アカウントを作る",
    action: actions.signUp,
    open: async () => {
      const view = mount(() => SignupForm());
      type(view, byId("signup-email"), EMAIL);
      type(view, byId("signup-password"), PASSWORD);
      type(view, byId("signup-password-again"), PASSWORD);
      return view;
    },
    press: submit,
  },
  {
    name: "/signup: 送り直す",
    action: actions.resend,
    open: async () => {
      // Sent first, with a token of its own.
      actions.signUp.mockResolvedValue({ ok: true, code: "signup_exists_or_sent" });
      const view = mount(() => SignupForm());
      type(view, byId("signup-email"), EMAIL);
      type(view, byId("signup-password"), PASSWORD);
      type(view, byId("signup-password-again"), PASSWORD);
      await drawn();
      widget.token!.current.value = "0.token-of-the-signup";
      submit(view);
      await vi.waitFor(() => expect(view.text()).toContain(LOGIN_MESSAGES.signup_exists_or_sent));
      expect(actions.signUp.mock.calls[0][0].captchaToken).toBe("0.token-of-the-signup");
      return view;
    },
    press: (view) => (view.host((h) => h.type === "button").props.onClick as (e: unknown) => void)(fakeEvent()),
  },
  {
    name: "/login/forgot: 再設定のメールを送る",
    action: actions.resetMail,
    open: async () => {
      const view = mount(() => ForgotForm());
      type(view, byId("forgot-email"), EMAIL);
      return view;
    },
    press: submit,
  },
  {
    name: "設定: 鍵を作る",
    action: actions.signIn,
    open: async () => {
      const view = mount(() => MakeKeyForm({ email: EMAIL }));
      type(view, byLabel("パスワード"), PASSWORD);
      return view;
    },
    press: submit,
  },
  {
    name: "設定: パスワードを変える",
    action: actions.change,
    open: async () => {
      const view = mount(() => ChangeForm({ userId: USER, email: EMAIL, withCheck: true }));
      type(view, byLabel("今のパスワード"), PASSWORD);
      type(view, byLabel("新しいパスワード"), NEW_PASSWORD);
      type(view, byLabel("新しいパスワードをもう一度"), NEW_PASSWORD);
      return view;
    },
    press: submit,
  },
];

beforeEach(() => {
  for (const a of Object.values(actions)) a.mockReset();
  actions.readMailKey.mockResolvedValue({ ok: true, key: null });
  widget.token = null;
  widget.round = -1;
});
afterEach(() => {
  vi.useRealTimers();
});

describe("with CAPTCHA enforced", () => {
  it("the forms see CAPTCHA_ENFORCED as true", () => {
    expect(CAPTCHA_ENFORCED).toBe(true);
  });

  it.each(PRESSES)("$name: waits for the token, sends it, and sends a new one the next time", async ({ action, open, press }) => {
    const view = await open();
    action.mockResolvedValue(REFUSED);
    await drawn();
    // The widget of this screen has no token yet.
    expect(widget.token).not.toBeNull();
    widget.token!.current.value = "";
    const round = widget.round;
    vi.useFakeTimers();

    // Held past the 10 s after which a press goes without a token while CAPTCHA is off.
    press(view);
    await vi.advanceTimersByTimeAsync(TURNSTILE_WAIT_MS + 5_000);
    expect(action).not.toHaveBeenCalled();
    widget.token!.current.value = "0.first-token";
    await vi.advanceTimersByTimeAsync(200);
    await vi.waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    expect(action.mock.calls[0][0].captchaToken).toBe("0.first-token");
    // The press is over, the refusal is told, and the widget moved on: the used token is gone.
    await vi.waitFor(() => expect(widget.round).toBe(round + 1));
    await vi.waitFor(() => expect(view.text()).toContain(LOGIN_MESSAGES.captcha));
    expect(widget.token!.current.value).toBe("");

    // The next press waits for the new token, and sends that one.
    press(view);
    await vi.advanceTimersByTimeAsync(TURNSTILE_WAIT_MS + 5_000);
    expect(action).toHaveBeenCalledTimes(1);
    widget.token!.current.value = "0.second-token";
    await vi.advanceTimersByTimeAsync(200);
    await vi.waitFor(() => expect(action).toHaveBeenCalledTimes(2));
    expect(action.mock.calls[1][0].captchaToken).toBe("0.second-token");
    await vi.waitFor(() => expect(widget.round).toBe(round + 2));
  });

  it("a press that does not reach the Action (a failed step before it) still moves the widget on", async () => {
    // A key that neither password opens: the change stops before changeLoginSecret, and the
    // next press still gets a token of its own.
    actions.readMailKey.mockResolvedValue({ ok: false, error: "network" });
    const view = mount(() => ChangeForm({ userId: USER, email: EMAIL, withCheck: true }));
    type(view, byLabel("今のパスワード"), PASSWORD);
    type(view, byLabel("新しいパスワード"), NEW_PASSWORD);
    type(view, byLabel("新しいパスワードをもう一度"), NEW_PASSWORD);
    await drawn();
    widget.token!.current.value = "0.first-token";
    submit(view);
    await vi.waitFor(() => expect(view.text()).toContain(LOGIN_MESSAGES.network));
    expect(actions.change).not.toHaveBeenCalled();
    expect(widget.round).toBe(1);
    expect(widget.token!.current.value).toBe("");
  });
});
