"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/**
 * Moves this tab on to `href` once drawn: for a form that has just opened the key that opens the
 * stored mail (src/lib/crypto/tab-key.ts keeps it in this tab's memory, which a new page load would
 * forget). Drawn only then, so the forms need no router before.
 */
export function LeaveFor({ href }: { href: string }) {
  const router = useRouter();
  useEffect(() => {
    router.replace(href);
  }, [router, href]);
  return null;
}
