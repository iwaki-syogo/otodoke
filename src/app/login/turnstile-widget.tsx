"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import { TURNSTILE_UNAVAILABLE_MESSAGE } from "@/lib/login-errors";
import { CAPTCHA_ENFORCED, TURNSTILE_INTERACTIVE, TURNSTILE_SCRIPT_URL, TURNSTILE_SITEKEY, TURNSTILE_UNAVAILABLE, turnstileErrorIsFatal, type TokenField } from "@/lib/turnstile";

/** The part of Cloudflare's `window.turnstile` this form uses. */
type TurnstileApi = {
  render: (container: HTMLElement, options: Record<string, unknown>) => string | undefined;
  reset: (widgetId: string) => void;
  remove: (widgetId: string) => void;
};

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

let scriptPromise: Promise<TurnstileApi> | null = null;

/** Adds Cloudflare's script once per page load; later calls share the same promise. */
function loadTurnstile(): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise<TurnstileApi>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = TURNSTILE_SCRIPT_URL;
    script.async = true;
    // Lets a later mount try again (another form, or this one drawn anew).
    const fail = (reason: string) => {
      scriptPromise = null;
      script.remove();
      reject(new Error(reason));
    };
    // Loaded but no Turnstile: something else answered the URL (a proxy's block page).
    script.onload = () => (window.turnstile ? resolve(window.turnstile) : fail("turnstile missing"));
    script.onerror = () => fail("turnstile script failed to load");
    document.head.appendChild(script);
  });
  return scriptPromise;
}

/**
 * The bot check of the login screens (Cloudflare Turnstile, Managed mode). Most visitors see a
 * checkmark without doing anything. The token goes into `tokenRef`, an object the form holds, never
 * into a form field: the forms that take a password have no named field (password-forms.test.ts),
 * and the others are sent in code the same way. The form's press reads it with tokenForPress
 * (src/lib/turnstile.ts) and hands it to the Action, which hands it to Supabase.
 *
 * - Its `dataset.turnstile` is "unavailable" when no token will come (the script could not load,
 *   an error Turnstile does not retry, a browser it does not support): the press sends at once.
 *   It is "interactive" while the checkbox waits for the visitor's tick: the held press asks for it.
 * - Each token can be checked once. The form moves `round` on after a press has used one: the
 *   widget is reset and the token emptied, so the next press gets a new one. A new mount starts
 *   without a token, and a removed widget's late answer is written nowhere.
 * - The notice is shown while Supabase enforces the check (CAPTCHA_ENFORCED, on in production):
 *   with the check off, a press without a token goes through, and "reload or try another browser"
 *   would be wrong.
 */
export function TurnstileWidget({ tokenRef, round = 0, captchaEnforced = CAPTCHA_ENFORCED }: { tokenRef: RefObject<TokenField>; round?: number; captchaEnforced?: boolean }) {
  const container = useRef<HTMLDivElement>(null);
  const widgetId = useRef<string | null>(null);
  /** Moves the widget on to a new token; set while a widget is drawn. */
  const resetToken = useRef<(() => void) | null>(null);
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const field = tokenRef.current;
    let noToken = false;
    let waitingForTick = false;
    // What `field.dataset.turnstile` says: no token will come, or the checkbox waits.
    const mark = () => {
      if (noToken) field.dataset.turnstile = TURNSTILE_UNAVAILABLE;
      else if (waitingForTick) field.dataset.turnstile = TURNSTILE_INTERACTIVE;
      else delete field.dataset.turnstile;
    };
    // The token, and when it came (tokenIsStale reads it: a frozen tab can outlive the token).
    const setToken = (value: string) => {
      if (cancelled) return;
      field.value = value;
      if (value) field.dataset.tokenAt = String(Date.now());
      else delete field.dataset.tokenAt;
    };
    const setTick = (waiting: boolean) => {
      if (cancelled) return;
      waitingForTick = waiting;
      mark();
    };
    const giveUp = () => {
      if (cancelled) return;
      noToken = true;
      mark();
      setUnavailable(true);
    };
    // A new widget has no token yet.
    field.value = "";
    delete field.dataset.tokenAt;
    mark();
    resetToken.current = () => {
      setToken("");
      setTick(false);
      if (widgetId.current && window.turnstile) window.turnstile.reset(widgetId.current);
    };

    loadTurnstile()
      .then((turnstile) => {
        if (cancelled || !container.current) return;
        widgetId.current =
          turnstile.render(container.current, {
            sitekey: TURNSTILE_SITEKEY,
            theme: "light",
            language: "ja",
            size: "flexible",
            // The token goes to `tokenRef` only: Turnstile must not add a field to the form.
            "response-field": false,
            callback: (value: string) => {
              setToken(value);
              setTick(false);
            },
            "expired-callback": () => setToken(""),
            // The checkbox was not ticked in time; Turnstile resets itself and may show it again.
            "timeout-callback": () => {
              setToken("");
              setTick(false);
            },
            // Managed mode asks some visitors to tick a checkbox: the held press says so.
            "before-interactive-callback": () => setTick(true),
            "after-interactive-callback": () => setTick(false),
            // Without this handler Turnstile throws. Returning nothing keeps Turnstile's console
            // warning with the error code (for debugging); the widget shows its own error state.
            // An error Turnstile does not retry means no token will come: like a script that
            // cannot load, so the press sends at once.
            "error-callback": (code?: unknown) => {
              setToken("");
              setTick(false);
              if (turnstileErrorIsFatal(code)) giveUp();
            },
            // A browser Turnstile cannot run in: no token will come either.
            "unsupported-callback": giveUp,
          }) ?? null;
      })
      // Script blocked, offline or Cloudflare down (or the widget would not draw).
      .catch(giveUp);
    return () => {
      cancelled = true;
      resetToken.current = null;
      if (widgetId.current && window.turnstile) window.turnstile.remove(widgetId.current);
      widgetId.current = null;
    };
  }, [tokenRef]);

  // A press used the token: get a new one for the next press.
  const seenRound = useRef(round);
  useEffect(() => {
    if (seenRound.current === round) return;
    seenRound.current = round;
    resetToken.current?.();
  }, [round]);

  return (
    <>
      {unavailable && captchaEnforced ? <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">{TURNSTILE_UNAVAILABLE_MESSAGE}</p> : null}
      <div ref={container} data-turnstile-widget hidden={unavailable} className="min-h-[65px] w-full" />
    </>
  );
}
