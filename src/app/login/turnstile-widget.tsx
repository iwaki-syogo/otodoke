"use client";

import { useEffect, useRef, useState } from "react";
import { useFormStatus } from "react-dom";
import { TURNSTILE_UNAVAILABLE_MESSAGE } from "@/lib/login-errors";
import { CAPTCHA_ENFORCED, TURNSTILE_RESPONSE_FIELD, TURNSTILE_SCRIPT_URL, TURNSTILE_SITEKEY, TURNSTILE_UNAVAILABLE, turnstileErrorIsFatal } from "@/lib/turnstile";

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
    // Lets a later mount try again (the form is drawn anew after every send).
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
 * The bot check on the login form (Cloudflare Turnstile, Managed mode). Most visitors see a
 * checkmark without doing anything. The token goes into a hidden field that this component owns,
 * so the form posts it to the server action, which hands it to Supabase.
 *
 * - Only this component writes the field; React never sets its value (no value or defaultValue):
 *   React re-applies defaultValue on every re-render, and on a hidden input that is the value.
 * - The login button holds a press until the field has a token (src/app/login/submit-button.tsx).
 *   When the script cannot load, a short notice takes the widget's place and the field is marked
 *   unavailable, so the button sends at once.
 * - Each token can be checked once. After a send the form comes back drawn anew (Next.js remounts
 *   it after a Server Action redirects), and if it stays mounted the widget is reset here: either
 *   way the next press gets a new token.
 * - The notice is shown only while Supabase enforces the check (CAPTCHA_ENFORCED): until then a
 *   press without a token sends the mail, and "reload or try another browser" would be wrong.
 * - `hideUnavailableNotice`: the page already says the same thing above the form (a send came back
 *   with captcha_missing: reload or try another browser), so the notice would only repeat it. The
 *   field is still marked unavailable.
 */
export function TurnstileWidget({
  hideUnavailableNotice = false,
  captchaEnforced = CAPTCHA_ENFORCED,
}: { hideUnavailableNotice?: boolean; captchaEnforced?: boolean } = {}) {
  const container = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const widgetId = useRef<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const { pending } = useFormStatus();
  const wasPending = useRef(false);

  useEffect(() => {
    let cancelled = false;
    const setToken = (token: string) => {
      if (field.current) field.current.value = token;
    };
    // A new widget has no token yet, whatever the browser may have restored into the field.
    setToken("");
    loadTurnstile()
      .then((turnstile) => {
        if (cancelled || !container.current) return;
        widgetId.current =
          turnstile.render(container.current, {
            sitekey: TURNSTILE_SITEKEY,
            theme: "light",
            language: "ja",
            size: "flexible",
            // This component owns the hidden field; Turnstile must not add a second one.
            "response-field": false,
            callback: (token: string) => setToken(token),
            "expired-callback": () => setToken(""),
            "timeout-callback": () => setToken(""),
            // Without this handler Turnstile throws. Returning nothing keeps Turnstile's console
            // warning with the error code (for debugging); the widget shows its own error state.
            // An error Turnstile does not retry (a host the sitekey does not allow, ...) means no
            // token will come: treated like a script that cannot load, so the button sends at once.
            "error-callback": (code?: unknown) => {
              setToken("");
              if (!cancelled && turnstileErrorIsFatal(code)) setUnavailable(true);
            },
            // A browser Turnstile cannot run in: no token will come either.
            "unsupported-callback": () => {
              if (!cancelled) setUnavailable(true);
            },
          }) ?? null;
      })
      .catch(() => {
        // Script blocked, offline or Cloudflare down (or the widget would not draw).
        if (!cancelled) setUnavailable(true);
      });
    return () => {
      cancelled = true;
      if (widgetId.current && window.turnstile) window.turnstile.remove(widgetId.current);
      widgetId.current = null;
    };
  }, []);

  // A send has finished while this form stayed mounted: the token went with it, get a new one.
  useEffect(() => {
    if (wasPending.current && !pending) {
      if (field.current) field.current.value = "";
      if (widgetId.current && window.turnstile) window.turnstile.reset(widgetId.current);
    }
    wasPending.current = pending;
  }, [pending]);

  return (
    <>
      <input ref={field} type="hidden" name={TURNSTILE_RESPONSE_FIELD} data-turnstile={unavailable ? TURNSTILE_UNAVAILABLE : undefined} />
      {unavailable && captchaEnforced && !hideUnavailableNotice ? (
        <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">{TURNSTILE_UNAVAILABLE_MESSAGE}</p>
      ) : null}
      <div ref={container} data-turnstile-widget hidden={unavailable} className="min-h-[65px] w-full" />
    </>
  );
}
