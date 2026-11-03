"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition, type ReactNode } from "react";
import { SEARCH_MAX, deliveredHref, monthChoices, type deliveredFilterOptions } from "@/lib/delivered";

type Values = { q: string; s: string; c: string; m: string };
type Options = ReturnType<typeof deliveredFilterOptions>;

/**
 * The search box and the selects of the delivered page, wrapping the results the server drew.
 * Owns the one transition: from the tap until the new URL's page arrives the results are faint
 * with a spinner, and every further filter action waits (so no change is made on an old URL).
 * Given `count`, it draws the page's heading with it, faint with the results while pending.
 */
export function DeliveredFilter({ q, s, c, m, options, count, children }: Values & { options: Options; count?: number; children?: ReactNode }) {
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  const go = (values: Partial<Values>) => startTransition(() => router.push(deliveredHref(values)));

  return (
    <>
      {count === undefined ? null : <DeliveredHeading count={count} pending={pending} />}
      {/* Made anew when the URL changes, so the fields start from the URL's values. */}
      <Fields key={[q, s, c, m].join("\n")} initial={{ q, s, c, m }} options={options} pending={pending} go={go} />
      <div aria-busy={pending || undefined} className={pending ? "opacity-50" : undefined}>
        {children}
      </div>
    </>
  );
}

/** 「届いた荷物」 with the number found; the number is the old one until the new page arrives, so faint meanwhile. */
export function DeliveredHeading({ count, pending = false }: { count?: number; pending?: boolean }) {
  return (
    <h1 className="flex items-baseline gap-2 text-lg font-bold">
      届いた荷物
      {count === undefined ? null : (
        <span aria-busy={pending || undefined} className={`text-sm font-normal text-neutral-500 ${pending ? "opacity-50" : ""}`}>
          {count.toLocaleString("ja-JP")}
        </span>
      )}
    </h1>
  );
}

function Fields({ initial, options, pending, go }: { initial: Values; options: Options; pending: boolean; go: (v: Partial<Values>) => void }) {
  const [values, setValues] = useState(initial);
  const narrowed = Object.values(initial).some(Boolean);

  const pick = (name: "s" | "c" | "m", value: string) => {
    if (pending) return;
    const next = { ...values, [name]: value };
    setValues(next);
    go({ ...next, q: next.q.trim() });
  };

  const select = (name: "s" | "c" | "m", all: string, choices: Array<{ value: string; label: string }>) => (
    <select
      name={name}
      value={values[name]}
      disabled={pending}
      onChange={(e) => pick(name, e.target.value)}
      aria-label={all}
      className="w-full min-w-0 truncate rounded-lg border border-neutral-300 bg-white px-2 py-2 text-base disabled:opacity-60"
    >
      <option value="">{all}</option>
      {choices.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );

  return (
    <form
      action="/app/delivered"
      method="get"
      role="search"
      onSubmit={(e) => {
        e.preventDefault();
        if (pending) return;
        go({ ...values, q: values.q.trim() });
      }}
      className="flex flex-col gap-2"
    >
      <div className="flex items-center gap-2">
        <input
          type="search"
          name="q"
          enterKeyHint="search"
          maxLength={SEARCH_MAX}
          value={values.q}
          // Read-only while a move is on the way: what is typed then would be lost when it arrives.
          readOnly={pending}
          aria-disabled={pending || undefined}
          onChange={(e) => {
            if (!pending) setValues({ ...values, q: e.target.value });
          }}
          placeholder="品名・店名"
          aria-label="検索"
          className="min-w-0 flex-1 rounded-lg border border-neutral-300 bg-white px-3 py-2 text-base read-only:opacity-60"
        />
        {pending ? <Spinner /> : null}
        {narrowed ? (
          <Link
            href="/app/delivered"
            aria-disabled={pending || undefined}
            onClick={(e) => {
              e.preventDefault();
              if (pending) return;
              setValues({ q: "", s: "", c: "", m: "" });
              go({});
            }}
            className="shrink-0 rounded-lg px-2 py-2 text-sm text-neutral-500 underline underline-offset-4 aria-disabled:opacity-60"
          >
            クリア
          </Link>
        ) : null}
      </div>
      <div className="grid grid-cols-3 gap-2">
        {select("s", "すべての店", options.shops.map((v) => ({ value: v, label: v })))}
        {select("c", "すべての分類", options.categories)}
        {select("m", "すべての月", monthChoices(options.months, initial.m).map((v) => ({ value: v, label: monthName(v) })))}
      </div>
    </form>
  );
}

const monthName = (ym: string) => {
  const [y, m] = ym.split("-").map(Number);
  return `${y}年${m}月`;
};

function Spinner() {
  return <span aria-hidden className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-neutral-300 border-t-neutral-700" />;
}
