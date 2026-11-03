"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { monthLabel } from "@/lib/format";
import { MONTH_MIN, monthHref, monthMax } from "@/lib/month-url";

/**
 * The month in a heading, as a button that opens the browser's own month picker (the wheels on
 * iPhone): a see-through <input type="month"> lies over the name. Where the browser has no
 * type=month the input is left out, and the page's ‹ › move the month.
 */
export function MonthPicker({ value, basePath, keep }: { value: string; basePath: string; keep?: Record<string, string | undefined> }) {
  const [pending, startTransition] = useTransition();
  const [picked, setPicked] = useState<string | null>(null);
  const [supported, setSupported] = useState(true);
  const inputRef = useRef<HTMLInputElement>(null);
  const router = useRouter();

  // A browser without type=month turns the input into a text box; known only once mounted.
  useEffect(() => {
    if (inputRef.current && inputRef.current.type !== "month") setSupported(false);
  }, []);

  // The one place a picked month is sent (if the wheels send a change mid-turn, send on blur here).
  const send = (month: string) => {
    if (!month) return;
    setPicked(month);
    startTransition(() => router.push(monthHref(basePath, month, keep)));
  };

  const shown = pending && picked ? picked : value;

  return (
    <span className="relative inline-flex items-center gap-1 rounded-lg px-2 py-1 active:bg-neutral-100">
      {monthLabel(shown)}
      {pending ? (
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
          min={MONTH_MIN}
          max={monthMax()}
          defaultValue={value}
          aria-label="月を選ぶ"
          onChange={(e) => send(e.target.value)}
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
