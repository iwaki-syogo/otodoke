"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, useTransition, type ReactNode } from "react";
import { markDelivered, restoreStatuses } from "./parcel-actions";

type Marked = { id: string; status: string }[];
interface Toast {
  text: string;
  undo: Marked | null;
}

const ToastContext = createContext<(t: Toast) => void>(() => {});

/**
 * Holds the "届いたにしました / 元に戻す" notice. It lives above the list because a marked
 * parcel moves to another section, and the card that was swiped is gone by then.
 */
export function DeliveredToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<Toast | null>(null);
  const [pending, startTransition] = useTransition();
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(timer);
  }, [toast]);

  const undo = () => {
    const items = toast?.undo;
    if (!items) return;
    startTransition(async () => {
      try {
        await restoreStatuses(items);
        setToast(null);
      } catch {
        setFailed(true);
      }
    });
  };

  return (
    <ToastContext.Provider value={(t) => { setFailed(false); setToast(t); }}>
      {children}
      {toast ? (
        <div role="status" className="fixed inset-x-4 bottom-24 z-20 mx-auto flex max-w-md items-center justify-between gap-3 rounded-xl bg-neutral-900 px-4 py-3 text-sm text-white shadow-lg">
          <span>{failed ? "元に戻せませんでした" : toast.text}</span>
          {toast.undo && !failed ? (
            <button type="button" onClick={undo} disabled={pending} className="shrink-0 font-bold text-emerald-300 disabled:opacity-60">
              {pending ? "戻しています…" : "元に戻す"}
            </button>
          ) : null}
        </div>
      ) : null}
    </ToastContext.Provider>
  );
}

const REVEAL = 96;
const COMMIT = 120;

/** Swipe a card to the left to say the parcel has arrived. Vertical scrolling is left alone. */
export function SwipeToDeliver({ id, status, children }: { id: string; status: string; children: ReactNode }) {
  const showToast = useContext(ToastContext);
  const [dx, setDx] = useState(0);
  const [state, setState] = useState<"idle" | "dragging" | "saving" | "error">("idle");
  const start = useRef<{ x: number; y: number; horizontal: boolean | null } | null>(null);
  const moved = useRef(false);
  const [, startTransition] = useTransition();

  const commit = useCallback(() => {
    setState("saving");
    setDx(-COMMIT * 3);
    startTransition(async () => {
      try {
        await markDelivered([id]);
        showToast({ text: "届いたにしました", undo: [{ id, status }] });
      } catch {
        setState("error");
        setDx(0);
      }
    });
  }, [id, status, showToast]);

  const onPointerDown = (e: React.PointerEvent) => {
    if (state === "saving") return;
    start.current = { x: e.clientX, y: e.clientY, horizontal: null };
    moved.current = false;
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const s = start.current;
    if (!s) return;
    const mx = e.clientX - s.x;
    const my = e.clientY - s.y;
    if (s.horizontal === null && Math.hypot(mx, my) > 8) s.horizontal = Math.abs(mx) > Math.abs(my);
    if (!s.horizontal) return;
    moved.current = true;
    setState("dragging");
    setDx(Math.max(-COMMIT * 1.5, Math.min(0, mx)));
  };
  const onPointerUp = () => {
    const s = start.current;
    start.current = null;
    if (!s?.horizontal) return;
    if (dx <= -COMMIT) commit();
    else {
      setState("idle");
      setDx(dx <= -REVEAL / 2 ? -REVEAL : 0);
    }
  };

  return (
    <div className="relative overflow-hidden rounded-2xl">
      <div
        aria-hidden={dx === 0}
        className={`absolute inset-y-0 right-0 flex items-center bg-emerald-600 pr-4 pl-6 text-sm font-bold text-white ${dx === 0 && state !== "saving" ? "invisible" : ""}`}
        style={{ width: Math.max(REVEAL, -dx) }}
      >
        <button type="button" onClick={commit} disabled={state === "saving"} className="w-full text-right">
          {state === "saving" ? "保存中…" : "届いた"}
        </button>
      </div>
      <div
        className={`relative touch-pan-y ${state === "dragging" ? "" : "transition-transform duration-200"}`}
        style={{ transform: `translateX(${dx}px)` }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onClickCapture={(e) => {
          // A swipe ends with a click on the card's link; it must not open the parcel.
          if (moved.current || dx !== 0) {
            e.preventDefault();
            e.stopPropagation();
            moved.current = false;
            if (state !== "saving") setDx(0);
          }
        }}
      >
        {children}
      </div>
      {state === "error" ? <p className="mt-1 text-xs text-red-700">保存できませんでした。もう一度スワイプしてください。</p> : null}
    </div>
  );
}

/** "Mark all as arrived" for the parcels waiting for a check, with a second tap to confirm. */
export function DeliverAll({ items }: { items: Marked }) {
  const showToast = useContext(ToastContext);
  const [step, setStep] = useState<"idle" | "confirm" | "error">("idle");
  const [pending, startTransition] = useTransition();

  const run = () => {
    startTransition(async () => {
      try {
        const n = await markDelivered(items.map((it) => it.id));
        setStep("idle");
        showToast({ text: `${n} 件を受取済にしました`, undo: items });
      } catch {
        setStep("error");
      }
    });
  };

  if (step === "confirm" || pending) {
    return (
      <div className="flex gap-2">
        <button type="button" onClick={run} disabled={pending} className="flex-1 rounded-xl bg-emerald-600 px-4 py-3 text-sm font-bold text-white disabled:opacity-70">
          {pending ? "保存中…" : `${items.length} 件を受取済にする`}
        </button>
        <button type="button" onClick={() => setStep("idle")} disabled={pending} className="rounded-xl border border-neutral-300 px-4 py-3 text-sm">
          やめる
        </button>
      </div>
    );
  }
  return (
    <div>
      <button type="button" onClick={() => setStep("confirm")} className="w-full rounded-xl border border-emerald-600 px-4 py-3 text-sm font-bold text-emerald-700">
        すべて受取済にする
      </button>
      {step === "error" ? <p className="mt-1 text-xs text-red-700">保存できませんでした。もう一度押してください。</p> : null}
    </div>
  );
}
