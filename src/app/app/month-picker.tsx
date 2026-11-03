"use client";

import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState, useTransition } from "react";
import { monthLabel } from "@/lib/format";
import { MONTH_MIN, monthHref, monthMax } from "@/lib/month-url";
import { useFilterScope } from "./spend/filter-link";

/**
 * iOS / iPadOS WebKit: its wheels send a change at each stop, so the month is held until the
 * picker closes. iPadOS asks as a Mac, told apart by its touch points. Android and desktops send
 * one change for one pick, so they move at once. With no user agent to read, a touch screen holds.
 */
const holdsUntilClosed = () => {
  if (typeof window === "undefined") return false;
  const nav = window.navigator as Navigator | undefined;
  if (!nav || typeof nav.userAgent !== "string") return typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches;
  const ua = nav.userAgent;
  return /iP(hone|ad|od)/.test(ua) || (/Macintosh/.test(ua) && (nav.maxTouchPoints ?? 0) > 1);
};

/**
 * The month in a heading, as a button that opens the browser's own month picker (the wheels on
 * iPhone): a see-through <input type="month"> lies over the name. Where the browser has no
 * type=month the input is left out, and the page's ‹ › move the month. Under a FilterScope it
 * shares the screen's one transition (and waits while any other move is on the way).
 * `min` / `max` come from the server, so the first render matches it.
 */
export function MonthPicker({
  value,
  basePath,
  keep,
  min = MONTH_MIN,
  max,
}: {
  value: string;
  basePath: string;
  keep?: Record<string, string | undefined>;
  min?: string;
  max?: string;
}) {
  const scope = useFilterScope();
  const [ownPending, startTransition] = useTransition();
  const router = useRouter();
  const key = useId();
  const [picked, setPicked] = useState<string | null>(null);
  const [supported, setSupported] = useState(true);
  // On iOS the month turned to, sent once when the picker closes: `held` for sending, `heldMonth`
  // for the name shown meanwhile.
  const [heldMonth, setHeldMonth] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const held = useRef<string | null>(null);

  // A browser without type=month turns the input into a text box; known only once mounted.
  useEffect(() => {
    if (inputRef.current && inputRef.current.type !== "month") setSupported(false);
  }, []);

  // Under a FilterScope the screen's one transition, else this picker's own.
  const pending = scope ? scope.pending : ownPending;
  // Whether the move on the way is the one this picker sent (its spinner and the picked name).
  const mine = scope ? scope.pending && scope.target === key : ownPending;

  // Another move on the way, or a change of the month shown, drops a held month: the name goes
  // back to the month shown, and nothing is sent for it later. The input is uncontrolled, so its
  // own value is put back too: the wheels open at the month shown again (and "done" there is not
  // a silent no-op). `key={value}` alone misses a move that keeps the month (only `?c=` changes).
  const otherMove = pending && !mine;
  const [heldFor, setHeldFor] = useState(value);
  const valueMoved = heldFor !== value;
  if (valueMoved) setHeldFor(value);
  if ((otherMove || valueMoved) && heldMonth !== null) setHeldMonth(null);
  useEffect(() => {
    if (!otherMove) return;
    held.current = null;
    if (inputRef.current) inputRef.current.value = value;
  }, [otherMove, value]);
  useEffect(() => {
    held.current = null;
    if (inputRef.current) inputRef.current.value = value;
  }, [value]);

  // The one place a picked month is sent.
  const send = (month: string) => {
    if (!month || month === value || pending) return;
    setPicked(month);
    const href = monthHref(basePath, month, keep);
    if (scope?.go) scope.go(href, key);
    else startTransition(() => router.push(href));
  };

  // Sends the held month, once: the first of blur / a tap elsewhere / the page hidden.
  const flush = () => {
    const month = held.current;
    held.current = null;
    setHeldMonth(null);
    if (month) send(month);
  };

  // iOS may close the wheels without a blur (a tap outside): while a month is held, a tap
  // anywhere but the picker, or leaving the page, sends it too. Off again once it is sent.
  useEffect(() => {
    if (heldMonth === null || typeof document === "undefined") return;
    const onDown = (e: Event) => {
      if (e.target !== inputRef.current) flush();
    };
    const onHide = () => {
      if (document.visibilityState === "hidden") flush();
    };
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("visibilitychange", onHide);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("visibilitychange", onHide);
    };
  });

  const shown = mine && picked ? picked : heldMonth !== null && !otherMove && !valueMoved ? heldMonth : value;

  return (
    <span className="relative inline-flex items-center gap-1 rounded-lg px-2 py-1 active:bg-neutral-100">
      {monthLabel(shown)}
      {mine ? (
        <span aria-hidden className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-neutral-300 border-t-neutral-700" />
      ) : supported ? (
        <span aria-hidden className="text-xs font-normal text-neutral-500">
          ▾
        </span>
      ) : null}
      {supported ? (
        <input
          key={value}
          ref={inputRef}
          type="month"
          min={min}
          max={max ?? monthMax()}
          defaultValue={value}
          disabled={pending}
          aria-label="月を選ぶ"
          onChange={(e) => {
            if (!holdsUntilClosed()) return send(e.target.value);
            held.current = e.target.value || null;
            setHeldMonth(held.current);
            // Reset to empty: nothing is held, and the wheels go back to the month shown.
            if (!held.current) e.target.value = value;
          }}
          onBlur={flush}
          onClick={(e) => {
            // Straight from the click, nothing awaited first: the browser needs the tap itself.
            try {
              e.currentTarget.showPicker();
            } catch {
              // Not allowed or not there (iPhone opens the wheels on the tap anyway).
            }
          }}
          className="absolute inset-0 h-full w-full cursor-pointer text-base opacity-0"
        />
      ) : null}
    </span>
  );
}
