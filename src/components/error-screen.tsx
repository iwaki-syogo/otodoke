"use client";

import { useRef, useState } from "react";
import type { WayBack } from "./not-found-screen";
import { Spinner } from "./spinner";

/**
 * What error.tsx and global-error.tsx show: a short apology, 「もう一度読み込む」 and a way back.
 * Never the error itself (its message or stack): only fixed words reach the screen.
 *
 * `retry` is Next's: it fetches the segment again and draws it anew. From the press the button
 * spins until the page comes back, or until a new error takes this one's place (then it can be
 * pressed again). `back` is a plain link, so it loads the page afresh. null: no way back is
 * offered (the page that failed is the one it would go to).
 */
export function ErrorScreen({ error, retry, back }: { error: unknown; retry: () => void; back: WayBack | null }) {
  // The error a press is retrying, boxed so that a thrown null or undefined is told apart from none.
  const [retrying, setRetrying] = useState<{ error: unknown } | null>(null);
  const pressed = useRef<{ error: unknown } | null>(null);
  const pending = retrying !== null && retrying.error === error;

  return (
    <div className="flex flex-col items-center justify-center py-20 text-center">
      <h1 className="text-lg font-bold">申し訳ありません</h1>
      <p className="mt-2 text-sm leading-6 text-neutral-600">このページを表示できませんでした。</p>
      <button
        type="button"
        aria-busy={pending || undefined}
        aria-disabled={pending || undefined}
        onClick={() => {
          // Set before retry() starts: a second tap retries nothing more.
          if (pressed.current && pressed.current.error === error) return;
          pressed.current = { error };
          setRetrying({ error });
          retry();
        }}
        className={`mt-6 flex w-full items-center justify-center gap-2 rounded-xl bg-neutral-900 px-5 py-3 text-sm font-medium text-white active:opacity-80 ${pending ? "pointer-events-none opacity-70" : ""}`}
      >
        {pending ? (
          <>
            <Spinner tone="light" />
            読み込んでいます…
          </>
        ) : (
          "もう一度読み込む"
        )}
      </button>
      {back ? (
        <a href={back.href} className="mt-3 w-full rounded-xl border border-neutral-300 px-5 py-3 text-sm font-medium active:bg-neutral-100">
          {back.label}
        </a>
      ) : null}
    </div>
  );
}
