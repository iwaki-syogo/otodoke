import { beforeEach, describe, expect, it, vi } from "vitest";
import { TURNSTILE_TOKEN_STALE_MS, type TokenField } from "@/lib/turnstile";
import { fakeEvent } from "./element-tree";
import { mount, type Mounted } from "./hook-harness";

/**
 * 設定's password panel (src/app/app/settings/password-panel.tsx), 「鍵を作る」 and 「パスワードを変える」:
 * a token older than TURNSTILE_TOKEN_STALE_MS (a tab frozen in the background outlives the widget's
 * 300 s) is never sent. The press moves the widget on, and sends the new token it makes. /login and
 * /signup are checked the same way (login-form.test.ts, signup-confirm-wait.test.ts).
 */

const flows = vi.hoisted(() => ({ signIn: vi.fn(), change: vi.fn() }));
/** The widget as drawn last: its token field and its round. */
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
// As the real widget: a new round (the form moving it on) brings a new token, noted with its time.
vi.mock("@/app/login/turnstile-widget", () => ({
  TurnstileWidget: (props: { tokenRef: { current: TokenField }; round: number }) => {
    if (widget.token === props.tokenRef && widget.round !== props.round) {
      props.tokenRef.current.value = `0.token-of-round-${props.round}`;
      props.tokenRef.current.dataset.tokenAt = String(Date.now());
    }
    widget.token = props.tokenRef;
    widget.round = props.round;
    return null;
  },
}));
vi.mock("@/app/login/other-password-form", () => ({ OtherPasswordForm: () => null }));
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

const drawn = () => new Promise<void>((resolve) => queueMicrotask(() => queueMicrotask(resolve)));
const type = (view: Mounted, label: string, value: string) => (view.host((h) => h.type === "input" && h.props["aria-label"] === label).props.onChange as (e: unknown) => void)({ target: { value } });
const press = (view: Mounted) => void (view.host((h) => h.type === "form").props.onSubmit as (e: unknown) => Promise<void>)(fakeEvent());

/** The widget's token, put there `ageMs` ago. */
function tokenAged(value: string, ageMs: number) {
  widget.token!.current.value = value;
  widget.token!.current.dataset.tokenAt = String(Date.now() - ageMs);
}

const FORMS = [
  {
    name: "鍵を作る",
    action: flows.signIn,
    open: async () => {
      const view = mount(() => MakeKeyForm({ email: EMAIL }));
      type(view, "パスワード", PASSWORD);
      await drawn();
      return view;
    },
  },
  {
    name: "パスワードを変える",
    action: flows.change,
    open: async () => {
      const view = mount(() => ChangeForm({ userId: USER, email: EMAIL, withCheck: true }));
      type(view, "今のパスワード", PASSWORD);
      type(view, "新しいパスワード", NEW_PASSWORD);
      type(view, "新しいパスワードをもう一度", NEW_PASSWORD);
      await drawn();
      return view;
    },
  },
];

beforeEach(() => {
  flows.signIn.mockReset();
  flows.signIn.mockResolvedValue({ ok: false, code: "credentials" });
  flows.change.mockReset();
  flows.change.mockResolvedValue({ ok: false, code: "wrong_current_password" });
  widget.token = null;
  widget.round = -1;
});

describe("設定's password panel: a token past 280 s is never sent", () => {
  it.each(FORMS)("「$name」: the old token stays unsent; the widget moves on, and its new token goes", async ({ action, open }) => {
    const view = await open();
    const round = widget.round;
    tokenAged("0.token-from-before-the-freeze", TURNSTILE_TOKEN_STALE_MS + 20_000);
    press(view);
    await vi.waitFor(() => expect(action).toHaveBeenCalledTimes(1), { timeout: 2_000 });
    // Sent with the token of the round the stale one moved it on to (the press moves it on again after).
    expect(action.mock.calls[0][0].captchaToken).toBe(`0.token-of-round-${round + 1}`);
    expect(action.mock.calls[0][0].captchaToken).not.toBe("0.token-from-before-the-freeze");
  });

  it.each(FORMS)("「$name」 negative control: a token well inside 280 s goes as it is, and the widget is not moved on first", async ({ action, open }) => {
    const view = await open();
    const round = widget.round;
    tokenAged("0.token-of-a-minute-ago", 60_000);
    press(view);
    await vi.waitFor(() => expect(action).toHaveBeenCalledTimes(1), { timeout: 2_000 });
    expect(action.mock.calls[0][0].captchaToken).toBe("0.token-of-a-minute-ago");
    expect(widget.round).toBeGreaterThanOrEqual(round);
  });
});
