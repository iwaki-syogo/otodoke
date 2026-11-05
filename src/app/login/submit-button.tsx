"use client";

import type { MouseEvent } from "react";
import { useFormStatus } from "react-dom";

/**
 * 「リンクを送る」 with a visible press: a spinner and 「送信中…」 while the form is being sent.
 *
 * Not `disabled` (a pressed button should look pressed, not greyed out). A second press while
 * sending is ignored instead: cancelling the click also cancels Enter in the address field, which
 * the browser turns into a click on this button. Without JavaScript this is a plain submit button.
 */
export function LoginSubmitButton() {
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
          送信中…
        </>
      ) : (
        "リンクを送る"
      )}
    </button>
  );
}
