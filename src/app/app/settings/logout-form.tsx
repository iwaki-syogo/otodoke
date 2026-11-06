"use client";

import { forgetTabKey } from "@/lib/crypto/tab-key";

/**
 * 設定's logout: a native POST to /auth/signout, which signs out and answers with a redirect, so the
 * tab moves to another page. The opened key is forgotten at the press, before the page goes: a page
 * kept in the browser's back/forward cache would otherwise bring it back with 「戻る」 (R3-PW-13).
 * Nothing stops the POST (no preventDefault, no fetch): tab-key-memory.test.ts.
 */
export function LogoutForm() {
  return (
    <form action="/auth/signout" method="post" onSubmit={() => forgetTabKey()}>
      <button type="submit" className="rounded-lg border border-neutral-300 px-4 py-2 text-sm">
        ログアウト
      </button>
    </form>
  );
}
