import { afterEach, describe, expect, it, vi } from "vitest";
import { TURNSTILE_UNAVAILABLE_MESSAGE } from "@/lib/login-errors";
import {
  CAPTCHA_ENFORCED,
  TURNSTILE_FATAL_ERRORS,
  TURNSTILE_SCRIPT_URL,
  TURNSTILE_SITEKEY,
  tokenSettled,
  turnstileErrorIsFatal,
  type TokenField,
} from "@/lib/turnstile";
import { mount, type Mounted, type NodeFactory } from "./hook-harness";

/**
 * The bot check of the login screens, followed over time (src/app/login/turnstile-widget.tsx).
 *
 * - The widget is drawn once per mount with the Otodoke sitekey and `response-field: false`; each
 *   token from Cloudflare goes into the token object the form holds (never a form field: the forms
 *   that take a password have no named field), and an expired, timed-out or failed check empties it.
 * - A new mount starts without a token, whatever the object held before.
 * - Each token can be checked once: when the form moves `round` on after a press, the widget is
 *   reset and the token emptied. A form drawn anew removes the old widget and draws a new one.
 * - When the script cannot load (onerror, or a page that is not Turnstile), a fixed notice takes
 *   the widget's place and the token is marked `dataset.turnstile = "unavailable"` (the press then
 *   sends at once). The next mount tries the script again.
 */

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { harnessHooks } = await import("./hook-harness");
  return harnessHooks(actual);
});

const { TurnstileWidget } = await import("@/app/login/turnstile-widget");

const TOKEN = "0.first-token-from-cloudflare";
const TOKEN_2 = "0.second-token-from-cloudflare";

type Options = Record<string, unknown> & {
  callback: (token: string) => void;
  "expired-callback": () => void;
  "timeout-callback": () => void;
  "error-callback": (code?: string) => unknown;
};

/** Cloudflare's window.turnstile, recording what the widget asks of it. */
function fakeTurnstile() {
  const drawn: Array<{ id: string; container: unknown; options: Options }> = [];
  const api = {
    render: vi.fn((container: unknown, options: Options) => {
      const id = `widget-${drawn.length + 1}`;
      drawn.push({ id, container, options });
      return id;
    }),
    reset: vi.fn(),
    remove: vi.fn(),
  };
  return { api, drawn, last: () => drawn[drawn.length - 1] };
}

/** document, enough for adding the script tag; `scripts` are the tags added so far. */
function fakeDocument() {
  const scripts: Array<{ src?: string; onload?: () => void; onerror?: () => void; remove: () => void }> = [];
  const doc = {
    createElement: vi.fn((tag: string) => {
      if (tag !== "script") throw new Error(`unexpected <${tag}>`);
      const script = { remove: vi.fn() };
      scripts.push(script);
      return script;
    }),
    head: { appendChild: vi.fn() },
  };
  vi.stubGlobal("document", doc);
  return { doc, scripts };
}

const nodes: NodeFactory = () => ({ dataset: {} });
/** The token object of each mounted widget (the form's ref). */
const tokens = new WeakMap<Mounted, { current: TokenField }>();
/** The props of each mounted widget, which a test may change before rendering again. */
const propsOf = new WeakMap<Mounted, { round: number; captchaEnforced?: boolean }>();
// The widget as it will run once Supabase enforces the check (CAPTCHA_ENFORCED = true): the notice
// shows. While it is off (the default) the notice stays hidden: see "while CAPTCHA is off" below.
function widget(token: TokenField = { value: "", dataset: {} }, props: { round: number; captchaEnforced?: boolean } = { round: 0, captchaEnforced: true }, Widget = TurnstileWidget): Mounted {
  const ref = { current: token };
  const view = mount(() => Widget({ tokenRef: ref, ...props }), nodes);
  tokens.set(view, ref);
  propsOf.set(view, props);
  return view;
}
const fieldOf = (view: Mounted) => tokens.get(view)!.current;
/** The form moves `round` on: a press used the token. */
function nextRound(view: Mounted) {
  propsOf.get(view)!.round += 1;
  view.rerender();
}
const slotOf = (view: Mounted) => view.host((h) => h.type === "div" && "data-turnstile-widget" in h.props);
/** Lets the script promise and the state updates it causes run. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the Turnstile widget on the login form", () => {
  it("draws the widget once in its slot, with the Otodoke sitekey, and keeps each token in the form's token object", async () => {
    const t = fakeTurnstile();
    vi.stubGlobal("window", { turnstile: t.api });
    const view = widget();
    await settle();
    expect(t.api.render).toHaveBeenCalledTimes(1);
    expect(t.last().container).toBe(view.nodeOf(slotOf(view)));
    expect(t.last().options).toMatchObject({ sitekey: TURNSTILE_SITEKEY, "response-field": false });

    const field = fieldOf(view);
    const { options } = t.last();
    options.callback(TOKEN);
    expect(field.value).toBe(TOKEN);
    options["expired-callback"]();
    expect(field.value).toBe("");
    options.callback(TOKEN_2);
    options["timeout-callback"]();
    expect(field.value).toBe("");
    options.callback(TOKEN_2);
    options["error-callback"]("300030");
    expect(field.value).toBe("");
  });

  it("puts nothing in the form: no field at all, so a form that takes a password stays without a named one", async () => {
    const t = fakeTurnstile();
    vi.stubGlobal("window", { turnstile: t.api });
    const view = widget();
    await settle();
    t.last().options.callback(TOKEN);
    view.rerender();
    expect(view.hosts((h) => ["input", "select", "textarea", "button"].includes(h.type))).toEqual([]);
    expect(view.hosts((h) => "name" in h.props)).toEqual([]);
    expect(fieldOf(view).value).toBe(TOKEN);
  });

  it("starts without a token, even when the object held one from before", async () => {
    const t = fakeTurnstile();
    vi.stubGlobal("window", { turnstile: t.api });
    const view = widget({ value: "0.already-used", dataset: { turnstile: "interactive" } });
    await settle();
    expect(fieldOf(view).value).toBe("");
    expect(fieldOf(view).dataset.turnstile).toBeUndefined();
    t.last().options.callback(TOKEN);
    expect(fieldOf(view).value).toBe(TOKEN);
  });

  it("when the form moves the round on after a press, resets the widget and empties the token (a token is checked once)", async () => {
    const t = fakeTurnstile();
    vi.stubGlobal("window", { turnstile: t.api });
    const view = widget();
    await settle();
    const field = fieldOf(view);
    t.last().options.callback(TOKEN);

    // While the press is on its way, the token stays where the form read it from.
    view.rerender();
    expect(t.api.reset).not.toHaveBeenCalled();
    expect(field.value).toBe(TOKEN);

    nextRound(view);
    expect(t.api.reset).toHaveBeenCalledTimes(1);
    expect(t.api.reset).toHaveBeenCalledWith(t.last().id);
    expect(field.value).toBe("");
    // The next token is the one the next press sends.
    t.last().options.callback(TOKEN_2);
    expect(field.value).toBe(TOKEN_2);
    // Rendering again without a send resets nothing more.
    view.rerender();
    expect(t.api.reset).toHaveBeenCalledTimes(1);
  });

  it("when the form is drawn anew, removes the old widget and draws a new one without a token", async () => {
    const t = fakeTurnstile();
    vi.stubGlobal("window", { turnstile: t.api });
    const first = widget();
    await settle();
    t.last().options.callback(TOKEN);
    first.unmount();
    expect(t.api.remove).toHaveBeenCalledTimes(1);
    expect(t.api.remove).toHaveBeenCalledWith("widget-1");
    // A late answer for the removed widget writes nowhere.
    expect(() => t.drawn[0].options.callback("0.late")).not.toThrow();
    expect(fieldOf(first).value).toBe(TOKEN);

    const second = widget();
    await settle();
    expect(t.api.render).toHaveBeenCalledTimes(2);
    expect(fieldOf(second).value).toBe("");
    t.last().options.callback(TOKEN_2);
    expect(fieldOf(second).value).toBe(TOKEN_2);
  });
});

describe("when Cloudflare's script cannot load", () => {
  it("keeps the slot while loading, then shows the fixed notice in the widget's place and marks the token", async () => {
    vi.stubGlobal("window", {});
    const { doc, scripts } = fakeDocument();
    const view = widget();
    expect(doc.createElement).toHaveBeenCalledWith("script");
    expect(scripts[0].src).toBe(TURNSTILE_SCRIPT_URL);
    expect(doc.head.appendChild).toHaveBeenCalledWith(scripts[0]);
    // Loading: the 65px slot is there and nothing is said yet.
    expect(view.text()).not.toContain(TURNSTILE_UNAVAILABLE_MESSAGE);
    expect(slotOf(view).props.hidden).toBe(false);
    expect(fieldOf(view).dataset.turnstile).toBeUndefined();

    scripts[0].onerror!();
    await settle();
    expect(view.text()).toBe(TURNSTILE_UNAVAILABLE_MESSAGE);
    expect(slotOf(view).props.hidden).toBe(true);
    expect(fieldOf(view).dataset.turnstile).toBe("unavailable");
    expect(fieldOf(view).value).toBe("");
    // The notice stands where the widget would: right before the (hidden) slot.
    const order = view.hosts(() => true).map((h) => h.type);
    expect(order).toEqual(["p", "div"]);
    expect(TURNSTILE_UNAVAILABLE_MESSAGE).toBe("確認を読み込めませんでした。ページを読み込み直すか、別のブラウザでお試しください。");
  });

  it("treats a script that loads without Turnstile (a proxy's block page) the same way, and tries again on the next mount", async () => {
    const win: { turnstile?: ReturnType<typeof fakeTurnstile>["api"] } = {};
    vi.stubGlobal("window", win);
    const { scripts } = fakeDocument();
    const first = widget();
    scripts[0].onload!();
    await settle();
    expect(first.text()).toBe(TURNSTILE_UNAVAILABLE_MESSAGE);
    expect(scripts[0].remove).toHaveBeenCalled();
    first.unmount();

    // The form is drawn anew (e.g. after a send): the script is asked for again, and this time it works.
    const second = widget();
    expect(scripts).toHaveLength(2);
    const t = fakeTurnstile();
    win.turnstile = t.api;
    scripts[1].onload!();
    await settle();
    expect(t.api.render).toHaveBeenCalledTimes(1);
    expect(second.text()).not.toContain(TURNSTILE_UNAVAILABLE_MESSAGE);
    expect(slotOf(second).props.hidden).toBe(false);
    expect(fieldOf(second).dataset.turnstile).toBeUndefined();
  });
});

describe("when Turnstile itself answers with an error (review R2b-2)", () => {
  it.each(["110100", "110110", "110200", "200100", "400020", "400021", "400070"])(
    "treats %s (Cloudflare's table: Retry No) like a script that cannot load: the button sends at once",
    async (code) => {
      const t = fakeTurnstile();
      vi.stubGlobal("window", { turnstile: t.api });
      const view = widget();
      await settle();
      t.last().options.callback(TOKEN);
      t.last().options["error-callback"](code);
      await settle();
      expect(fieldOf(view).value).toBe("");
      expect(fieldOf(view).dataset.turnstile).toBe("unavailable");
      expect(tokenSettled(fieldOf(view))).toBe(true);
      expect(slotOf(view).props.hidden).toBe(true);
      expect(view.text()).toBe(TURNSTILE_UNAVAILABLE_MESSAGE);
    },
  );

  it("reads the code whether Turnstile passes it as a string or a number", async () => {
    const t = fakeTurnstile();
    vi.stubGlobal("window", { turnstile: t.api });
    const view = widget();
    await settle();
    (t.last().options["error-callback"] as (code: unknown) => unknown)(110200);
    await settle();
    expect(fieldOf(view).dataset.turnstile).toBe("unavailable");
  });

  it.each(["300030", "600010", "110600", "110620", "200500", "999999", undefined])(
    "keeps waiting after %s: Turnstile retries it itself, so a token can still come",
    async (code) => {
      const t = fakeTurnstile();
      vi.stubGlobal("window", { turnstile: t.api });
      const view = widget();
      await settle();
      t.last().options["error-callback"](code);
      await settle();
      expect(fieldOf(view).dataset.turnstile).toBeUndefined();
      expect(tokenSettled(fieldOf(view))).toBe(false);
      expect(view.text()).toBe("");
      // The retry's token is the one the press sends.
      t.last().options.callback(TOKEN_2);
      expect(fieldOf(view).value).toBe(TOKEN_2);
    },
  );

  it("treats a browser Turnstile does not support the same way (unsupported-callback)", async () => {
    const t = fakeTurnstile();
    vi.stubGlobal("window", { turnstile: t.api });
    const view = widget();
    await settle();
    (t.last().options["unsupported-callback"] as () => void)();
    await settle();
    expect(fieldOf(view).dataset.turnstile).toBe("unavailable");
  });

  it("follows Cloudflare's table and nothing else", () => {
    expect([...TURNSTILE_FATAL_ERRORS]).toEqual(["110100", "110110", "110200", "200100", "400020", "400021", "400070"]);
    expect(turnstileErrorIsFatal("300030")).toBe(false);
    expect(turnstileErrorIsFatal(null)).toBe(false);
    expect(turnstileErrorIsFatal({ code: "110200" })).toBe(false);
  });
});

describe("when Turnstile asks for a tick (review R2b-1)", () => {
  type Interactive = { "before-interactive-callback": () => void; "after-interactive-callback": () => void };
  const opts = (t: ReturnType<typeof fakeTurnstile>) => t.last().options as unknown as Options & Interactive;

  it("marks the field while the checkbox waits, and clears it when it is left, ticked or timed out", async () => {
    const t = fakeTurnstile();
    vi.stubGlobal("window", { turnstile: t.api });
    const view = widget();
    await settle();
    expect(fieldOf(view).dataset.turnstile).toBeUndefined();

    opts(t)["before-interactive-callback"]();
    await settle();
    expect(fieldOf(view).dataset.turnstile).toBe("interactive");
    expect(tokenSettled(fieldOf(view))).toBe(false);
    opts(t)["after-interactive-callback"]();
    await settle();
    expect(fieldOf(view).dataset.turnstile).toBeUndefined();

    opts(t)["before-interactive-callback"]();
    await settle();
    opts(t).callback(TOKEN);
    await settle();
    expect(fieldOf(view).dataset.turnstile).toBeUndefined();
    expect(fieldOf(view).value).toBe(TOKEN);

    opts(t)["before-interactive-callback"]();
    await settle();
    opts(t)["timeout-callback"]();
    await settle();
    expect(fieldOf(view).dataset.turnstile).toBeUndefined();
    expect(fieldOf(view).value).toBe("");
  });

  it("clears it on a retried error, and turns it into unavailable on one Turnstile does not retry", async () => {
    const t = fakeTurnstile();
    vi.stubGlobal("window", { turnstile: t.api });
    const view = widget();
    await settle();
    opts(t)["before-interactive-callback"]();
    await settle();
    opts(t)["error-callback"]("600010");
    await settle();
    expect(fieldOf(view).dataset.turnstile).toBeUndefined();
    opts(t)["before-interactive-callback"]();
    await settle();
    opts(t)["error-callback"]("110200");
    await settle();
    expect(fieldOf(view).dataset.turnstile).toBe("unavailable");
  });

  it("starts the next press without a tick to wait for, after a press that stayed on the page", async () => {
    const t = fakeTurnstile();
    vi.stubGlobal("window", { turnstile: t.api });
    const view = widget();
    await settle();
    opts(t)["before-interactive-callback"]();
    await settle();
    nextRound(view);
    await settle();
    expect(fieldOf(view).dataset.turnstile).toBeUndefined();
    expect(t.api.reset).toHaveBeenCalledTimes(1);
  });
});

describe("while CAPTCHA is off (review R2b-3)", () => {
  it("is off today: turning it on in Supabase needs a commit that sets CAPTCHA_ENFORCED", () => {
    expect(CAPTCHA_ENFORCED).toBe(false);
  });

  it("says nothing when the script cannot load (the mail goes out without a token), and still lets the button send at once", async () => {
    vi.stubGlobal("window", {});
    const { scripts } = fakeDocument();
    // A fresh module: the script promise of an earlier test (one that loaded) is not reused.
    vi.resetModules();
    const fresh = (await import("@/app/login/turnstile-widget")).TurnstileWidget;
    const view = widget(undefined, { round: 0 }, fresh);
    scripts[0].onerror!();
    await settle();
    expect(view.text()).toBe("");
    expect(view.hosts((h) => h.type === "p")).toHaveLength(0);
    expect(slotOf(view).props.hidden).toBe(true);
    expect(fieldOf(view).dataset.turnstile).toBe("unavailable");
  });
});
