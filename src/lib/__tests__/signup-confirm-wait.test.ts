import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LOGIN_MESSAGES } from "@/lib/login-errors";
import { clearLoginHandoff, peekLoginHandoff } from "@/lib/login-handoff";
import { LOGIN_TRY_LIMITS } from "@/lib/login-mail-limit";
import { AUTO_SIGN_IN_AFTER_FAILURE_MS, AUTO_SIGN_IN_BACKOFF_MS, AUTO_SIGN_IN_MAX, AUTO_SIGN_IN_SAME_RETURN_MS, autoSignInGapMs } from "@/lib/onboarding";
import { TURNSTILE_AUTO_WAIT_MS, TURNSTILE_TOKEN_STALE_MS, TURNSTILE_WAIT_MS, tokenForAutoAttempt, tokenIsStale, type TokenField } from "@/lib/turnstile";
import { fakeEvent, type Host } from "./element-tree";
import { mount, type Mounted } from "./hook-harness";
import { read, withoutComments } from "./source-scan";

/**
 * Onboarding screen 1 (/signup once the mail went, src/app/signup/signup-form.tsx): the tab keeps
 * the address and the password in its memory only, and signs in by itself as /login does when the
 * tab is shown again (visibilitychange to visible, focus), at the points of the backoff while the
 * tab is shown (one timer), or when 「確認しました」 is pressed. The tries by themselves are few (they
 * count against the sign-in limits per IP). By itself it says nothing while the address is not confirmed; a press says so. `credentials`
 * goes to /login with the address; any other refusal gets LOGIN_MESSAGES' words. The sign-in that
 * made the first key goes straight to the first-run guide. 「別のアドレスでやり直す」 lets go of both.
 *
 * The words are written out here as the screen says them.
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
    // As the real widget: a new round empties the used token (the next one comes from the test).
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
vi.mock("@/lib/crypto/password-flows", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/crypto/password-flows")>()), signInAndOpenKey: flows.signIn }));
vi.mock("@/app/login/actions", () => ({ signUpWithAuthSecret: actions.signUp, resendConfirmation: actions.resend, signInWithAuthSecret: vi.fn() }));
vi.mock("@/app/login/session-actions", () => ({ readSignedInAddress: vi.fn() }));
vi.mock("@/app/app/settings/key-actions", () => ({ readMailKey: vi.fn(), registerMailKey: vi.fn(), activateMailKey: vi.fn(), rewrapMailKey: vi.fn() }));
// Master is made quickly here (the sign-up's steps are password-flows.test.ts's).
vi.mock("@/lib/crypto/password-v1", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/crypto/password-v1")>();
  return { ...actual, deriveMaster: async () => crypto.subtle.importKey("raw", new Uint8Array(32), "HKDF", false, ["deriveBits", "deriveKey"]) };
});

const { SignupForm } = await import("@/app/signup/signup-form");

const EMAIL = "someone@example.test";
const PASSWORD = "うちの猫は三毛で7歳";
const TOKEN = "0.token-for-the-sign-in";

const WORDS = {
  title: "確認のメールを送りました",
  body: "メールのリンクを開いて「確認する」を押すと、この画面が自動で次へ進みます。進まないときは「確認しました」を押してください。",
  done: "確認しました",
  resend: "メールを送り直す",
  restart: "別のアドレスでやり直す",
  notYet: "まだ確認できていません。メールのリンクを開いて「確認する」を押しましたか？",
  resent: "送り直しました",
};

const textOfHost = (h: Host | string): string => (typeof h === "string" ? h : h.children.map(textOfHost).join(""));
const drawn = () => new Promise<void>((resolve) => queueMicrotask(() => queueMicrotask(resolve)));
const type = (view: Mounted, id: string, value: string) => (view.host((h) => h.type === "input" && h.props.id === id).props.onChange as (e: unknown) => void)({ target: { value } });
const buttons = (view: Mounted) => view.hosts((h) => h.type === "button");
const click = (view: Mounted, i: number) => (buttons(view)[i].props.onClick as (e: unknown) => void)(fakeEvent());
const pressDone = (view: Mounted) => click(view, 0);
const pressResend = (view: Mounted) => click(view, 1);
const pressRestart = (view: Mounted) => click(view, 2);
/** A new token from the widget. */
const fresh = (value = TOKEN) => {
  widget.token!.current.value = value;
  widget.token!.current.dataset.tokenAt = String(Date.now());
};
/** Moves the clock on (the tries by themselves are spaced by the clock). */
const after = (ms: number) => vi.setSystemTime(Date.now() + ms);
/** Past both gaps between two tries by themselves. */
const later = () => after(AUTO_SIGN_IN_AFTER_FAILURE_MS + 1_000);

/** A tab: its document's visibility and the events the screen listens to. */
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
    /** The tab shown again: the browser fires both. */
    show() {
      doc.visibilityState = "visible";
      doc.dispatchEvent(new Event("visibilitychange"));
      win.dispatchEvent(new Event("focus"));
    },
    focus() {
      win.dispatchEvent(new Event("focus"));
    },
  };
}

/** /signup with the account made and the mail sent: the waiting screen, with a new token ready. */
async function waiting(): Promise<Mounted> {
  actions.signUp.mockResolvedValue({ ok: true, code: "signup_exists_or_sent" });
  const view = mount(() => SignupForm());
  widget.token!.current.value = "0.token-of-the-signup";
  type(view, "signup-email", EMAIL);
  type(view, "signup-password", PASSWORD);
  type(view, "signup-password-again", PASSWORD);
  await drawn();
  await (view.host((h) => h.type === "form").props.onSubmit as (e: unknown) => Promise<void>)(fakeEvent());
  await drawn();
  expect(view.text()).toContain(WORDS.title);
  fresh();
  return view;
}

/** Shows the tab again and waits for the sign-in count to reach `calls`. */
async function shownAndTried(calls: number) {
  tab.show();
  await vi.waitFor(() => expect(flows.signIn).toHaveBeenCalledTimes(calls));
  await drawn();
  await drawn();
}

let tab: ReturnType<typeof stubTab>;
beforeEach(() => {
  actions.signUp.mockReset();
  actions.resend.mockReset();
  flows.signIn.mockReset();
  flows.signIn.mockResolvedValue({ ok: false, code: "not_confirmed" });
  widget.token = null;
  widget.round = -1;
  nav.to = [];
  clearLoginHandoff();
  vi.useFakeTimers({ toFake: ["Date"] });
  tab = stubTab();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("the waiting screen's words", () => {
  it("are the wording file's: the title, the body, the address on a line of its own, 「確認しました」, 「メールを送り直す」 and 「別のアドレスでやり直す」", async () => {
    const view = await waiting();
    const h1 = view.hosts((h) => h.type === "h1").map(textOfHost);
    expect(h1).toEqual([WORDS.title]);
    const paragraphs = view.hosts((h) => h.type === "p").map(textOfHost);
    // The body, then the address alone (no label), in that order.
    expect(paragraphs.slice(0, 2)).toEqual([WORDS.body, EMAIL]);
    expect(buttons(view).map(textOfHost)).toEqual([WORDS.done, WORDS.resend, WORDS.restart]);
    // No standing notes, and none of the sign-up form's links.
    expect(view.hosts((h) => h.type === "a")).toEqual([]);
    expect(view.text()).not.toContain(LOGIN_MESSAGES.signup_exists_or_sent);
    expect(view.text()).not.toContain("転送するだけ");
  });

  it("the main button is black and full width; 「メールを送り直す」 reads as a link, and 「別のアドレスでやり直す」 is smaller still", async () => {
    const view = await waiting();
    const [done, resend, restart] = buttons(view).map((b) => String(b.props.className).split(" "));
    for (const c of ["w-full", "bg-neutral-900", "text-white", "rounded-xl", "py-4"]) expect(done).toContain(c);
    expect(resend).toContain("underline");
    expect(resend).toContain("text-sm");
    expect(restart).toContain("underline");
    expect(restart).toContain("text-xs");
    expect([...done, ...resend, ...restart].join(" ")).not.toMatch(/shadow|gradient/);
  });
});

describe("when it signs in", () => {
  it("the tab shown again tries at once, once for the two events of one return, and with the password from memory (hidden is no trigger)", async () => {
    await waiting();
    // Long after the sign-up, with nothing shown again: nothing tried.
    later();
    await drawn();
    expect(flows.signIn).not.toHaveBeenCalled();
    // Hidden is no trigger.
    tab.hide();
    await drawn();
    expect(flows.signIn).not.toHaveBeenCalled();

    await shownAndTried(1);
    expect(flows.signIn.mock.calls[0][0]).toEqual({ email: EMAIL, password: PASSWORD, captchaToken: TOKEN });
    // A focus right after (the second event of one return) is the same try.
    fresh("0.another");
    tab.focus();
    await drawn();
    expect(flows.signIn).toHaveBeenCalledTimes(1);
    // The token went with it: emptied, and the widget moves on to a new one.
    await vi.waitFor(() => expect(widget.round).toBe(2));
  });

  it("by itself, an address not confirmed yet is not told; pressed, it is (and not as an error)", async () => {
    const view = await waiting();
    await shownAndTried(1);
    expect(view.text()).not.toContain(WORDS.notYet);
    expect(view.text()).not.toContain(LOGIN_MESSAGES.not_confirmed);
    expect(view.hosts((h) => h.props.role === "alert")).toEqual([]);

    fresh("0.token-for-the-press");
    pressDone(view);
    await vi.waitFor(() => expect(view.text()).toContain(WORDS.notYet));
    expect(flows.signIn).toHaveBeenCalledTimes(2);
    expect(flows.signIn.mock.calls[1][0].captchaToken).toBe("0.token-for-the-press");
    expect(view.text()).not.toContain(LOGIN_MESSAGES.not_confirmed);
    const said = view.hosts((h) => textOfHost(h) === WORDS.notYet && h.type === "p");
    expect(said).toHaveLength(1);
    expect(said[0].props.role).toBe("status");
    expect(String(said[0].props.className)).not.toMatch(/red/);
  });

  it.each(["rate", "network", "other"] as const)("any other refusal (%s), by itself or pressed, gets LOGIN_MESSAGES' words unchanged and stays on the screen", async (code) => {
    flows.signIn.mockResolvedValue({ ok: false, code });
    const view = await waiting();
    await shownAndTried(1);
    await vi.waitFor(() => expect(view.text()).toContain(LOGIN_MESSAGES[code]));
    expect(view.text()).not.toContain(WORDS.notYet);
    expect(nav.to).toEqual([]);

    fresh("0.token-for-the-press");
    pressDone(view);
    await vi.waitFor(() => expect(flows.signIn).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(view.text()).toContain(LOGIN_MESSAGES[code]));
    // The next return tries again, once the wait after a refusal is over.
    later();
    fresh("0.next");
    await shownAndTried(3);
  });

  it("captcha, pressed: LOGIN_MESSAGES' words unchanged", async () => {
    flows.signIn.mockResolvedValue({ ok: false, code: "captcha" });
    const view = await waiting();
    pressDone(view);
    await vi.waitFor(() => expect(view.text()).toContain(LOGIN_MESSAGES.captcha));
    expect(flows.signIn).toHaveBeenCalledTimes(1);
  });

  it.each(["auto", "press"] as const)("credentials (%s): stops waiting and goes to /login with the address and those words, never the password", async (how) => {
    flows.signIn.mockResolvedValue({ ok: false, code: "credentials" });
    const view = await waiting();
    if (how === "auto") await shownAndTried(1);
    else pressDone(view);
    await vi.waitFor(() => expect(nav.to).toEqual(["/login"]));
    expect(peekLoginHandoff()).toEqual({ email: EMAIL, code: "credentials" });
    expect(JSON.stringify(peekLoginHandoff())).not.toContain(PASSWORD);
    // Stopped: no more tries.
    later();
    fresh("0.next");
    tab.show();
    await drawn();
    expect(flows.signIn).toHaveBeenCalledTimes(1);
  });

  it("the sign-in that made the first key goes straight to the first-run guide, never by the list", async () => {
    flows.signIn.mockResolvedValue({ ok: true, userId: "u", key: "made" });
    const view = await waiting();
    await shownAndTried(1);
    await vi.waitFor(() => expect(nav.to).toEqual(["/app/welcome"]));
    // Still shown as pressed while the guide is on its way (no list in between).
    expect(textOfHost(buttons(view)[0])).toBe("ログインしています…");
  });

  it("a key there already (the account was there before) opens and goes to the list, as /login does", async () => {
    flows.signIn.mockResolvedValue({ ok: true, userId: "u", key: "opened" });
    const view = await waiting();
    pressDone(view);
    await vi.waitFor(() => expect(nav.to).toEqual(["/app"]));
  });

  it.each([
    ["not_opened", { key: "not_opened", openWithAnother: vi.fn() }, LOGIN_MESSAGES.key_not_opened],
    ["failed (key_failed)", { key: "failed", code: "key_failed" }, LOGIN_MESSAGES.key_failed],
    ["failed (stale_session)", { key: "failed", code: "stale_session" }, LOGIN_MESSAGES.stale_session],
  ] as const)("signed in but the key %s: the waiting screen goes; the key's words, 「このまま進む」 and 設定's 「パスワードとメールの鍵」, and no more tries", async (_what, answer, words) => {
    flows.signIn.mockResolvedValue({ ok: true, userId: "u", ...answer });
    const view = await waiting();
    await shownAndTried(1);
    await vi.waitFor(() => expect(view.text()).toContain(words));
    // The waiting screen is gone: no title, no 「確認しました」, no resend.
    expect(view.hosts((h) => h.type === "h1")).toEqual([]);
    expect(buttons(view)).toEqual([]);
    expect(view.text()).not.toContain(WORDS.title);
    expect(view.hosts((h) => h.type === "a").map((a) => [a.props.href, textOfHost(a)])).toEqual([
      ["/app", "このまま進む"],
      ["/app/settings/password", "パスワードとメールの鍵"],
    ]);
    expect(nav.to).toEqual([]);
    later();
    fresh("0.next");
    tab.show();
    await drawn();
    expect(flows.signIn).toHaveBeenCalledTimes(1);
  });

  it("a try by itself shows as pressed; a press that comes meanwhile makes one sign-in with it, and its answer is told", async () => {
    let answer!: (v: unknown) => void;
    flows.signIn.mockReturnValue(new Promise((r) => (answer = r)));
    const view = await waiting();
    tab.show();
    // While the try waits for its token, before anything is drawn: the button still takes the press.
    pressDone(view);
    await vi.waitFor(() => expect(flows.signIn).toHaveBeenCalledTimes(1));
    await drawn();
    expect(textOfHost(buttons(view)[0])).toBe("ログインしています…");
    answer({ ok: false, code: "not_confirmed" });
    await vi.waitFor(() => expect(view.text()).toContain(WORDS.notYet));
    expect(flows.signIn).toHaveBeenCalledTimes(1);
  });
});

describe("how often it tries by itself (the sign-in limits per IP)", () => {
  it("a return tries at once, whatever the backoff; only the second event of one return is the same return", async () => {
    await waiting();
    await shownAndTried(1);
    // The focus right after the visibilitychange (within AUTO_SIGN_IN_SAME_RETURN_MS): no second try.
    after(AUTO_SIGN_IN_SAME_RETURN_MS - 500);
    fresh("0.same-return");
    tab.focus();
    await drawn();
    await drawn();
    expect(flows.signIn).toHaveBeenCalledTimes(1);
    // 12 s later (the link opened in between): a return of its own, tried at once (the reviewer's probe 3).
    flows.signIn.mockResolvedValueOnce({ ok: true, userId: "u", key: "made" });
    after(12_000);
    await shownAndTried(2);
    await vi.waitFor(() => expect(nav.to).toEqual(["/app/welcome"]));
  });

  it(`after a refusal other than "not confirmed", the next try by itself waits ${AUTO_SIGN_IN_AFTER_FAILURE_MS / 1000} s`, async () => {
    flows.signIn.mockResolvedValue({ ok: false, code: "network" });
    await waiting();
    await shownAndTried(1);
    after(AUTO_SIGN_IN_BACKOFF_MS[0] + 1_000);
    fresh("0.second");
    tab.show();
    await drawn();
    expect(flows.signIn).toHaveBeenCalledTimes(1);
    after(AUTO_SIGN_IN_AFTER_FAILURE_MS);
    tab.show();
    await vi.waitFor(() => expect(flows.signIn).toHaveBeenCalledTimes(2));
  });

  it("the backoff grows after each refusal as not confirmed yet, then stays at its last gap", () => {
    expect(AUTO_SIGN_IN_BACKOFF_MS).toEqual([20_000, 60_000, 180_000]);
    expect([0, 1, 2, 3, 4, 9].map(autoSignInGapMs)).toEqual([20_000, 20_000, 60_000, 180_000, 180_000, 180_000]);
    // Growing, never shrinking.
    for (let n = 1; n < 10; n++) expect(autoSignInGapMs(n + 1)).toBeGreaterThanOrEqual(autoSignInGapMs(n));
  });

  it("two waiting screens behind one IP, at their worst in any 10 minutes, stay under LOGIN_TRY_LIMITS with room for presses", () => {
    const TEN_MINUTES = 10 * 60_000;
    // The timer alone (shown all the time): the points of the backoff within 10 minutes, at most the maximum.
    const timed: number[] = [];
    for (let at = 0, n = 0; n < AUTO_SIGN_IN_MAX; n++) {
      at += autoSignInGapMs(n);
      if (at > TEN_MINUTES) break;
      timed.push(at);
    }
    expect(timed.length).toBeLessThanOrEqual(AUTO_SIGN_IN_MAX);
    // Returns may come at any time, so the worst for one screen is its maximum (the captcha retry
    // counts among the sends). Two screens: twice that, and at least one press each still fits.
    const worstPerScreen = AUTO_SIGN_IN_MAX;
    const screens = 2;
    const pressesLeft = LOGIN_TRY_LIMITS.ipPer10Minutes - screens * worstPerScreen;
    expect(pressesLeft).toBeGreaterThanOrEqual(screens);
  });

  it(`at most ${AUTO_SIGN_IN_MAX} tries by itself per waiting screen; then only the button tries, and it always does`, async () => {
    const view = await waiting();
    for (let n = 1; n <= AUTO_SIGN_IN_MAX; n++) {
      fresh(`0.auto-${n}`);
      await shownAndTried(n);
      after(AUTO_SIGN_IN_SAME_RETURN_MS + 1);
    }
    fresh("0.one-too-many");
    tab.show();
    await drawn();
    await drawn();
    expect(flows.signIn).toHaveBeenCalledTimes(AUTO_SIGN_IN_MAX);
    pressDone(view);
    await vi.waitFor(() => expect(flows.signIn).toHaveBeenCalledTimes(AUTO_SIGN_IN_MAX + 1));
    await vi.waitFor(() => expect(view.text()).toContain(WORDS.notYet));
  });

  it("a press is never held back by the gaps", async () => {
    flows.signIn.mockResolvedValue({ ok: false, code: "network" });
    const view = await waiting();
    await shownAndTried(1);
    fresh("0.press");
    pressDone(view);
    await vi.waitFor(() => expect(flows.signIn).toHaveBeenCalledTimes(2));
  });
});

describe("the tab shown all the time (the link opened on another device): the timer", () => {
  // These fake the timers too (the others fake only the clock).
  beforeEach(() => {
    vi.useRealTimers();
    vi.useFakeTimers();
  });

  /** Moves the clock and the timers on by `ms`, with a new token ready for a try. */
  async function wait(ms: number) {
    fresh(`0.at-${Date.now() + ms}`);
    await vi.advanceTimersByTimeAsync(ms);
  }

  it("tries at the points of the backoff (20 s, then 20 s, 60 s, 3 min, 3 min) and stops at the maximum", async () => {
    await waiting();
    const points = [20_000, 20_000, 60_000, 180_000, 180_000];
    expect(points.length).toBe(AUTO_SIGN_IN_MAX);
    for (const [i, gap] of points.entries()) {
      await wait(gap - 1_000);
      expect(flows.signIn).toHaveBeenCalledTimes(i);
      await wait(1_000);
      await vi.waitFor(() => expect(flows.signIn).toHaveBeenCalledTimes(i + 1));
    }
    // The maximum reached: nothing more, and no timer left.
    await wait(60 * 60_000);
    expect(flows.signIn).toHaveBeenCalledTimes(AUTO_SIGN_IN_MAX);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("negative control: a flat 20 s would have tried at 40 s and 60 s; the third waits until 100 s", async () => {
    await waiting();
    await wait(20_000);
    await wait(20_000);
    await vi.waitFor(() => expect(flows.signIn).toHaveBeenCalledTimes(2));
    await wait(20_000);
    await wait(39_000);
    expect(flows.signIn).toHaveBeenCalledTimes(2);
    await wait(1_000);
    await vi.waitFor(() => expect(flows.signIn).toHaveBeenCalledTimes(3));
  });

  it("hidden, it pauses; shown again, the return tries at once and the timer starts anew", async () => {
    await waiting();
    await wait(10_000);
    tab.hide();
    expect(vi.getTimerCount()).toBe(0);
    await wait(30 * 60_000);
    expect(flows.signIn).not.toHaveBeenCalled();
    // Back after half an hour: the widget's token by then is a new one.
    fresh("0.back");
    await shownAndTried(1);
    await wait(AUTO_SIGN_IN_BACKOFF_MS[0] - 1_000);
    expect(flows.signIn).toHaveBeenCalledTimes(1);
    await wait(1_000);
    await vi.waitFor(() => expect(flows.signIn).toHaveBeenCalledTimes(2));
  });

  it("one timer at a time, through returns, presses and resends", async () => {
    actions.resend.mockResolvedValue({ ok: true, code: "confirmation_sent" });
    const view = await waiting();
    expect(vi.getTimerCount()).toBe(1);
    await shownAndTried(1);
    fresh("0.press");
    pressDone(view);
    await vi.waitFor(() => expect(flows.signIn).toHaveBeenCalledTimes(2));
    fresh("0.resend");
    pressResend(view);
    await vi.waitFor(() => expect(view.text()).toContain(WORDS.resent));
    await vi.advanceTimersByTimeAsync(5_000);
    // The toast's timer is gone by now; the one left is the try's.
    expect(vi.getTimerCount()).toBe(1);
    fresh("0.return");
    tab.focus();
    tab.show();
    await drawn();
    expect(vi.getTimerCount()).toBeLessThanOrEqual(2);
    await vi.waitFor(() => expect(flows.signIn).toHaveBeenCalledTimes(3));
    await drawn();
    expect(vi.getTimerCount()).toBe(1);
  });

  it("a press cancels the timed try waiting and counts for the timing only: the next one is a full gap after it, the backoff not moved on; a press that signs in stops it", async () => {
    const view = await waiting();
    await wait(20_000);
    await vi.waitFor(() => expect(flows.signIn).toHaveBeenCalledTimes(1));
    // 2 s before the timed try (due at 40 s): a press.
    await wait(18_000);
    pressDone(view);
    await vi.waitFor(() => expect(flows.signIn).toHaveBeenCalledTimes(2));
    // No try by itself just after the press's answer (the IP's allowance): not at 40 s, nor before 58 s.
    await wait(19_000);
    expect(flows.signIn).toHaveBeenCalledTimes(2);
    // At 58 s: 20 s after the press (the backoff still at its first gap; a press does not move it on).
    flows.signIn.mockResolvedValue({ ok: true, userId: "u", key: "made" });
    await wait(1_000);
    await vi.waitFor(() => expect(flows.signIn).toHaveBeenCalledTimes(3));
    await vi.waitFor(() => expect(nav.to).toEqual(["/app/welcome"]));
    await wait(60 * 60_000);
    expect(flows.signIn).toHaveBeenCalledTimes(3);
  });

  it(`after a refusal other than "not confirmed", nothing is tried until the ${AUTO_SIGN_IN_AFTER_FAILURE_MS / 1000} s are over: no timer goes off inside it, and the one try after it comes while shown`, async () => {
    flows.signIn.mockResolvedValue({ ok: false, code: "network" });
    const view = await waiting();
    await wait(20_000);
    await vi.waitFor(() => expect(flows.signIn).toHaveBeenCalledTimes(1));
    await drawn();
    // One timer, for the end of the wait; a return inside it tries nothing and adds none.
    expect(vi.getTimerCount()).toBe(1);
    // Every timer set from here to the end of the wait (one that went off early would set another).
    const arms = vi.spyOn(globalThis, "setTimeout");
    await wait(30_000);
    tab.show();
    await drawn();
    expect(flows.signIn).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);
    await wait(AUTO_SIGN_IN_AFTER_FAILURE_MS - 30_000 - 1_000);
    expect(flows.signIn).toHaveBeenCalledTimes(1);
    // Only the return set it again (for the same end); none went off inside the wait.
    expect(arms.mock.calls.length).toBeLessThanOrEqual(1);
    arms.mockRestore();
    await wait(1_000);
    await vi.waitFor(() => expect(flows.signIn).toHaveBeenCalledTimes(2));
    // Hidden at the end of a wait: nothing is set to go off.
    await drawn();
    tab.hide();
    expect(vi.getTimerCount()).toBe(0);
    await wait(10 * 60_000);
    expect(flows.signIn).toHaveBeenCalledTimes(2);
    void view;
  });

  it("stopped by a sign-in, by 「別のアドレスでやり直す」 and by leaving the page", async () => {
    flows.signIn.mockResolvedValue({ ok: true, userId: "u", key: "made" });
    let view = await waiting();
    await wait(20_000);
    await vi.waitFor(() => expect(nav.to).toEqual(["/app/welcome"]));
    await wait(60 * 60_000);
    expect(flows.signIn).toHaveBeenCalledTimes(1);

    flows.signIn.mockClear();
    view = await waiting();
    pressRestart(view);
    await drawn();
    await wait(60 * 60_000);
    expect(flows.signIn).not.toHaveBeenCalled();

    view = await waiting();
    view.unmount();
    await wait(60 * 60_000);
    expect(flows.signIn).not.toHaveBeenCalled();
  });

  it("「別のアドレスでやり直す」 and a new account inside the old gap: the old screen's timer does not go off on the new one; the new one counts from its own start", async () => {
    const view = await waiting();
    await wait(10_000);
    pressRestart(view);
    await drawn();
    // A new account 5 s later: its screen appears at 15 s; the old timer was due at 20 s.
    await wait(5_000);
    actions.signUp.mockResolvedValue({ ok: true, code: "signup_exists_or_sent" });
    fresh("0.signup-2");
    type(view, "signup-email", "other@example.test");
    type(view, "signup-password", PASSWORD);
    type(view, "signup-password-again", PASSWORD);
    await drawn();
    await (view.host((h) => h.type === "form").props.onSubmit as (e: unknown) => Promise<void>)(fakeEvent());
    await drawn();
    expect(view.text()).toContain("other@example.test");
    // No return: nothing at the old point (20 s), nor before the new one's (35 s).
    await wait(19_000);
    expect(flows.signIn).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);
    await wait(1_000);
    await vi.waitFor(() => expect(flows.signIn).toHaveBeenCalledTimes(1));
    expect(flows.signIn.mock.calls[0][0].email).toBe("other@example.test");
  });

  it("left (unmounted) while waiting: however long after, nothing signs in with the password it held", async () => {
    const view = await waiting();
    await wait(10_000);
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
    await wait(60 * 60_000);
    tab.show();
    await drawn();
    expect(flows.signIn).not.toHaveBeenCalled();
  });
});

describe("the bot check of a sign-in tried by itself", () => {
  it("the checkbox waits for its tick: nothing is sent, nobody is asked, and the next return tries again", async () => {
    const view = await waiting();
    widget.token!.current.value = "";
    widget.token!.current.dataset.turnstile = "interactive";
    tab.show();
    await drawn();
    await drawn();
    expect(flows.signIn).not.toHaveBeenCalled();
    expect(view.text()).not.toContain("確認のチェックを押してください");
    // The round stays: no token was used.
    expect(widget.round).toBe(1);

    delete widget.token!.current.dataset.turnstile;
    fresh("0.token-after-the-tick");
    later();
    await shownAndTried(1);
    expect(flows.signIn.mock.calls[0][0].captchaToken).toBe("0.token-after-the-tick");
  });

  it(`waits up to ${TURNSTILE_AUTO_WAIT_MS / 1000} s for a token (longer than a press with CAPTCHA off), then sends nothing and does not loop`, async () => {
    vi.useRealTimers();
    vi.useFakeTimers();
    let view = await waiting();
    widget.token!.current.value = "";
    tab.show();
    await vi.advanceTimersByTimeAsync(TURNSTILE_WAIT_MS + 5_000);
    expect(flows.signIn).not.toHaveBeenCalled();
    // A slow phone's token, after 15 s: still sent.
    fresh("0.slow-token");
    await vi.advanceTimersByTimeAsync(200);
    await vi.waitFor(() => expect(flows.signIn).toHaveBeenCalledTimes(1));
    expect(flows.signIn.mock.calls[0][0].captchaToken).toBe("0.slow-token");

    // None at all: nothing sent after the wait, and long after still nothing (no timer tries).
    flows.signIn.mockClear();
    view = await waiting();
    widget.token!.current.value = "";
    tab.show();
    await vi.advanceTimersByTimeAsync(TURNSTILE_AUTO_WAIT_MS + 1_000);
    expect(flows.signIn).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(flows.signIn).not.toHaveBeenCalled();
    expect(view.hosts((h) => h.props.role === "alert")).toEqual([]);
  });

  it("a token older than the widget's 300 s (a tab frozen in the background) is not sent: the widget makes a new one", async () => {
    await waiting();
    widget.token!.current.value = "0.old-token";
    widget.token!.current.dataset.tokenAt = String(Date.now() - TURNSTILE_TOKEN_STALE_MS - 10_000);
    const round = widget.round;
    tab.show();
    await drawn();
    await drawn();
    expect(flows.signIn).not.toHaveBeenCalled();
    expect(widget.token!.current.value).toBe("");
    expect(widget.round).toBe(round + 1);
    fresh("0.new-token");
    await vi.waitFor(() => expect(flows.signIn).toHaveBeenCalledTimes(1));
    expect(flows.signIn.mock.calls[0][0].captchaToken).toBe("0.new-token");
  });

  it("a try by itself refused with captcha tries once more with a new token, then says nothing until the next trigger", async () => {
    flows.signIn.mockResolvedValue({ ok: false, code: "captcha" });
    const view = await waiting();
    tab.show();
    await vi.waitFor(() => expect(flows.signIn).toHaveBeenCalledTimes(1));
    await drawn();
    // The used token is gone; the second try waits for the new one.
    expect(widget.token!.current.value).toBe("");
    fresh("0.retry-token");
    await vi.waitFor(() => expect(flows.signIn).toHaveBeenCalledTimes(2));
    expect(flows.signIn.mock.calls[1][0].captchaToken).toBe("0.retry-token");
    await drawn();
    await drawn();
    expect(view.text()).not.toContain(LOGIN_MESSAGES.captcha);
    expect(view.hosts((h) => h.props.role === "alert")).toEqual([]);
    // Not a third time on its own, and not at the next return within the wait after a refusal.
    fresh("0.third");
    after(AUTO_SIGN_IN_BACKOFF_MS[0] + 1_000);
    tab.show();
    await drawn();
    expect(flows.signIn).toHaveBeenCalledTimes(2);
  });

  it("tokenForAutoAttempt: sends a fresh token, never asks for the tick, empties a stale one, and without CAPTCHA sends without one", async () => {
    vi.useRealTimers();
    expect(await tokenForAutoAttempt({ value: "0.t", dataset: {} })).toEqual({ send: true, token: "0.t" });
    expect(await tokenForAutoAttempt({ value: "0.t", dataset: { tokenAt: String(Date.now() - 1_000) } })).toEqual({ send: true, token: "0.t" });
    expect(await tokenForAutoAttempt({ value: "", dataset: { turnstile: "interactive" } })).toEqual({ send: false });
    expect(await tokenForAutoAttempt({ value: "", dataset: { turnstile: "unavailable" } })).toEqual({ send: false });
    expect(await tokenForAutoAttempt({ value: "", dataset: { turnstile: "unavailable" } }, { captchaEnforced: false })).toEqual({ send: true, token: undefined });
    expect(await tokenForAutoAttempt({ value: "", dataset: {} }, { limitMs: 50 })).toEqual({ send: false });
    const stale: TokenField = { value: "0.old", dataset: { tokenAt: String(Date.now() - TURNSTILE_TOKEN_STALE_MS - 1) } };
    expect(tokenIsStale(stale)).toBe(true);
    const onStale = vi.fn();
    expect(await tokenForAutoAttempt(stale, { limitMs: 50, onStale })).toEqual({ send: false });
    expect(onStale).toHaveBeenCalledTimes(1);
    expect(stale.value).toBe("");
    expect(tokenIsStale({ value: "0.t", dataset: {} })).toBe(false);
  });
});

describe("an old request leaves the new form's token alone", () => {
  it("restart while a resend is in flight: the new form's token is still there after the old resend settles", async () => {
    let sent!: (v: unknown) => void;
    actions.resend.mockReturnValue(new Promise((r) => (sent = r)));
    const view = await waiting();
    pressResend(view);
    await vi.waitFor(() => expect(actions.resend).toHaveBeenCalledTimes(1));
    pressRestart(view);
    await drawn();
    fresh("0.new-form-token");
    sent({ ok: true, code: "confirmation_sent" });
    await drawn();
    await drawn();
    expect(widget.token!.current.value).toBe("0.new-form-token");
  });

  it("restart after the resend sent its token: the used token is cleared, the widget moves on, and the new form's first press sends a fresh one", async () => {
    actions.resend.mockReturnValue(new Promise(() => {}));
    const view = await waiting();
    pressResend(view);
    await vi.waitFor(() => expect(actions.resend).toHaveBeenCalledTimes(1));
    const round = widget.round;
    pressRestart(view);
    await drawn();
    expect(widget.token!.current.value).toBe("");
    expect(widget.round).toBe(round + 1);
    actions.signUp.mockClear();
    type(view, "signup-email", EMAIL);
    type(view, "signup-password", PASSWORD);
    type(view, "signup-password-again", PASSWORD);
    await drawn();
    const submitted = (view.host((h) => h.type === "form").props.onSubmit as (e: unknown) => Promise<void>)(fakeEvent());
    await drawn();
    expect(actions.signUp).not.toHaveBeenCalled();
    fresh("0.fresh-for-new-form");
    await submitted;
    expect(actions.signUp).toHaveBeenCalledTimes(1);
    expect(actions.signUp.mock.calls[0][0].captchaToken).toBe("0.fresh-for-new-form");
  });

  it("negative control: restart while the resend still waits for a token (nothing sent): nothing is cleared and the widget does not move", async () => {
    const view = await waiting();
    widget.token!.current.value = "";
    pressResend(view);
    await drawn();
    const round = widget.round;
    pressRestart(view);
    await drawn();
    fresh("0.kept");
    await new Promise((r) => setTimeout(r, 300));
    expect(actions.resend).not.toHaveBeenCalled();
    expect(widget.token!.current.value).toBe("0.kept");
    expect(widget.round).toBe(round);
  });

  it("negative control: without a restart the resend's token is spent as before", async () => {
    let sent!: (v: unknown) => void;
    actions.resend.mockReturnValue(new Promise((r) => (sent = r)));
    const view = await waiting();
    pressResend(view);
    await vi.waitFor(() => expect(actions.resend).toHaveBeenCalledTimes(1));
    sent({ ok: true, code: "confirmation_sent" });
    await vi.waitFor(() => expect(widget.token!.current.value).toBe(""));
  });
});

describe("one request at a time, and every press shows", () => {
  it("「確認しました」 while 「メールを送り直す」 is on its way: shown pressed at once, and sent after it", async () => {
    let sent!: (v: unknown) => void;
    actions.resend.mockReturnValue(new Promise((r) => (sent = r)));
    const view = await waiting();
    pressResend(view);
    await vi.waitFor(() => expect(actions.resend).toHaveBeenCalledTimes(1));
    pressDone(view);
    await drawn();
    expect(textOfHost(buttons(view)[0])).toBe("ログインしています…");
    expect(textOfHost(buttons(view)[1])).toBe("送っています…");
    expect(flows.signIn).not.toHaveBeenCalled();
    sent({ ok: true, code: "confirmation_sent" });
    // The resend's token is spent; the widget's next one comes.
    await vi.waitFor(() => expect(widget.token!.current.value).toBe(""));
    fresh("0.token-for-the-press");
    await vi.waitFor(() => expect(flows.signIn).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(view.text()).toContain(WORDS.notYet));
    expect(view.text()).toContain(WORDS.resent);
  });

  it("「メールを送り直す」 while a sign-in is on its way: shown pressed at once, and sent after it", async () => {
    let answer!: (v: unknown) => void;
    flows.signIn.mockReturnValue(new Promise((r) => (answer = r)));
    actions.resend.mockResolvedValue({ ok: true, code: "confirmation_sent" });
    const view = await waiting();
    pressDone(view);
    await vi.waitFor(() => expect(flows.signIn).toHaveBeenCalledTimes(1));
    await drawn();
    pressResend(view);
    await drawn();
    expect(textOfHost(buttons(view)[1])).toBe("送っています…");
    expect(actions.resend).not.toHaveBeenCalled();
    answer({ ok: false, code: "not_confirmed" });
    await vi.waitFor(() => expect(widget.token!.current.value).toBe(""));
    fresh("0.token-for-the-resend");
    await vi.waitFor(() => expect(actions.resend).toHaveBeenCalledWith({ email: EMAIL, captchaToken: "0.token-for-the-resend" }));
    await vi.waitFor(() => expect(view.text()).toContain(WORDS.resent));
  });
});

describe("「別のアドレスでやり直す」", () => {
  it("lets the address and the password go and brings the empty form back; the tab shown again tries nothing", async () => {
    const view = await waiting();
    pressRestart(view);
    await drawn();
    expect(view.hosts((h) => h.type === "h1").map(textOfHost)).toEqual(["アカウントを作る"]);
    const inputs = view.hosts((h) => h.type === "input");
    expect(inputs.map((i) => i.props.id)).toEqual(["signup-email", "signup-password", "signup-password-again"]);
    expect(inputs.map((i) => i.props.value)).toEqual(["", "", ""]);
    later();
    fresh("0.next");
    tab.show();
    await drawn();
    await drawn();
    expect(flows.signIn).not.toHaveBeenCalled();
    expect(JSON.stringify(view.tree)).not.toContain(PASSWORD);
  });

  it("while a sign-in is on its way: shown pressed, and a refusal's answer then brings the empty form back", async () => {
    let answer!: (v: unknown) => void;
    flows.signIn.mockReturnValue(new Promise((r) => (answer = r)));
    const view = await waiting();
    pressDone(view);
    await vi.waitFor(() => expect(flows.signIn).toHaveBeenCalledTimes(1));
    pressRestart(view);
    await drawn();
    // Still the waiting screen, the restart shown pressed.
    expect(view.text()).toContain(WORDS.title);
    const restart = buttons(view)[2];
    expect(restart.props["aria-busy"]).toBe(true);
    expect(textOfHost(restart)).toBe(WORDS.restart);
    answer({ ok: false, code: "not_confirmed" });
    await vi.waitFor(() => expect(view.hosts((h) => h.type === "h1").map(textOfHost)).toEqual(["アカウントを作る"]));
    expect(view.hosts((h) => h.type === "input").map((i) => i.props.value)).toEqual(["", "", ""]);
    expect(nav.to).toEqual([]);
    expect(view.text()).not.toContain(WORDS.notYet);
  });

  it.each([
    ["made", "/app/welcome"],
    ["opened", "/app"],
  ] as const)("while a sign-in is on its way, and it went through (key %s): on to %s, never the form to a signed-in tab", async (key, landing) => {
    let answer!: (v: unknown) => void;
    flows.signIn.mockReturnValue(new Promise((r) => (answer = r)));
    const view = await waiting();
    pressDone(view);
    await vi.waitFor(() => expect(flows.signIn).toHaveBeenCalledTimes(1));
    pressRestart(view);
    answer({ ok: true, userId: "u", key });
    await vi.waitFor(() => expect(nav.to).toEqual([landing]));
    expect(view.hosts((h) => h.type === "h1").map(textOfHost)).toEqual([WORDS.title]);
    expect(view.hosts((h) => h.type === "input")).toEqual([]);
  });

  it("while a try by itself is on its way: the same (it waits for the answer)", async () => {
    let answer!: (v: unknown) => void;
    flows.signIn.mockReturnValue(new Promise((r) => (answer = r)));
    const view = await waiting();
    tab.show();
    await vi.waitFor(() => expect(flows.signIn).toHaveBeenCalledTimes(1));
    pressRestart(view);
    await drawn();
    expect(view.text()).toContain(WORDS.title);
    answer({ ok: true, userId: "u", key: "made" });
    await vi.waitFor(() => expect(nav.to).toEqual(["/app/welcome"]));
  });

  it("a new account made after it waits again for its own address", async () => {
    const view = await waiting();
    pressRestart(view);
    await drawn();
    fresh("0.signup-2");
    type(view, "signup-email", "other@example.test");
    type(view, "signup-password", PASSWORD);
    type(view, "signup-password-again", PASSWORD);
    await drawn();
    await (view.host((h) => h.type === "form").props.onSubmit as (e: unknown) => Promise<void>)(fakeEvent());
    await drawn();
    expect(view.text()).toContain("other@example.test");
    fresh();
    later();
    await shownAndTried(1);
    expect(flows.signIn.mock.calls[0][0].email).toBe("other@example.test");
  });
});

describe("[review 2] a press is never sent twice, nor for a screen left behind", () => {
  /** /signup's form, filled in, with a token ready. */
  async function form(): Promise<Mounted> {
    const view = mount(() => SignupForm());
    fresh("0.token-of-the-signup");
    type(view, "signup-email", EMAIL);
    type(view, "signup-password", PASSWORD);
    type(view, "signup-password-again", PASSWORD);
    await drawn();
    return view;
  }
  const submitForm = (view: Mounted) => (view.host((h) => h.type === "form").props.onSubmit as (e: unknown) => Promise<void> | undefined)(fakeEvent());

  it("「アカウントを作る」 pressed twice before it is drawn (a double tap, Enter): one sign-up, and none after the waiting screen", async () => {
    actions.signUp.mockResolvedValue({ ok: true, code: "signup_exists_or_sent" });
    const view = await form();
    void submitForm(view);
    void submitForm(view);
    await vi.waitFor(() => expect(view.text()).toContain(WORDS.title));
    // A new token for a second one to take, if one were waiting.
    fresh("0.would-be-second");
    await new Promise((r) => setTimeout(r, 300));
    expect(actions.signUp).toHaveBeenCalledTimes(1);
    expect(widget.token!.current.value).toBe("0.would-be-second");
  });

  it("「メールを送り直す」 pressed twice before it is drawn: one mail", async () => {
    actions.resend.mockResolvedValue({ ok: true, code: "confirmation_sent" });
    const view = await waiting();
    pressResend(view);
    pressResend(view);
    await vi.waitFor(() => expect(view.text()).toContain(WORDS.resent));
    fresh("0.would-be-second");
    await new Promise((r) => setTimeout(r, 300));
    expect(actions.resend).toHaveBeenCalledTimes(1);
  });

  it("a press waiting for its turn, pressed again: still one (「メールを送り直す」 behind a sign-in, 「確認しました」 behind a resend)", async () => {
    let answer!: (v: unknown) => void;
    flows.signIn.mockReturnValueOnce(new Promise((r) => (answer = r)));
    actions.resend.mockResolvedValue({ ok: true, code: "confirmation_sent" });
    const view = await waiting();
    pressDone(view);
    await vi.waitFor(() => expect(flows.signIn).toHaveBeenCalledTimes(1));
    pressResend(view);
    pressResend(view);
    answer({ ok: false, code: "not_confirmed" });
    await vi.waitFor(() => expect(widget.token!.current.value).toBe(""));
    fresh("0.for-the-resend");
    await vi.waitFor(() => expect(actions.resend).toHaveBeenCalledTimes(1));
    fresh("0.would-be-second");
    await new Promise((r) => setTimeout(r, 300));
    expect(actions.resend).toHaveBeenCalledTimes(1);

    let sent!: (v: unknown) => void;
    actions.resend.mockReturnValueOnce(new Promise((r) => (sent = r)));
    pressResend(view);
    await vi.waitFor(() => expect(actions.resend).toHaveBeenCalledTimes(2));
    pressDone(view);
    pressDone(view);
    sent({ ok: true, code: "confirmation_sent" });
    await vi.waitFor(() => expect(widget.token!.current.value).toBe(""));
    fresh("0.for-the-sign-in");
    await vi.waitFor(() => expect(flows.signIn).toHaveBeenCalledTimes(2));
    fresh("0.would-be-third");
    await new Promise((r) => setTimeout(r, 300));
    expect(flows.signIn).toHaveBeenCalledTimes(2);
  });

  it("「確認しました」 waiting for its token, then 「別のアドレスでやり直す」: the old account is not signed in with the new form's token, and the new form is not held up", async () => {
    actions.signUp.mockResolvedValue({ ok: true, code: "signup_exists_or_sent" });
    const view = await waiting();
    widget.token!.current.value = "";
    pressDone(view);
    await drawn();
    pressRestart(view);
    await drawn();
    // The new form's own token, and its press.
    type(view, "signup-email", "other@example.test");
    type(view, "signup-password", PASSWORD);
    type(view, "signup-password-again", PASSWORD);
    await drawn();
    fresh("0.token-of-the-new-form");
    void submitForm(view);
    await vi.waitFor(() => expect(actions.signUp).toHaveBeenCalledTimes(2));
    expect(actions.signUp.mock.calls[1][0]).toMatchObject({ email: "other@example.test", captchaToken: "0.token-of-the-new-form" });
    await new Promise((r) => setTimeout(r, 300));
    expect(flows.signIn).not.toHaveBeenCalled();
  });

  it("「メールを送り直す」 waiting for its token, then 「別のアドレスでやり直す」: no mail to the address let go", async () => {
    const view = await waiting();
    widget.token!.current.value = "";
    pressResend(view);
    await drawn();
    pressRestart(view);
    await drawn();
    fresh("0.token-of-the-new-form");
    await new Promise((r) => setTimeout(r, 300));
    expect(actions.resend).not.toHaveBeenCalled();
    // The token stays for the new form.
    expect(widget.token!.current.value).toBe("0.token-of-the-new-form");
  });

  it.each(["確認しました", "メールを送り直す"] as const)("a press of 「%s」 with a token past 280 s (a tab frozen in the background): not sent, the widget makes a new one, and that one goes", async (which) => {
    actions.resend.mockResolvedValue({ ok: true, code: "confirmation_sent" });
    const view = await waiting();
    widget.token!.current.value = "0.old-token";
    widget.token!.current.dataset.tokenAt = String(Date.now() - TURNSTILE_TOKEN_STALE_MS - 10_000);
    const round = widget.round;
    const action = which === "確認しました" ? flows.signIn : actions.resend;
    if (which === "確認しました") pressDone(view);
    else pressResend(view);
    await drawn();
    await drawn();
    expect(action).not.toHaveBeenCalled();
    expect(widget.round).toBe(round + 1);
    fresh("0.new-token");
    await vi.waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    expect(action.mock.calls[0][0].captchaToken).toBe("0.new-token");
  });
});

describe("left the page (「← Otodoke」, back) in the middle of a try or a request", () => {
  // The clock and the timers both fake here.
  beforeEach(() => {
    vi.useRealTimers();
    vi.useFakeTimers();
  });

  /** Long after, with the tab hidden and shown again and focused: what the left screen still does. */
  async function longAfter() {
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    tab.hide();
    tab.show();
    tab.focus();
    fresh("0.token-long-after");
    await vi.advanceTimersByTimeAsync(10 * 60_000);
  }

  it("while a try by itself waits for its token: nothing is sent, even when a token comes; no timer is left; no move", async () => {
    const view = await waiting();
    widget.token!.current.value = "";
    tab.show();
    await drawn();
    view.unmount();
    // The token the widget was making comes after all.
    fresh("0.late-token");
    await longAfter();
    expect(flows.signIn).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(nav.to).toEqual([]);
  });

  it("while a pressed sign-in is in flight: its answer is not read, nothing more is sent, no timer is left", async () => {
    let answer!: (v: unknown) => void;
    flows.signIn.mockReturnValueOnce(new Promise((r) => (answer = r)));
    const view = await waiting();
    pressDone(view);
    await vi.waitFor(() => expect(flows.signIn).toHaveBeenCalledTimes(1));
    view.unmount();
    answer({ ok: false, code: "not_confirmed" });
    await drawn();
    await longAfter();
    expect(flows.signIn).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(nav.to).toEqual([]);
  });

  it("while a sign-in is in flight that then goes through: no move from the page left", async () => {
    let answer!: (v: unknown) => void;
    flows.signIn.mockReturnValueOnce(new Promise((r) => (answer = r)));
    const view = await waiting();
    pressDone(view);
    await vi.waitFor(() => expect(flows.signIn).toHaveBeenCalledTimes(1));
    view.unmount();
    answer({ ok: true, userId: "u", key: "made" });
    await longAfter();
    expect(nav.to).toEqual([]);
    expect(flows.signIn).toHaveBeenCalledTimes(1);
  });

  it("while a resend is in flight (a press of 「確認しました」 waiting behind it): nothing is sent after it, no timer is left", async () => {
    let sent!: (v: unknown) => void;
    actions.resend.mockReturnValueOnce(new Promise((r) => (sent = r)));
    const view = await waiting();
    pressResend(view);
    await vi.waitFor(() => expect(actions.resend).toHaveBeenCalledTimes(1));
    pressDone(view);
    await drawn();
    view.unmount();
    sent({ ok: true, code: "confirmation_sent" });
    await drawn();
    await longAfter();
    expect(flows.signIn).not.toHaveBeenCalled();
    expect(actions.resend).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("control: left with nothing on its way, the same; and a new waiting screen afterwards works as before", async () => {
    const left = await waiting();
    left.unmount();
    await longAfter();
    expect(flows.signIn).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);

    await waiting();
    fresh("0.new-screen");
    tab.hide();
    tab.show();
    await vi.waitFor(() => expect(flows.signIn).toHaveBeenCalledTimes(1));
    expect(vi.getTimerCount()).toBe(1);
  });
});

describe("the maximum, checked again after the token wait", () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.useFakeTimers();
  });

  it("two tries by themselves waiting for the same token (two returns): the second is not sent past the maximum", async () => {
    await waiting();
    for (let i = 0; i < AUTO_SIGN_IN_MAX - 1; i++) {
      fresh(`0.a${i}`);
      tab.hide();
      tab.show();
      await vi.advanceTimersByTimeAsync(3_000);
    }
    expect(flows.signIn).toHaveBeenCalledTimes(AUTO_SIGN_IN_MAX - 1);
    widget.token!.current.value = "";
    tab.hide();
    tab.show(); // A waits for a token
    await vi.advanceTimersByTimeAsync(3_000);
    tab.hide();
    tab.show(); // B, 3 s later, waits too
    await vi.advanceTimersByTimeAsync(500);
    fresh("0.one"); // A takes it, the last one allowed
    await vi.advanceTimersByTimeAsync(500);
    fresh("0.two"); // the widget's next one: B would take it
    await vi.advanceTimersByTimeAsync(1_000);
    expect(flows.signIn).toHaveBeenCalledTimes(AUTO_SIGN_IN_MAX);
  });
});

describe("the password stays in this tab's memory", () => {
  it("nothing is written to storage, a cookie or the URL, from the sign-up to the next page", async () => {
    const storage = () => ({ setItem: vi.fn(), getItem: vi.fn(), removeItem: vi.fn(), clear: vi.fn(), key: vi.fn(), length: 0 });
    const local = storage();
    const session = storage();
    vi.stubGlobal("localStorage", local);
    vi.stubGlobal("sessionStorage", session);
    const cookie = vi.fn();
    Object.defineProperty(document, "cookie", { set: cookie, get: () => "", configurable: true });
    const history = { pushState: vi.fn(), replaceState: vi.fn() };
    vi.stubGlobal("history", history);

    flows.signIn.mockResolvedValueOnce({ ok: false, code: "not_confirmed" }).mockResolvedValueOnce({ ok: true, userId: "u", key: "made" });
    const view = await waiting();
    await shownAndTried(1);
    fresh("0.second");
    pressDone(view);
    await vi.waitFor(() => expect(nav.to).toEqual(["/app/welcome"]));

    for (const spy of [local.setItem, session.setItem, cookie, history.pushState, history.replaceState]) expect(spy).not.toHaveBeenCalled();
    expect(nav.to.join(" ")).not.toContain(PASSWORD);
    // Nor drawn: no field holds it once the mail went.
    expect(JSON.stringify(view.tree)).not.toContain(PASSWORD);
  });

  it("the form's and the handoff's sources name no storage, cookie or URL writer (and the check finds a planted one)", () => {
    const WRITERS = /localStorage|sessionStorage|indexedDB|document\.cookie|cookieStore|history\.(push|replace)State|location\.(href|assign|replace)|URLSearchParams|searchParams/;
    const form = withoutComments(read(path.join(process.cwd(), "src/app/signup/signup-form.tsx")));
    const handoff = withoutComments(read(path.join(process.cwd(), "src/lib/login-handoff.ts")));
    expect(form).not.toMatch(WRITERS);
    expect(handoff).not.toMatch(WRITERS);
    expect(form).toContain("account.current = { email: typed.email, password: typed.password }");
    // The handoff carries the address and a code only.
    expect(handoff).not.toMatch(/password/i);
    // Negative control.
    expect(`${form}\nsessionStorage.setItem("p", password);`).toMatch(WRITERS);
  });
});
