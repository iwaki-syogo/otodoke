"use client";

import { forgetTabKey } from "@/lib/crypto/tab-key";
import { ICONS, ROW_CLASS, RowIcon } from "./settings-row";

/**
 * 設定's logout: a native POST to /auth/signout, which signs out and answers with a redirect, so the
 * tab moves to another page. The opened key is forgotten at the press, before the page goes: a page
 * kept in the browser's back/forward cache would otherwise bring it back with 「戻る」 (R3-PW-13).
 * Nothing stops the POST (no preventDefault, no fetch): tab-key-memory.test.ts.
 * Drawn as a row of the account card.
 */
export function LogoutForm() {
  return (
    <form action="/auth/signout" method="post" onSubmit={() => forgetTabKey()}>
      <button type="submit" className={`${ROW_CLASS} active:bg-neutral-50`}>
        <RowIcon path={ICONS.logout} />
        <span className="min-w-0 flex-1">ログアウト</span>
      </button>
    </form>
  );
}
