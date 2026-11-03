"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CATEGORIES, categoryColor, categoryLabel, isCategory, type Category } from "@/lib/category";
import { setCategory } from "./category-actions";

/**
 * A parcel's category as a chip; tapping it opens a sheet with the seven to pick from.
 * Used in the spend list and on the parcel page, so it takes only the id and the category.
 */
export function CategorySheet({ parcelId, category }: { parcelId: string; category: string | null }) {
  const current: Category | null = isCategory(category) ? category : null;
  const [open, setOpen] = useState(false);
  // The choice and the category it replaced: shown from the tap until new props arrive, so the
  // chip never falls back to the old value between the save and the refresh.
  const [picked, setPicked] = useState<{ value: Category; from: Category | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  const firstRef = useRef<HTMLButtonElement>(null);

  // Once the props move on, the choice has done its job; a later change elsewhere shows as is.
  if (picked && picked.from !== current) setPicked(null);
  const shown = picked && picked.from === current ? picked.value : current;

  useEffect(() => {
    if (!open) return;
    firstRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  function choose(c: Category) {
    setPicked({ value: c, from: current });
    setError(null);
    startTransition(async () => {
      try {
        const r = await setCategory(parcelId, c);
        if (!r.ok) {
          setPicked(null);
          setError(r.error);
          return;
        }
        setOpen(false);
        router.refresh();
      } catch {
        setPicked(null);
        setError("保存できませんでした");
      }
    });
  }

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setError(null);
          setOpen(true);
        }}
        aria-haspopup="dialog"
        aria-label={`分類: ${categoryLabel(shown)}（変える）`}
        className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border border-neutral-200 bg-white px-2.5 py-1 text-xs text-neutral-700 active:bg-neutral-100"
      >
        {pending ? <Spinner /> : <span aria-hidden className="h-2 w-2 rounded-full" style={{ backgroundColor: categoryColor(shown) }} />}
        {categoryLabel(shown)}
      </button>

      {open ? (
        <div className="fixed inset-0 z-30 flex items-end justify-center bg-black/40" onClick={() => !pending && setOpen(false)}>
          <div
            role="dialog"
            aria-modal="true"
            aria-label="分類を選ぶ"
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-md rounded-t-2xl bg-white p-4 pb-[calc(1rem+env(safe-area-inset-bottom))]"
          >
            <div className="flex items-center justify-between">
              <h2 className="text-base font-bold">分類</h2>
              <button type="button" onClick={() => setOpen(false)} className="rounded-lg px-3 py-2 text-sm text-neutral-500 active:bg-neutral-100">
                閉じる
              </button>
            </div>
            <ul className="mt-2 flex flex-col">
              {CATEGORIES.map((c, i) => (
                <li key={c}>
                  <button
                    ref={i === 0 ? firstRef : undefined}
                    type="button"
                    disabled={pending}
                    onClick={() => choose(c)}
                    aria-pressed={c === current}
                    className="flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left text-sm active:bg-neutral-100 disabled:opacity-60"
                  >
                    <span aria-hidden className="h-3 w-3 shrink-0 rounded-full" style={{ backgroundColor: categoryColor(c) }} />
                    <span className="flex-1">{categoryLabel(c)}</span>
                    {pending && picked?.value === c ? <Spinner /> : c === current ? <span className="text-neutral-900">✓</span> : null}
                  </button>
                </li>
              ))}
            </ul>
            {error ? (
              <p role="alert" className="mt-2 text-sm text-red-800">
                {error}
              </p>
            ) : null}
          </div>
        </div>
      ) : null}
    </>
  );
}

function Spinner() {
  return <span aria-hidden className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-neutral-300 border-t-neutral-700" />;
}
