import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { LOGIN_MESSAGES, TURNSTILE_TICK_PROMPT } from "@/lib/login-errors";
import { readStoredKey, registerKey } from "@/lib/mail-keys";
import { CAPTCHA_ENFORCED, CAPTCHA_NOT_FINISHED_MESSAGE, TURNSTILE_ENFORCED_WAIT_MS, TURNSTILE_WAIT_MS, type TokenField } from "@/lib/turnstile";
import { CONFIRM_WAIT } from "@/lib/onboarding";
import { fakeEvent, hostText } from "./element-tree";
import { FakeDb } from "./fake-db";
import { mount, type Mounted } from "./hook-harness";
import { asAdmin } from "./pipeline-fixtures";

/**
 * Every press that asks Supabase Auth for something, with CAPTCHA enforced as in production:
 * CAPTCHA_ENFORCED is true in src/lib/turnstile.ts, released with Supabase's CAPTCHA (nothing here
 * sets it: the forms run with the real value). Supabase then wants a Turnstile token for the
 * sign-in (/login, 設定's 「鍵を作る」, and /signup's 「確認しました」), the signup and its 「送り直す」,
 * the reset mail, and 「パスワードを変える」 (changeLoginSecret checks the current password with a sign-in).
 *
 *  - A press waits for the token, past the TURNSTILE_WAIT_MS after which it goes without one while
 *    CAPTCHA is off, and the Action gets it.
 *  - A token is checked once: after a press the widget moves on to a new one (`round`), and the
 *    next press waits for that one and sends it, never the one used.
 *
 * The people the check could hold up who are no bots (gate-must-list-legitimate-rejections), at
 * every press: whoever presses again after a failure; whoever Turnstile shows its checkbox to (no
 * token comes until it is ticked); whoever's check is slow or never answers; whoever's check
 * cannot load at all. Each press ends in words on the screen and a button that can be pressed
 * again, never in nothing.
 *
 * And the presses Supabase Auth checks no token for go at once, with no bot check: opening the key
 * again (UnlockForm), 「ほかのパスワードで開く」 and /reset-password's finishReset (updateUser only).
 */

const actions = vi.hoisted(() => ({
  signIn: vi.fn(),
  signUp: vi.fn(),
  resend: vi.fn(),
  resetMail: vi.fn(),
  change: vi.fn(),
  readAddress: vi.fn(),
  readMailKey: vi.fn(),
  registerMailKey: vi.fn(),
  finishReset: vi.fn(),
}));
/** The widget as the form drew it last: where its token goes, and its round. */
const widget = vi.hoisted(() => ({ token: null as { current: TokenField } | null, round: -1 }));
const nav = vi.hoisted(() => ({ to: [] as string[] }));

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
vi.mock("@/components/leave-for", () => ({
  LeaveFor: ({ href }: { href: string }) => {
    nav.to.push(href);
    return null;
  },
}));
// The real widget empties the token when `round` moves on (and resets Turnstile): the next token
// comes from Turnstile, here from the test. What it shows (the notice when no token will come) is
// login-turnstile-widget.test.ts's.
vi.mock("@/app/login/turnstile-widget", () => ({
  TurnstileWidget: (props: { tokenRef: { current: TokenField }; round: number }) => {
    if (widget.token === props.tokenRef && widget.round !== props.round) props.tokenRef.current.value = "";
    widget.token = props.tokenRef;
    widget.round = props.round;
    return null;
  },
}));
vi.mock("@/app/login/actions", () => ({ signInWithAuthSecret: actions.signIn, signUpWithAuthSecret: actions.signUp, resendConfirmation: actions.resend, sendResetMail: actions.resetMail }));
vi.mock("@/app/login/session-actions", () => ({ readSignedInAddress: actions.readAddress }));
vi.mock("@/app/app/settings/key-actions", () => ({
  readMailKey: actions.readMailKey,
  registerMailKey: actions.registerMailKey,
  activateMailKey: vi.fn(),
  rewrapMailKey: vi.fn(),
  sealStoredMail: vi.fn(),
  readSealedMail: vi.fn(),
}));
vi.mock("@/app/app/settings/password-actions", () => ({ changeLoginSecret: actions.change }));
vi.mock("@/app/reset-password/actions", () => ({ finishReset: actions.finishReset }));
// The steps are password-flows.test.ts's. Here master and its login secret are made once, before
// any press: made in a press, they would wait on WebCrypto, which the fake clock does not move, and
// "the Action is not called yet" would hold for that reason instead of the wait for the token (with
// CAPTCHA_ENFORCED false, two of these forms passed the slow check's test that way).
vi.mock("@/lib/crypto/password-v1", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/crypto/password-v1")>();
  const master = await crypto.subtle.importKey("raw", new Uint8Array(32), "HKDF", false, ["deriveBits", "deriveKey"]);
  const authSecret = await actual.authSecretHex(master);
  return { ...actual, deriveMaster: async () => master, authSecretHex: async () => authSecret };
});

const { LoginForm } = await import("@/app/login/login-form");
const { SignupForm } = await import("@/app/signup/signup-form");
const { ForgotForm } = await import("@/app/login/forgot/forgot-form");
const { MakeKeyForm, ChangeForm } = await import("@/app/app/settings/password-panel");
const { UnlockForm } = await import("@/app/app/unlock-form");
const { OtherPasswordForm } = await import("@/app/login/other-password-form");
const { ResetForm } = await import("@/app/reset-password/reset-form");

const USER = "00000000-0000-4000-8000-00000000000a";
const EMAIL = "someone@example.test";
const PASSWORD = "うちの猫は三毛で7歳";
const NEW_PASSWORD = "となりの犬は柴で3歳";
/** What Supabase answers a token it does not take (a used one among them), or a press without one. */
const REFUSED = { ok: false, code: "captcha" };

const drawn = () => new Promise<void>((resolve) => queueMicrotask(() => queueMicrotask(resolve)));
const input = (view: Mounted, pick: (props: Record<string, unknown>) => boolean) => view.host((h) => h.type === "input" && pick(h.props));
const type = (view: Mounted, pick: (props: Record<string, unknown>) => boolean, value: string) => (input(view, pick).props.onChange as (e: unknown) => void)({ target: { value } });
const byId = (id: string) => (p: Record<string, unknown>) => p.id === id;
const byLabel = (label: string) => (p: Record<string, unknown>) => p["aria-label"] === label;
const submit = (view: Mounted) => void (view.host((h) => h.type === "form").props.onSubmit as (e: unknown) => Promise<void>)(fakeEvent());
const spinners = (view: Mounted) => view.hosts((h) => h.type === "span" && String(h.props.className).includes("animate-spin"));

interface Press {
  name: string;
  /** The Server Action the token goes to, and where it is in what the Action gets. */
  action: Mock;
  /** The words next to the spinner while the press is on its way. */
  pending: string;
  /** The form, filled in, with no token yet. */
  open: () => Promise<Mounted>;
  press: (view: Mounted) => void;
}

/** /signup with its mail sent (with a token of its own): the screen that waits for the confirmation. */
async function signedUp(): Promise<Mounted> {
  actions.signUp.mockResolvedValue({ ok: true, code: "signup_exists_or_sent" });
  const view = mount(() => SignupForm());
  type(view, byId("signup-email"), EMAIL);
  type(view, byId("signup-password"), PASSWORD);
  type(view, byId("signup-password-again"), PASSWORD);
  await drawn();
  widget.token!.current.value = "0.token-of-the-signup";
  submit(view);
  await vi.waitFor(() => expect(view.text()).toContain(CONFIRM_WAIT.title));
  expect(actions.signUp.mock.calls[0][0].captchaToken).toBe("0.token-of-the-signup");
  return view;
}

const PRESSES: Press[] = [
  {
    name: "/login: ログイン",
    action: actions.signIn,
    pending: "ログインしています…",
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
    pending: "作っています…",
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
    pending: "送っています…",
    open: signedUp,
    press: (view) => (view.host((h) => h.type === "button" && hostText(h) === CONFIRM_WAIT.resend).props.onClick as (e: unknown) => void)(fakeEvent()),
  },
  {
    name: "/signup: 確認しました",
    action: actions.signIn,
    pending: "ログインしています…",
    open: signedUp,
    press: (view) => (view.host((h) => h.type === "button" && hostText(h) === CONFIRM_WAIT.done).props.onClick as (e: unknown) => void)(fakeEvent()),
  },
  {
    name: "/login/forgot: 再設定のメールを送る",
    action: actions.resetMail,
    pending: "送っています…",
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
    pending: "作っています…",
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
    pending: "変えています…",
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

/** The form of `press`, filled in and drawn, its Action refusing, and its widget without a token. */
async function ready({ action, open }: Press): Promise<{ view: Mounted; field: TokenField; round: number }> {
  const view = await open();
  action.mockResolvedValue(REFUSED);
  await drawn();
  // The widget of this screen has no token yet.
  expect(widget.token).not.toBeNull();
  const field = widget.token!.current;
  field.value = "";
  return { view, field, round: widget.round };
}

beforeEach(() => {
  for (const a of Object.values(actions)) a.mockReset();
  actions.readMailKey.mockResolvedValue({ ok: true, key: null });
  widget.token = null;
  widget.round = -1;
  nav.to = [];
});
afterEach(() => {
  vi.useRealTimers();
});

describe("with CAPTCHA enforced", () => {
  it("the forms see CAPTCHA_ENFORCED as true: the value of src/lib/turnstile.ts, not a mock's", () => {
    expect(CAPTCHA_ENFORCED).toBe(true);
  });

  it.each(PRESSES)("$name: waits for the token, sends it, and after a refusal sends a new one the next time", async (p) => {
    const { action, press } = p;
    const { view, round } = await ready(p);
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
    // A token that was refused (expired, used): trying again helps, so the shared words stay.
    expect(view.text()).not.toContain(CAPTCHA_NOT_FINISHED_MESSAGE);
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

  it.each(PRESSES)("$name: Turnstile shows the checkbox (no token without the tick): asks for the tick, waits for it however long, then sends its token", async (p) => {
    const { action, press } = p;
    const { view, field } = await ready(p);
    // Managed mode asks this visitor to tick (before-interactive-callback).
    field.dataset.turnstile = "interactive";
    vi.useFakeTimers();

    press(view);
    await vi.advanceTimersByTimeAsync(0);
    expect(view.text()).toContain(TURNSTILE_TICK_PROMPT);
    expect(spinners(view)).toHaveLength(0);
    // The clock stops while the checkbox waits: well past the minute, still held, still asking.
    await vi.advanceTimersByTimeAsync(2 * TURNSTILE_ENFORCED_WAIT_MS);
    expect(action).not.toHaveBeenCalled();
    expect(view.text()).toContain(TURNSTILE_TICK_PROMPT);

    // Ticked: after-interactive-callback, then the token.
    delete field.dataset.turnstile;
    field.value = "0.token-after-the-tick";
    await vi.advanceTimersByTimeAsync(200);
    await vi.waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    expect(action.mock.calls[0][0].captchaToken).toBe("0.token-after-the-tick");
    await vi.waitFor(() => expect(view.text()).toContain(LOGIN_MESSAGES.captcha));
    expect(view.text()).not.toContain(TURNSTILE_TICK_PROMPT);
  });

  it.each(PRESSES)("$name: a check that is slow or never answers: shown as pressed while it waits, sent without a token at TURNSTILE_ENFORCED_WAIT_MS, and the refusal told", async (p) => {
    const { action, press, pending } = p;
    const { view, round } = await ready(p);
    vi.useFakeTimers();

    press(view);
    await vi.advanceTimersByTimeAsync(TURNSTILE_WAIT_MS + 5_000);
    // Still on its way, and it shows: the spinner and its words, not a button that did nothing.
    expect(action).not.toHaveBeenCalled();
    expect(view.text()).toContain(pending);
    expect(spinners(view)).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(TURNSTILE_ENFORCED_WAIT_MS - TURNSTILE_WAIT_MS - 5_000 + 200);
    await vi.waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    expect(action.mock.calls[0][0].captchaToken).toBeUndefined();
    // No token was sent, so "try again" would meet the same refusal: the Web-only words say so.
    await vi.waitFor(() => expect(view.text()).toContain(CAPTCHA_NOT_FINISHED_MESSAGE));
    expect(view.text()).not.toContain(LOGIN_MESSAGES.captcha);
    // The button is back, ready for a press with a new token.
    expect(view.text()).not.toContain(pending);
    expect(spinners(view)).toHaveLength(0);
    await vi.waitFor(() => expect(widget.round).toBe(round + 1));
  });

  it.each(PRESSES)("$name: a check that cannot load (no token will come): sent at once, and the refusal told", async (p) => {
    const { action, press } = p;
    const { view, field } = await ready(p);
    // The script was blocked, Cloudflare did not answer, or Turnstile stopped with an error it does
    // not retry: the widget marks the field and shows its notice (login-turnstile-widget.test.ts).
    field.dataset.turnstile = "unavailable";
    vi.useFakeTimers();
    const pressedAt = Date.now();

    press(view);
    await vi.waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    // At once, not after a wait for the token (vi.waitFor moves the fake clock a little each try).
    expect(Date.now() - pressedAt).toBeLessThan(TURNSTILE_WAIT_MS);
    expect(action.mock.calls[0][0].captchaToken).toBeUndefined();
    // No token was sent, so "try again" would meet the same refusal: the Web-only words say so.
    await vi.waitFor(() => expect(view.text()).toContain(CAPTCHA_NOT_FINISHED_MESSAGE));
    expect(view.text()).not.toContain(LOGIN_MESSAGES.captcha);
    expect(spinners(view)).toHaveLength(0);
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

describe("presses Supabase Auth checks no token for: they go at once, with no bot check drawn", () => {
  // Real timers: a press that waited for a token would wait TURNSTILE_ENFORCED_WAIT_MS here (no
  // widget gives one), far past this window. The negative control at the end shows the difference.
  const AT_ONCE = { timeout: 2_000 };

  it("opening the key again in a tab (UnlockForm: the password typed again)", async () => {
    const view = mount(() => UnlockForm({ userId: USER, email: EMAIL }));
    type(view, byLabel("パスワード"), PASSWORD);
    await drawn();
    submit(view);
    await vi.waitFor(() => expect(view.text()).toContain(LOGIN_MESSAGES.no_key), AT_ONCE);
    expect(actions.readMailKey).toHaveBeenCalledWith({ keyId: null });
    expect(widget.token).toBeNull();
  });

  it("「ほかのパスワードで開く」 (its opener takes the password only)", async () => {
    const opener = vi.fn().mockResolvedValue({ ok: true });
    const onOpened = vi.fn();
    const view = mount(() => OtherPasswordForm({ openWithAnother: opener, onOpened, onLogInAgain: vi.fn() }));
    (view.host((h) => h.type === "button").props.onClick as () => void)();
    await drawn();
    type(view, byLabel("ほかのパスワード"), NEW_PASSWORD);
    await drawn();
    submit(view);
    await vi.waitFor(() => expect(onOpened).toHaveBeenCalledTimes(1), AT_ONCE);
    expect(opener).toHaveBeenCalledWith(NEW_PASSWORD);
    expect(widget.token).toBeNull();
  });

  it("/reset-password: finishReset gets the new login secret and the new key, and no token", async () => {
    // The real reset steps (password-flows.ts finishPasswordReset), the key Actions on a fake database.
    const db = new FakeDb();
    actions.readMailKey.mockImplementation((read: unknown) => readStoredKey(asAdmin(db), USER, read));
    actions.registerMailKey.mockImplementation((registration: unknown) => registerKey(asAdmin(db), USER, registration));
    actions.finishReset.mockImplementation(async (finish: { keyId: string }) => ({ ok: true, keyId: finish.keyId }));
    const view = mount(() => ResetForm({ email: EMAIL, userId: USER }));
    type(view, byId("reset-password"), NEW_PASSWORD);
    type(view, byId("reset-password-again"), NEW_PASSWORD);
    await drawn();
    submit(view);
    await vi.waitFor(() => expect(nav.to).toEqual(["/app"]), AT_ONCE);
    expect(actions.finishReset).toHaveBeenCalledTimes(1);
    expect(Object.keys(actions.finishReset.mock.calls[0][0]).sort()).toEqual(["authSecret", "challenge", "expectedCurrentKeyId", "keyId"]);
    expect(widget.token).toBeNull();
  });

  it("negative control: the reset mail, a press that waits for a token, is still waiting at the end of the same window", async () => {
    actions.resetMail.mockResolvedValue({ ok: true, code: "reset_sent" });
    const view = mount(() => ForgotForm());
    type(view, byId("forgot-email"), EMAIL);
    await drawn();
    widget.token!.current.value = "";
    submit(view);
    await expect(vi.waitFor(() => expect(actions.resetMail).toHaveBeenCalled(), AT_ONCE)).rejects.toThrow();
    // Its token comes: it goes (and its wait ends here, not after the test).
    widget.token!.current.value = "0.token";
    await vi.waitFor(() => expect(view.text()).toContain(LOGIN_MESSAGES.reset_sent));
    expect(actions.resetMail.mock.calls[0][0].captchaToken).toBe("0.token");
  });
});
