"use client";

import { useEffect, useRef, useState } from "react";
import type { TrackingLink } from "@/lib/carriers";

const LINK = "font-medium text-sky-700 underline underline-offset-4";

/**
 * Copies during the tap itself. The async Clipboard API is refused once the new tab has taken
 * focus, so the synchronous copy goes first and the API is only a fallback.
 */
function copyNow(text: string): boolean {
  const area = document.createElement("textarea");
  area.value = text;
  area.readOnly = true;
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.select();
  area.setSelectionRange(0, text.length);
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  area.remove();
  if (!ok) navigator.clipboard?.writeText(text).catch(() => {});
  return ok;
}

/** How long the "copied" note stays up before the carrier's page opens. */
const OPEN_AFTER_MS = 1000;

/**
 * Opens a page in a new tab. A tab opened after a delay can be blocked as a popup (iOS Safari
 * especially), so the page then opens in this tab instead. "noopener" is not passed because it
 * makes window.open return null every time; the opener is cut by hand.
 */
function openLater(url: string) {
  const w = window.open(url, "_blank");
  if (w) w.opener = null;
  else window.location.assign(url);
}

/**
 * For carriers that take no number from outside (Sagawa): copies the number during the tap,
 * says so on screen, then opens the carrier's page so the number can be pasted there.
 */
function CopyThenOpen({ url, number }: { url: string; number: string }) {
  const [note, setNote] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  function onTap() {
    if (note) return; // already on its way
    // Synchronous, inside the tap: the async Clipboard API fails once another tab has focus.
    const ok = copyNow(number);
    setNote(ok ? "追跡番号をコピーしました" : "追跡番号をコピーできませんでした");
    timer.current = setTimeout(() => {
      timer.current = null;
      openLater(url);
      setNote(null);
    }, OPEN_AFTER_MS);
  }

  return (
    <>
      {" "}
      <button type="button" onClick={onTap} disabled={note !== null} className={LINK}>
        追跡ページを開く
      </button>
      {note ? (
        <div role="status" className="fixed inset-x-4 bottom-24 z-20 mx-auto max-w-md rounded-xl bg-neutral-900 px-4 py-3 text-sm text-white shadow-lg">
          {note}
        </div>
      ) : null}
    </>
  );
}

/** Opens the carrier's tracking page with the number already in, as far as the carrier allows. */
export function TrackingButton({ link, number }: { link: TrackingLink; number: string }) {
  if (link.kind === "post") {
    return (
      <form method="post" action={link.url} target="_blank" className="inline">
        {Object.entries(link.fields).map(([name, value]) => (
          <input key={name} type="hidden" name={name} value={value} />
        ))}{" "}
        <button type="submit" className={LINK}>
          追跡ページを開く
        </button>
      </form>
    );
  }
  if (link.kind === "copy") return <CopyThenOpen url={link.url} number={number} />;
  return (
    <>
      {" "}
      <a href={link.url} target="_blank" rel="noopener noreferrer" className={LINK}>
        追跡ページを開く
      </a>
    </>
  );
}
