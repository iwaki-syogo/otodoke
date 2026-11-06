"use client";

import { useEffect } from "react";
import { forgetTabKey } from "@/lib/crypto/tab-key";

/**
 * The Server Action's redirect is a navigation inside the tab, so the keys opened with the
 * passphrase (kept in this tab's memory, src/lib/crypto/tab-key.ts) would outlive the account.
 * Logging out loads a new page and forgets them; this page forgets them the same way.
 */
export function ForgetTabKey() {
  useEffect(() => {
    forgetTabKey();
  }, []);
  return null;
}
