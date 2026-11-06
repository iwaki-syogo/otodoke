"use client";

import { useEffect, useRef, useState, useTransition, type ButtonHTMLAttributes, type MouseEvent, type ReactNode } from "react";
import { useFormStatus } from "react-dom";
import { Spinner } from "./spinner";

/*
 * Buttons that send a request show the press at once: a spinner and words such as
 * 「保存しています…」 from the press until the answer is drawn.
 *
 * They are never `disabled`: a disabled submit button drops its name=value from the POST, and a
 * pressed button should look pressed, not greyed out. While pending they are aria-disabled and
 * take no pointer events, and a press that still gets through (Enter in a field, a second tap
 * that iPhone Safari fires for one) is cancelled. The guard is a ref, set before anything is
 * awaited, so it holds before React has drawn the first press.
 *
 * `className` lays out the content; the spinner and the words sit side by side, so give it
 * something like `inline-flex items-center justify-center gap-2`.
 */

type Tone = "dark" | "light";
type Common = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "disabled" | "children" | "type"> & {
  /** Shown with the spinner while the request is on the way, e.g. 「保存しています…」. */
  pendingLabel: ReactNode;
  /** `light` for a dark button. */
  tone?: Tone;
  children: ReactNode;
};

/** After this long without the form starting to send, a press is allowed again. */
const RELEASE_MS = 3000;

function pendingProps(pending: boolean, className: string) {
  return {
    "aria-busy": pending || undefined,
    "aria-disabled": pending || undefined,
    className: pending ? `${className} pointer-events-none opacity-70` : className,
  };
}

function Content({ pending, pendingLabel, tone, children }: { pending: boolean; pendingLabel: ReactNode; tone: Tone; children: ReactNode }) {
  return pending ? (
    <>
      <Spinner tone={tone} />
      {pendingLabel}
    </>
  ) : (
    <>{children}</>
  );
}

/**
 * Runs one request at a time from a press, in a transition. `pending` stays true until the
 * request and the redraw it brings (a revalidated page) are done. `work` handles its own errors.
 */
export function usePendingAction(): { pending: boolean; run: (work: () => Promise<void>) => void } {
  const [pending, startTransition] = useTransition();
  const running = useRef(false);
  const run = (work: () => Promise<void>) => {
    if (running.current) return;
    running.current = true;
    startTransition(async () => {
      try {
        await work();
      } finally {
        running.current = false;
      }
    });
  };
  return { pending, run };
}

/**
 * A button whose press starts a request in code (not a form): pair it with usePendingAction.
 *
 *   const { pending, run } = usePendingAction();
 *   <PendingButton pending={pending} pendingLabel="保存しています…" onClick={() => run(async () => { ... })}>届いた</PendingButton>
 */
export function PendingButton({ pending, pendingLabel, tone = "dark", children, onClick, className = "", ...rest }: Common & { pending: boolean }) {
  return (
    <button
      {...rest}
      type="button"
      {...pendingProps(pending, className)}
      onClick={(e: MouseEvent<HTMLButtonElement>) => {
        if (pending) {
          e.preventDefault();
          return;
        }
        onClick?.(e);
      }}
    >
      <Content pending={pending} pendingLabel={pendingLabel} tone={tone}>
        {children}
      </Content>
    </button>
  );
}

/**
 * The submit button of a form, pending while the form is sent.
 *
 * - `<form action={serverAction}>`: pending while React sends it (useFormStatus).
 * - `<form action="/a/route" method="post">` with `leavesPage`: the browser leaves the page, so it
 *   is pending from the press until the page is gone (and reset if the page comes back from the
 *   back-forward cache).
 *
 * A press the browser will refuse (a required field left empty) is not held: the browser shows
 * its message and the button stays as it is.
 *
 *   <form action={loadDemo}><SubmitButton pendingLabel="読み込んでいます…" className="...">読み込む</SubmitButton></form>
 */
export function SubmitButton({ pendingLabel, tone = "dark", leavesPage = false, children, onClick, className = "", ...rest }: Common & { leavesPage?: boolean }) {
  const { pending: sending } = useFormStatus();
  const [leaving, setLeaving] = useState(false);
  const pending = sending || leaving;
  const sent = useRef(false);
  const started = useRef(false);

  // The press is released once the send it started is over (an answer drawn on this page).
  useEffect(() => {
    if (sending) started.current = true;
    else if (started.current) {
      started.current = false;
      sent.current = false;
    }
  }, [sending]);

  // Back to this page from the back-forward cache: it is not leaving any more.
  useEffect(() => {
    if (!leavesPage) return;
    const onShow = (e: PageTransitionEvent) => {
      if (!e.persisted) return;
      sent.current = false;
      setLeaving(false);
    };
    window.addEventListener("pageshow", onShow);
    return () => window.removeEventListener("pageshow", onShow);
  }, [leavesPage]);

  return (
    <button
      {...rest}
      type="submit"
      {...pendingProps(pending, className)}
      onClick={(e: MouseEvent<HTMLButtonElement>) => {
        if (pending || sent.current) {
          e.preventDefault();
          return;
        }
        onClick?.(e);
        if (e.defaultPrevented) return;
        const form = e.currentTarget.form;
        if (form && !form.checkValidity()) return;
        sent.current = true;
        if (leavesPage) setLeaving(true);
        else
          setTimeout(() => {
            // Nothing was sent after all (something else stopped the form): allow a press again.
            if (!started.current) sent.current = false;
          }, RELEASE_MS);
      }}
    >
      <Content pending={pending} pendingLabel={pendingLabel} tone={tone}>
        {children}
      </Content>
    </button>
  );
}
