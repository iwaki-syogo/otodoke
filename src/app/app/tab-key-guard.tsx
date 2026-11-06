"use client";

import { useEffect } from "react";
import { forgetTabKey } from "@/lib/crypto/tab-key";

/**
 * Under /app: the opened key, and the mail opened with it, never come back from the browser's
 * back/forward cache (R3-PW-13: on a shared device, the next person presses 「戻る」 after the
 * logout). Leaving the page forgets the key (pagehide: also when the page goes into that cache),
 * and a page shown again from the cache is loaded anew (pageshow with `persisted`), so the server
 * decides what it shows: after a logout, the login.
 *
 * Moving between the app's pages inside the tab is not leaving it: the key stays.
 */
export function TabKeyGuard() {
  useEffect(() => {
    const onHide = () => forgetTabKey();
    const onShow = (e: PageTransitionEvent) => {
      if (e.persisted) window.location.reload();
    };
    window.addEventListener("pagehide", onHide);
    window.addEventListener("pageshow", onShow);
    return () => {
      window.removeEventListener("pagehide", onHide);
      window.removeEventListener("pageshow", onShow);
    };
  }, []);
  return null;
}
