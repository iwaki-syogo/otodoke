"use client";

import type { MouseEvent } from "react";
import { useFormStatus } from "react-dom";

/**
 * 「ログイン」 under the code field, built like the send button (submit-button.tsx): a spinner and
 * 「ログイン中…」 from the press until the code has been checked. Not `disabled` (a pressed button
 * should look pressed, not greyed out); a second press while checking is cancelled instead, which
 * also cancels Enter in the code field. Without JavaScript it is a plain submit button.
 *
 * A second check of the same code would fail (a code works once) and could land on the error
 * after the first one had signed in.
 */
export function CodeSubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      aria-busy={pending || undefined}
      onClick={(event: MouseEvent<HTMLButtonElement>) => {
        if (pending) event.preventDefault();
      }}
      className="flex items-center justify-center gap-2 rounded-lg bg-neutral-900 px-4 py-3 text-base font-medium text-white active:opacity-80"
    >
      {pending ? (
        <>
          <span aria-hidden className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" />
          ログイン中…
        </>
      ) : (
        "ログイン"
      )}
    </button>
  );
}
