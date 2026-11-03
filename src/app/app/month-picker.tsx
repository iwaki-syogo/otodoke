"use client";

import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState, useTransition } from "react";
import { monthLabel } from "@/lib/format";
import { MONTH_MIN, monthHref, monthMax } from "@/lib/month-url";
import { useFilterScope } from "./spend/filter-link";

/** A touch screen: the iPhone's wheels send a change at each stop, so the month goes on closing. */
const isTouch = () => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches;

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
  const inputRef = useRef<HTMLInputElement>(null);
  // On a touch screen the month turned to, sent when the picker closes.
  const held = useRef<string | null>(null);

  // A browser without type=month turns the input into a text box; known only once mounted.
  useEffect(() => {
    if (inputRef.current && inputRef.current.type !== "month") setSupported(false);
  }, []);

  // Under a FilterScope the screen's one transition, else this picker's own.
  const pending = scope ? scope.pending : ownPending;
  // Whether the move on the way is the one this picker sent (its spinner and the picked name).
  const mine = scope ? scope.pending && scope.target === key : ownPending;

  // The one place a picked month is sent.
  const send = (month: string) => {
    if (!month || month === value || pending) return;
    setPicked(month);
    const href = monthHref(basePath, month, keep);
    if (scope?.go) scope.go(href, key);
    else startTransition(() => router.push(href));
  };

  const shown = mine && picked ? picked : value;

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
            if (isTouch()) held.current = e.target.value;
            else send(e.target.value);
          }}
          onBlur={() => {
            const month = held.current;
            held.current = null;
            if (month) send(month);
          }}
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
