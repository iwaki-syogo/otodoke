"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/** Not within this long of the last refresh when the tab comes back. */
export const MIN_GAP_MS = 10_000;
/** While the page is visible. */
export const POLL_MS = 20_000;
/** Stop polling this long after the last time the person came back (or the page opened). */
export const ACTIVE_MS = 5 * 60_000;

/**
 * Drawn only while Gmail's approval link has not come (and reading it did not fail): refreshes the server
 * data so the yellow approval card appears without a manual reload. router.refresh() keeps client state.
 * Coming back to the tab refreshes once (not within 10 s of the last refresh); a visible page refreshes
 * every 20 s, and stops 5 minutes after the last return until the next one. A window focus, a pointer press or a
 * key press also counts as a return (focus refreshes like the tab coming back; the others only restart polling). Draws nothing. When the link
 * comes, the server stops drawing this, which unmounts it.
 */
export function RefreshUntilApproval() {
  const router = useRouter();
  useEffect(() => {
    let lastRefresh = Date.now();
    let activeSince = Date.now();
    let timer: ReturnType<typeof setInterval> | null = null;

    const refresh = () => {
      lastRefresh = Date.now();
      router.refresh();
    };
    const stop = () => {
      if (timer !== null) clearInterval(timer);
      timer = null;
    };
    const tick = () => {
      if (document.visibilityState !== "visible") return;
      if (Date.now() - activeSince >= ACTIVE_MS) {
        stop();
        return;
      }
      refresh();
    };
    const start = () => {
      stop();
      timer = setInterval(tick, POLL_MS);
    };
    const onVisibility = () => {
      if (document.visibilityState !== "visible") {
        stop();
        return;
      }
      activeSince = Date.now();
      if (Date.now() - lastRefresh >= MIN_GAP_MS) refresh();
      start();
    };

    // Gmail and Otodoke side by side on a PC: the tab stays "visible", so focus / pointer / key also count as coming back.
    const resume = () => {
      if (document.visibilityState !== "visible") return;
      activeSince = Date.now();
      if (timer === null) start();
    };
    const onFocus = () => {
      resume();
      if (document.visibilityState === "visible" && Date.now() - lastRefresh >= MIN_GAP_MS) refresh();
    };

    if (document.visibilityState === "visible") start();
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", onFocus);
    document.addEventListener("pointerdown", resume);
    document.addEventListener("keydown", resume);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("pointerdown", resume);
      document.removeEventListener("keydown", resume);
    };
  }, [router]);
  return null;
}
