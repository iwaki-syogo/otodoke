"use client";

import { useEffect, useRef, type MouseEvent, type ReactNode } from "react";
import { useFormStatus } from "react-dom";

/*
 * The press of 設定's slow buttons, shown at once: a spinner and 「〜しています…」 from the press
 * until the result (src/components will have a shared one; this is 設定's until then).
 *
 * Never `disabled`: a form sent before the page's script runs is a plain POST, and a disabled
 * button drops out of it (its name=value with it). aria-disabled and pointer-events-none show that
 * it is busy instead, and a second press is cancelled by a ref set at the first one: a second press
 * can come before React has drawn the first.
 */

/** The spinner, in the button's own text colour. */
export const spinner = <span aria-hidden className="inline-block h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent" />;

/** The classes a busy button adds: looks pressed, takes no more presses. */
export const BUSY = "pointer-events-none opacity-60";

/** What a button shows: its label, or the spinner and the busy words. */
export function pressLabel(busy: boolean, label: ReactNode, busyLabel: ReactNode): ReactNode {
  return busy ? (
    <>
      {spinner}
      {busyLabel}
    </>
  ) : (
    label
  );
}

/**
 * The submit button of a form whose action is a Server Action: busy while the action runs (the
 * form's status), from the press on.
 */
export function PressButton({ label, busyLabel, className }: { label: string; busyLabel: string; className: string }) {
  const { pending } = useFormStatus();
  const pressed = useRef(false);
  // Open again once the action is over: a redirect back to this page keeps this button.
  useEffect(() => {
    if (!pending) pressed.current = false;
  }, [pending]);
  return (
    <button
      type="submit"
      aria-disabled={pending || undefined}
      aria-busy={pending || undefined}
      onClick={(event: MouseEvent<HTMLButtonElement>) => {
        if (pending || pressed.current) {
          event.preventDefault();
          return;
        }
        // A form the browser refuses is not sent: it must not lock the button.
        const form = event.currentTarget.form;
        if (form && !form.checkValidity()) return;
        pressed.current = true;
      }}
      className={`inline-flex items-center justify-center gap-2 ${className}${pending ? ` ${BUSY}` : ""}`}
    >
      {pressLabel(pending, label, busyLabel)}
    </button>
  );
}
