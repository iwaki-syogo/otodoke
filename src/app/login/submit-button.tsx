"use client";

import { useRef, useState, type MouseEvent } from "react";
import { useFormStatus } from "react-dom";
import { TURNSTILE_TICK_PROMPT } from "@/lib/login-errors";
import { CAPTCHA_ENFORCED, TURNSTILE_RESPONSE_FIELD, tokenSettled, tokenWaitMs, waitForToken } from "@/lib/turnstile";

/**
 * 「リンクを送る」 with a visible press: a spinner and 「送信中…」 from the press until the form
 * has been sent.
 *
 * A press before the bot check has its token is held, with the same spinner, until the token is
 * in the form: at most TURNSTILE_WAIT_MS while Supabase does not enforce the check, and
 * TURNSTILE_ENFORCED_WAIT_MS once it does (a send without a token can only fail then; see
 * turnstile.ts). Then the form is sent, with or without a token: Supabase decides. There is no wait when
 * the token is already there, the check could not load, or the address is not valid yet (the
 * browser says so, and nothing is sent).
 *
 * When the check shows its checkbox (Managed mode asks some visitors to tick it), the held button
 * says so instead of spinning (TURNSTILE_TICK_PROMPT). Once CAPTCHA is enforced the wait does not
 * run out meanwhile (no token comes without the tick); the tick's token sends the form.
 *
 * Not `disabled` (a pressed button should look pressed, not greyed out). A second press while
 * holding or sending is ignored instead: cancelling the click also cancels Enter in the address
 * field, which the browser turns into a click on this button. Without JavaScript this is a plain
 * submit button.
 */
export function LoginSubmitButton({ captchaEnforced = CAPTCHA_ENFORCED }: { captchaEnforced?: boolean } = {}) {
  const { pending } = useFormStatus();
  const [holding, setHolding] = useState(false);
  const [needsTick, setNeedsTick] = useState(false);
  // Refs, not state: a second press can come before React has drawn the first one.
  const held = useRef(false);
  const release = useRef(false);
  const busy = pending || holding;
  const askForTick = holding && needsTick && !pending;
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
        void waitForToken(field, { limitMs: tokenWaitMs(captchaEnforced), pauseForTick: captchaEnforced, onNeedsTick: setNeedsTick }).then(() => {
          held.current = false;
          setHolding(false);
          setNeedsTick(false);
          if (!button.isConnected) return;
          release.current = true;
          button.click();
        });
      }}
      className="flex items-center justify-center gap-2 rounded-lg bg-neutral-900 px-4 py-3 text-base font-medium text-white active:opacity-80"
    >
      {askForTick ? (
        TURNSTILE_TICK_PROMPT
      ) : busy ? (
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
