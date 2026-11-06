import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LOGIN_MESSAGES } from "@/lib/login-errors";
import { TURNSTILE_WAIT_MS, tokenForAutoAttempt, type TokenField } from "@/lib/turnstile";
import { fakeEvent, type Host } from "./element-tree";
import { mount, type Mounted } from "./hook-harness";
import { read, withoutComments } from "./source-scan";

/**
 * Onboarding screen 1 (/signup once the mail went, src/app/signup/signup-form.tsx): the tab keeps
 * the address and the password in its memory only, and signs in by itself as /login does when the
 * tab is shown again (visibilitychange to visible, focus), or when 「確認しました」 is pressed.
 * No timer tries. By itself it says nothing while the address is not confirmed; a press says so.
 * Any other refusal gets LOGIN_MESSAGES' words. The sign-in that made the first key goes on to the
 * first-run guide.
 *
 * The words are the team's onboarding-wording.md, written out here as they are there.
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
  body: "メールのリンクを押してこの画面に戻ると、自動で次へ進みます。",
  done: "確認しました",
  resend: "メールを送り直す",
  notYet: "まだ確認できていません。メールのリンクを押しましたか？",
  resent: "送り直しました",
};

const textOfHost = (h: Host | string): string => (typeof h === "string" ? h : h.children.map(textOfHost).join(""));
const drawn = () => new Promise<void>((resolve) => queueMicrotask(() => queueMicrotask(resolve)));
const type = (view: Mounted, id: string, value: string) => (view.host((h) => h.type === "input" && h.props.id === id).props.onChange as (e: unknown) => void)({ target: { value } });
const buttons = (view: Mounted) => view.hosts((h) => h.type === "button");
const pressDone = (view: Mounted) => (buttons(view)[0].props.onClick as (e: unknown) => void)(fakeEvent());

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
  widget.token!.current.value = TOKEN;
  return view;
}

/** Moves the clock past the gap between two sign-ins the screen tries by itself. */
const later = () => vi.setSystemTime(Date.now() + 10_000);

let tab: ReturnType<typeof stubTab>;
beforeEach(() => {
  actions.signUp.mockReset();
  actions.resend.mockReset();
  flows.signIn.mockReset();
  flows.signIn.mockResolvedValue({ ok: false, code: "not_confirmed" });
  widget.token = null;
  widget.round = -1;
  nav.to = [];
  vi.useFakeTimers({ toFake: ["Date"] });
  tab = stubTab();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("the waiting screen's words", () => {
  it("are the wording file's: the title, the body, the address on a line of its own, 「確認しました」 and 「メールを送り直す」", async () => {
    const view = await waiting();
    const h1 = view.hosts((h) => h.type === "h1").map(textOfHost);
    expect(h1).toEqual([WORDS.title]);
    const paragraphs = view.hosts((h) => h.type === "p").map(textOfHost);
    // The body, then the address alone (no label), in that order.
    expect(paragraphs.slice(0, 2)).toEqual([WORDS.body, EMAIL]);
    expect(buttons(view).map(textOfHost)).toEqual([WORDS.done, WORDS.resend]);
    // No standing notes, and none of the sign-up form's links.
    expect(view.hosts((h) => h.type === "a")).toEqual([]);
    expect(view.text()).not.toContain(LOGIN_MESSAGES.signup_exists_or_sent);
    expect(view.text()).not.toContain("転送するだけ");
  });

  it("the main button is black and full width; 「メールを送り直す」 reads as a link", async () => {
    const view = await waiting();
    const [done, resend] = buttons(view).map((b) => String(b.props.className));
    for (const c of ["w-full", "bg-neutral-900", "text-white", "rounded-xl", "py-4"]) expect(done.split(" ")).toContain(c);
    expect(resend).toContain("underline");
    expect(`${done} ${resend}`).not.toMatch(/shadow|gradient/);
  });
});

describe("when it signs in", () => {
  it("never by itself on a timer: only when the tab is shown again, once for the two events, and with the password from memory", async () => {
    const view = await waiting();
    // Long after the sign-up, with nothing shown again: nothing tried.
    later();
    await drawn();
    expect(flows.signIn).not.toHaveBeenCalled();
    // Hidden is no trigger.
    tab.hide();
    await drawn();
    expect(flows.signIn).not.toHaveBeenCalled();

    tab.show();
    await vi.waitFor(() => expect(flows.signIn).toHaveBeenCalledTimes(1));
    expect(flows.signIn.mock.calls[0][0]).toEqual({ email: EMAIL, password: PASSWORD, captchaToken: TOKEN });
    await drawn();
    // A focus right after (the second event of one return) is the same try.
    tab.focus();
    await drawn();
    expect(flows.signIn).toHaveBeenCalledTimes(1);
    // The token went with it: the widget moves on to a new one.
    await vi.waitFor(() => expect(widget.round).toBe(2));
    void view;
  });

  it("by itself, an address not confirmed yet is not told; pressed, it is (and not as an error)", async () => {
    const view = await waiting();
    tab.show();
    await vi.waitFor(() => expect(flows.signIn).toHaveBeenCalledTimes(1));
    await drawn();
    await drawn();
    expect(view.text()).not.toContain(WORDS.notYet);
    expect(view.text()).not.toContain(LOGIN_MESSAGES.not_confirmed);
    expect(view.hosts((h) => h.props.role === "alert")).toEqual([]);

    widget.token!.current.value = "0.token-for-the-press";
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

  it.each(["credentials", "rate", "captcha", "network", "other"] as const)("any other refusal (%s), by itself or pressed, gets LOGIN_MESSAGES' words unchanged", async (code) => {
    flows.signIn.mockResolvedValue({ ok: false, code });
    const view = await waiting();
    tab.show();
    await vi.waitFor(() => expect(view.text()).toContain(LOGIN_MESSAGES[code]));
    expect(view.text()).not.toContain(WORDS.notYet);

    later();
    widget.token!.current.value = "0.token-for-the-press";
    pressDone(view);
    await vi.waitFor(() => expect(flows.signIn).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(view.text()).toContain(LOGIN_MESSAGES[code]));
  });

  it("the sign-in that made the first key goes on to the first-run guide", async () => {
    flows.signIn.mockResolvedValue({ ok: true, userId: "u", key: "made" });
    await waiting();
    tab.show();
    await vi.waitFor(() => expect(nav.to).toEqual(["/app/welcome"]));
  });

  it("a key there already (the account was there before) opens and goes to the list, as /login does", async () => {
    flows.signIn.mockResolvedValue({ ok: true, userId: "u", key: "opened" });
    const view = await waiting();
    pressDone(view);
    await vi.waitFor(() => expect(nav.to).toEqual(["/app"]));
  });

  it("signed in but the key did not open: says so with LOGIN_MESSAGES' words and a way on, and tries no more", async () => {
    flows.signIn.mockResolvedValue({ ok: true, userId: "u", key: "not_opened", openWithAnother: vi.fn() });
    const view = await waiting();
    tab.show();
    await vi.waitFor(() => expect(view.text()).toContain(LOGIN_MESSAGES.key_not_opened));
    expect(view.hosts((h) => h.type === "a").map((a) => [a.props.href, textOfHost(a)])).toEqual([["/app", "このまま進む"]]);
    later();
    tab.show();
    await drawn();
    expect(flows.signIn).toHaveBeenCalledTimes(1);
  });

  it("a try by itself shows as pressed; a press that gets in before that is drawn waits for it, and its answer is told", async () => {
    let answer!: (v: unknown) => void;
    flows.signIn.mockReturnValue(new Promise((r) => (answer = r)));
    const view = await waiting();
    tab.show();
    // Before React has drawn the try: the button still reads 「確認しました」 and takes the press.
    pressDone(view);
    await vi.waitFor(() => expect(flows.signIn).toHaveBeenCalledTimes(1));
    await drawn();
    // Shown as pressed while it is on its way.
    expect(textOfHost(buttons(view)[0])).toBe("ログインしています…");
    answer({ ok: false, code: "not_confirmed" });
    await vi.waitFor(() => expect(view.text()).toContain(WORDS.notYet));
    // One sign-in for the two.
    expect(flows.signIn).toHaveBeenCalledTimes(1);
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
    widget.token!.current.value = "0.token-after-the-tick";
    later();
    tab.show();
    await vi.waitFor(() => expect(flows.signIn).toHaveBeenCalledTimes(1));
    expect(flows.signIn.mock.calls[0][0].captchaToken).toBe("0.token-after-the-tick");
  });

  it("no token comes (CAPTCHA enforced): nothing is sent after the wait, and nothing loops", async () => {
    vi.useRealTimers();
    vi.useFakeTimers();
    const view = await waiting();
    widget.token!.current.value = "";
    tab.show();
    await vi.advanceTimersByTimeAsync(TURNSTILE_WAIT_MS + 1_000);
    expect(flows.signIn).not.toHaveBeenCalled();
    // Long after, still nothing: no timer tries again.
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(flows.signIn).not.toHaveBeenCalled();
    expect(view.hosts((h) => h.props.role === "alert")).toEqual([]);
  });
});

describe("tokenForAutoAttempt", () => {
  it("sends a token there, never asks for the tick, and without CAPTCHA sends without one", async () => {
    vi.useRealTimers();
    expect(await tokenForAutoAttempt({ value: "0.t", dataset: {} })).toEqual({ send: true, token: "0.t" });
    expect(await tokenForAutoAttempt({ value: "", dataset: { turnstile: "interactive" } })).toEqual({ send: false });
    expect(await tokenForAutoAttempt({ value: "", dataset: { turnstile: "unavailable" } })).toEqual({ send: false });
    expect(await tokenForAutoAttempt({ value: "", dataset: { turnstile: "unavailable" } }, { captchaEnforced: false })).toEqual({ send: true, token: undefined });
    expect(await tokenForAutoAttempt({ value: "", dataset: {} }, { limitMs: 50 })).toEqual({ send: false });
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
    tab.show();
    await vi.waitFor(() => expect(flows.signIn).toHaveBeenCalledTimes(1));
    later();
    widget.token!.current.value = "0.second";
    pressDone(view);
    await vi.waitFor(() => expect(nav.to).toEqual(["/app/welcome"]));

    for (const spy of [local.setItem, session.setItem, cookie, history.pushState, history.replaceState]) expect(spy).not.toHaveBeenCalled();
    expect(nav.to.join(" ")).not.toContain(PASSWORD);
    // Nor drawn: no field holds it once the mail went.
    expect(JSON.stringify(view.tree)).not.toContain(PASSWORD);
  });

  it("the form's source names no storage, cookie or URL writer (and the check finds a planted one)", () => {
    const WRITERS = /localStorage|sessionStorage|indexedDB|document\.cookie|cookieStore|history\.(push|replace)State|location\.(href|assign|replace)|URLSearchParams|searchParams/;
    const source = withoutComments(read(path.join(process.cwd(), "src/app/signup/signup-form.tsx")));
    expect(source).not.toMatch(WRITERS);
    expect(source).toContain("account.current = { email, password }");
    // Negative control.
    expect(`${source}\nsessionStorage.setItem("p", password);`).toMatch(WRITERS);
  });
});
