import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TokenField } from "@/lib/turnstile";
import { fakeEvent, type Host } from "./element-tree";
import { mount, type Mounted } from "./hook-harness";

/**
 * /signup's waiting screen in the version that turns CAPTCHA off again (CAPTCHA_ENFORCED = false:
 * a try by itself is then sent without a token when none comes). Left in the middle of a try's
 * token wait, the screen must not sign in by itself afterwards with the password it held, nor
 * move the tab on. The rest of the waiting screen is signup-confirm-wait.test.ts's.
 */

const actions = vi.hoisted(() => ({ signUp: vi.fn(), resend: vi.fn() }));
const flows = vi.hoisted(() => ({ signIn: vi.fn() }));
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
vi.mock("@/app/login/turnstile-widget", () => ({
  TurnstileWidget: (props: { tokenRef: { current: TokenField }; round: number }) => {
    if (widget.token === props.tokenRef && widget.round !== props.round) props.tokenRef.current.value = "";
    widget.token = props.tokenRef;
    widget.round = props.round;
    return null;
  },
}));
vi.mock("@/components/leave-for", () => ({
  LeaveFor: ({ href }: { href: string }) => {
    nav.to.push(href);
    return null;
  },
}));
// CAPTCHA off: a try by itself that gets no token is sent without one.
vi.mock("@/lib/turnstile", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/turnstile")>();
  return { ...actual, CAPTCHA_ENFORCED: false, tokenForAutoAttempt: (field: TokenField, options: Record<string, unknown> = {}) => actual.tokenForAutoAttempt(field, { ...options, captchaEnforced: false }) };
});
vi.mock("@/lib/crypto/password-flows", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/crypto/password-flows")>()), signInAndOpenKey: flows.signIn }));
vi.mock("@/app/login/actions", () => ({ signUpWithAuthSecret: actions.signUp, resendConfirmation: actions.resend, signInWithAuthSecret: vi.fn() }));
vi.mock("@/app/login/session-actions", () => ({ readSignedInAddress: vi.fn() }));
vi.mock("@/app/app/settings/key-actions", () => ({ readMailKey: vi.fn(), registerMailKey: vi.fn(), activateMailKey: vi.fn(), rewrapMailKey: vi.fn() }));
vi.mock("@/lib/crypto/password-v1", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/crypto/password-v1")>();
  return { ...actual, deriveMaster: async () => crypto.subtle.importKey("raw", new Uint8Array(32), "HKDF", false, ["deriveBits", "deriveKey"]) };
});

const { SignupForm } = await import("@/app/signup/signup-form");

const EMAIL = "someone@example.test";
const PASSWORD = "うちの猫は三毛で7歳";

const drawn = () => new Promise<void>((resolve) => queueMicrotask(() => queueMicrotask(resolve)));
const type = (view: Mounted, id: string, value: string) => (view.host((h: Host) => h.type === "input" && h.props.id === id).props.onChange as (e: unknown) => void)({ target: { value } });

function stubTab() {
  const doc = Object.assign(new EventTarget(), { visibilityState: "visible" as "visible" | "hidden" });
  const win = new EventTarget();
  vi.stubGlobal("document", doc);
  vi.stubGlobal("window", win);
  return {
    hide() {
      doc.visibilityState = "hidden";
      doc.dispatchEvent(new Event("visibilitychange"));
    },
    show() {
      doc.visibilityState = "visible";
      doc.dispatchEvent(new Event("visibilitychange"));
      win.dispatchEvent(new Event("focus"));
    },
  };
}

async function waiting(): Promise<Mounted> {
  actions.signUp.mockResolvedValue({ ok: true, code: "signup_exists_or_sent" });
  const view = mount(() => SignupForm());
  widget.token!.current.value = "0.token-of-the-signup";
  type(view, "signup-email", EMAIL);
  type(view, "signup-password", PASSWORD);
  type(view, "signup-password-again", PASSWORD);
  await drawn();
  await (view.host((h: Host) => h.type === "form").props.onSubmit as (e: unknown) => Promise<void>)(fakeEvent());
  await drawn();
  expect(view.text()).toContain("確認のメールを送りました");
  return view;
}

let tab: ReturnType<typeof stubTab>;
beforeEach(() => {
  actions.signUp.mockReset();
  flows.signIn.mockReset();
  flows.signIn.mockResolvedValue({ ok: false, code: "not_confirmed" });
  widget.token = null;
  widget.round = -1;
  nav.to = [];
  vi.useFakeTimers();
  tab = stubTab();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("CAPTCHA off: left in the middle of a try's token wait", () => {
  it("sends no sign-in without a token afterwards, and does not sign in by itself once confirmed elsewhere", async () => {
    const view = await waiting();
    widget.token!.current.value = "";
    tab.show();
    await drawn();
    view.unmount();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    tab.hide();
    tab.show();
    flows.signIn.mockResolvedValue({ ok: true, userId: "u", key: "made" });
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(flows.signIn).not.toHaveBeenCalled();
    expect(nav.to).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("control: still on the screen, the same try is sent without a token once the wait is over", async () => {
    await waiting();
    widget.token!.current.value = "";
    tab.show();
    await vi.advanceTimersByTimeAsync(31_000);
    expect(flows.signIn).toHaveBeenCalledTimes(1);
    expect(flows.signIn.mock.calls[0][0].captchaToken).toBeUndefined();
  });
});
