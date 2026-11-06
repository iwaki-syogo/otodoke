"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/**
 * 設定 used to be one page with sections. A fragment never reaches the server, so the links that
 * still point at a section (the iOS app opens /app/settings#demo) are moved to the page that
 * holds it, here, once the list is in.
 */
const MOVED: Record<string, string> = {
  "#demo": "/app/settings/demo",
  "#gmail-approval": "/app/settings/forwarding#gmail-approval",
};

/** Where a fragment of the old 設定 page lives now; null for any other fragment. */
export function movedSection(hash: string): string | null {
  return Object.hasOwn(MOVED, hash) ? MOVED[hash] : null;
}

export function SettingsHashRedirect() {
  const router = useRouter();
  useEffect(() => {
    const to = movedSection(window.location.hash);
    if (to) router.replace(to);
  }, [router]);
  return null;
}
