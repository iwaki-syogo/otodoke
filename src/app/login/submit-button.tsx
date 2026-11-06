"use client";

import { useRef, useState, type MouseEvent } from "react";
import { useFormStatus } from "react-dom";
import { TURNSTILE_RESPONSE_FIELD, tokenSettled, waitUntil } from "@/lib/turnstile";

/**
 * 「リンクを送る」 with a visible press: a spinner and 「送信中…」 from the press until the form
 * has been sent.
 *
 * A press before the bot check has its token is held, with the same spinner, until the token is
 * in the form (at most TURNSTILE_WAIT_MS). Then the form is sent, with or without a token:
 * Supabase decides (it ignores a missing token while its CAPTCHA is off). There is no wait when
 * the token is already there, the check could not load, or the address is not valid yet (the
 * browser says so, and nothing is sent).
 *
 * Not `disabled` (a pressed button should look pressed, not greyed out). A second press while
 * holding or sending is ignored instead: cancelling the click also cancels Enter in the address
 * field, which the browser turns into a click on this button. Without JavaScript this is a plain
 * submit button.
 */
export function LoginSubmitButton() {
  const { pending } = useFormStatus();
  const [holding, setHolding] = useState(false);
  // Refs, not state: a second press can come before React has drawn the first one.
  const held = useRef(false);
  const release = useRef(false);
  const busy = pending || holding;
  return (
    <button
      type="submit"
      aria-busy={busy || undefined}
      onClick={(event: MouseEvent<HTMLButtonElement>) => {
        // The click this button makes itself when the hold is over: let it send the form.
        if (release.current) {
          release.current = false;
          return;
        }
        if (pending || held.current) {
          event.preventDefault();
          return;
        }
        const button = event.currentTarget;
        const form = button.form;
        const field = form?.elements.namedItem(TURNSTILE_RESPONSE_FIELD) as HTMLInputElement | null | undefined;
        if (!form || !field || tokenSettled(field) || !form.checkValidity()) return;
        event.preventDefault();
        held.current = true;
        setHolding(true);
        void waitUntil(() => tokenSettled(field)).then(() => {
          held.current = false;
          setHolding(false);
          if (!button.isConnected) return;
          release.current = true;
          button.click();
        });
      }}
      className="flex items-center justify-center gap-2 rounded-lg bg-neutral-900 px-4 py-3 text-base font-medium text-white active:opacity-80"
    >
      {busy ? (
        <>
          <span aria-hidden className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" />
          送信中…
        </>
      ) : (
        "リンクを送る"
      )}
    </button>
  );
}
