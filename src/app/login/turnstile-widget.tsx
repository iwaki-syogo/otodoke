"use client";

import { useEffect, useRef } from "react";
import { useFormStatus } from "react-dom";
import { TURNSTILE_RESPONSE_FIELD, TURNSTILE_SCRIPT_URL, TURNSTILE_SITEKEY } from "@/lib/turnstile";

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
    script.onload = () => (window.turnstile ? resolve(window.turnstile) : reject(new Error("turnstile missing")));
    script.onerror = () => {
      // Let a later mount try again (e.g. a blocked request on a flaky connection).
      scriptPromise = null;
      script.remove();
      reject(new Error("turnstile script failed to load"));
    };
    document.head.appendChild(script);
  });
  return scriptPromise;
}

/**
 * The bot check on the login form (Cloudflare Turnstile, Managed mode). Most visitors see a
 * checkmark without doing anything. The token goes into a hidden field that this component owns,
 * so the form posts it to the server action, which hands it to Supabase.
 *
 * The button never waits for the token: while Supabase's CAPTCHA is off the login works without
 * one, and once it is on a missing token comes back as a fixed message (error=captcha). Each
 * token can be checked once, so after every send the widget is reset for the next press.
 */
export function TurnstileWidget() {
  const container = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const widgetId = useRef<string | null>(null);
  const { pending } = useFormStatus();
  const wasPending = useRef(false);

  useEffect(() => {
    let cancelled = false;
    const setToken = (token: string) => {
      if (field.current) field.current.value = token;
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
            // This component owns the hidden field; Turnstile must not add a second one.
            "response-field": false,
            callback: (token: string) => setToken(token),
            "expired-callback": () => setToken(""),
            "timeout-callback": () => setToken(""),
            // Without this handler Turnstile throws. Returning nothing keeps Turnstile's console
            // warning with the error code (for debugging); the widget shows its own error state.
            "error-callback": () => {
              setToken("");
            },
          }) ?? null;
      })
      .catch(() => {
        // Script blocked or offline: the form still posts, without a token.
      });
    return () => {
      cancelled = true;
      if (widgetId.current && window.turnstile) window.turnstile.remove(widgetId.current);
      widgetId.current = null;
    };
  }, []);

  // A send has finished (sent, refused or redirected back with an error): the token is used up.
  useEffect(() => {
    if (wasPending.current && !pending) {
      if (field.current) field.current.value = "";
      if (widgetId.current && window.turnstile) window.turnstile.reset(widgetId.current);
    }
    wasPending.current = pending;
  }, [pending]);

  return (
    <>
      <input ref={field} type="hidden" name={TURNSTILE_RESPONSE_FIELD} defaultValue="" />
      <div ref={container} data-turnstile-widget className="min-h-[65px] w-full" />
    </>
  );
}
