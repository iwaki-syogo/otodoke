"use client";

import { useEffect, useRef, useState, type MouseEvent } from "react";

/**
 * The button of the /auth/continue form, with a visible press: a spinner and `pendingLabel`
 * (「確認しています…」) from the press until the next page arrives.
 *
 * The link works once. A second press while the first is on its way would post the same link
 * again and could end on 「すでに使われたリンク」, so it is cancelled. The guard is a ref, which a
 * second press reads even before React has drawn the first one (a double tap can fire two clicks).
 * Not `disabled`: on a native form, a button disabled during its click does not post, so
 * `aria-disabled` and `pointer-events-none` show and stop the press instead.
 *
 * Coming back to this page after the post (the browser's back-forward cache) would show the
 * pressed button, which no longer does anything. The page is loaded again instead and shows what
 * is true now: signed in, or the button. Loading the page uses nothing; only the post does.
 *
 * Without JavaScript this is a plain submit button.
 */
export function ContinueButton({ label = "確認する", pendingLabel = "確認しています…", secondary = false }: { label?: string; pendingLabel?: string; secondary?: boolean }) {
  const [sending, setSending] = useState(false);
  // A ref, not state: the second click of a double tap comes before React has drawn the first.
  const pressed = useRef(false);

  useEffect(() => {
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted && pressed.current) window.location.reload();
    };
    window.addEventListener("pageshow", onPageShow);
    return () => window.removeEventListener("pageshow", onPageShow);
  }, []);

  const look = secondary ? "border border-neutral-300 text-sm text-neutral-700" : "bg-neutral-900 text-base font-medium text-white";
  const spinner = secondary ? "border-neutral-300 border-t-neutral-700" : "border-white/40 border-t-white";
  return (
    <button
      type="submit"
      aria-busy={sending || undefined}
      aria-disabled={sending || undefined}
      onClick={(event: MouseEvent<HTMLButtonElement>) => {
        if (pressed.current) {
          event.preventDefault();
          return;
        }
        pressed.current = true;
        setSending(true);
      }}
      className={`flex w-full items-center justify-center gap-2 rounded-lg px-4 py-3 active:opacity-80 ${look}${sending ? " pointer-events-none" : ""}`}
    >
      {sending ? (
        <>
          <span aria-hidden className={`inline-block h-4 w-4 animate-spin rounded-full border-2 ${spinner}`} />
          {pendingLabel}
        </>
      ) : (
        label
      )}
    </button>
  );
}
