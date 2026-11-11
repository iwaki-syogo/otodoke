"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, useTransition, type ReactNode } from "react";
import { PendingButton, usePendingAction } from "@/components/pending-button";
import { Spinner } from "@/components/spinner";
import { markDelivered, restoreStatuses } from "./parcel-actions";

type Marked = { id: string; status: string; received_at: string | null }[];
interface Toast {
  text: string;
  undo: Marked | null;
}

const ToastContext = createContext<(t: Toast) => void>(() => {});

/** What a press shows from the tap until the parcels are saved. */
const SAVING = "保存しています…";
const UNDOING = "戻しています…";

/**
 * Holds the "受け取り済みにしました / 元に戻す" notice. It lives above the list because a marked
 * parcel moves to another page, and the card that was swiped is gone by then.
 */
export function DeliveredToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<Toast | null>(null);
  const { pending, run } = usePendingAction();
  const [failed, setFailed] = useState(false);

  // Closes after a while, but never while 元に戻す is on the way: its answer must be seen.
  useEffect(() => {
    if (!toast || pending) return;
    const timer = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(timer);
  }, [toast, pending]);

  const undo = () => {
    const items = toast?.undo;
    if (!items) return;
    run(async () => {
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
            <PendingButton pending={pending} pendingLabel={UNDOING} tone="light" onClick={undo} className="inline-flex shrink-0 items-center gap-1.5 font-bold text-emerald-300">
              元に戻す
            </PendingButton>
          ) : null}
        </div>
      ) : null}
    </ToastContext.Provider>
  );
}

const REVEAL = 96;
const COMMIT = 120;

/** Swipe a card to the left to say the parcel is received (受け取った). Vertical scrolling is left alone. */
export function SwipeToDeliver({ id, status, receivedAt = null, children }: { id: string; status: string; receivedAt?: string | null; children: ReactNode }) {
  const showToast = useContext(ToastContext);
  const [dx, setDx] = useState(0);
  const [state, setState] = useState<"idle" | "dragging" | "saving" | "error">("idle");
  const start = useRef<{ x: number; y: number; horizontal: boolean | null } | null>(null);
  const moved = useRef(false);
  // Set before anything is awaited: a second swipe or tap meanwhile saves nothing more.
  const saving = useRef(false);
  const [, startTransition] = useTransition();

  const commit = useCallback(() => {
    if (saving.current) return;
    saving.current = true;
    setState("saving");
    setDx(-COMMIT * 3);
    startTransition(async () => {
      try {
        // 0: nothing was saved (signed out, or the parcel was cancelled meanwhile). Not received.
        if ((await markDelivered([id])) === 0) throw new Error("nothing saved");
        showToast({ text: "受け取り済みにしました", undo: [{ id, status, received_at: receivedAt }] });
      } catch {
        saving.current = false;
        setState("error");
        setDx(0);
      }
    });
  }, [id, status, receivedAt, showToast]);

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
        <button
          type="button"
          onClick={commit}
          aria-busy={state === "saving" || undefined}
          aria-disabled={state === "saving" || undefined}
          className={`flex w-full items-center justify-end gap-2 ${state === "saving" ? "pointer-events-none" : ""}`}
        >
          {state === "saving" ? (
            <>
              <Spinner tone="light" />
              {SAVING}
            </>
          ) : (
            "受け取った"
          )}
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

/** "Mark all as received" for the parcels waiting for a check, with a second tap to confirm. */
export function DeliverAll({ items }: { items: Marked }) {
  const showToast = useContext(ToastContext);
  const [step, setStep] = useState<"idle" | "confirm" | "error">("idle");
  const { pending, run } = usePendingAction();

  const save = () =>
    run(async () => {
      try {
        const n = await markDelivered(items.map((it) => it.id));
        // 0: nothing was saved (signed out, or all cancelled meanwhile).
        if (n === 0) {
          setStep("error");
          return;
        }
        setStep("idle");
        showToast({ text: "受け取り済みにしました", undo: items });
      } catch {
        setStep("error");
      }
    });

  if (step === "confirm" || pending) {
    return (
      <div className="flex gap-2">
        <PendingButton
          pending={pending}
          pendingLabel={SAVING}
          tone="light"
          onClick={save}
          className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-emerald-600 px-4 py-3 text-sm font-bold text-white"
        >
          {`${items.length} 件を受け取り済みにする`}
        </PendingButton>
        <button type="button" onClick={() => setStep("idle")} disabled={pending} className="rounded-xl border border-neutral-300 px-4 py-3 text-sm disabled:opacity-60">
          やめる
        </button>
      </div>
    );
  }
  return (
    <div>
      <button type="button" onClick={() => setStep("confirm")} className="w-full rounded-xl border border-emerald-600 px-4 py-3 text-sm font-bold text-emerald-700">
        すべて受け取り済みにする
      </button>
      {step === "error" ? <p className="mt-1 text-xs text-red-700">保存できませんでした。もう一度押してください。</p> : null}
    </div>
  );
}
