import { describe, expect, it, vi } from "vitest";
import type { PrivateRecipient } from "@/lib/crypto/envelope";
import { read, SRC, withoutComments } from "./source-scan";
import path from "node:path";

/**
 * The opened key lives in this tab's memory only, and goes with it (src/lib/crypto/tab-key.ts):
 *  - one key, for the user it was opened for: another account in the tab gets nothing;
 *  - nothing is written to storage, and nothing but the opened key is kept;
 *  - the logout is a native POST to /auth/signout, answered with a redirect: a new page, so the
 *    tab's memory goes with the old one (a reload does the same); the press forgets the key first,
 *    for a browser that keeps the old page in its back/forward cache (leave-forgets-key.test.ts).
 * A sign-in and a reset forget it before anything else: password-flows.test.ts.
 */

// The store as React reads it during a render: the snapshot of the moment.
vi.mock("react", () => ({ useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot() }));
const signedOut = vi.hoisted(() => ({ calls: 0, options: [] as unknown[] }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: {
      getUser: async () => ({ data: { user: { id: A } }, error: null }),
      signOut: async (options?: unknown) => {
        signedOut.calls++;
        signedOut.options.push(options);
        return { error: null };
      },
    },
  }),
}));

const tabKey = await import("@/lib/crypto/tab-key");
const { forgetTabKey, setTabKey, useTabKey } = tabKey;

const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";
const key = (keyId: string) => ({ keyId, privateKey: {} as CryptoKey, publicKey: new Uint8Array(65) }) as unknown as PrivateRecipient;

const source = (rel: string) => read(path.join(SRC, rel));

/**
 * What is wrong with the logout form of a source: it must post to /auth/signout itself (POST), and
 * nothing in the file may stop that or send it another way. An onSubmit that only forgets the key
 * leaves the POST to the browser.
 */
function logoutFormProblems(code: string): string[] {
  const source = withoutComments(code);
  const forms = source.match(/<form\b[^>]*\baction="\/auth\/signout"[^>]*>/g) ?? [];
  if (forms.length === 0) return ["no logout form"];
  const problems = forms.flatMap((form) => (/\smethod="post"/.test(form) ? [] : ["not POST"]));
  if (/preventDefault|fetch\(|sendBeacon|requestSubmit|router\./.test(source)) problems.push("sent in code");
  return problems;
}

describe("the key in this tab's memory", () => {
  it("is kept for the user it was opened for only, and forgotten", () => {
    const k = key("a".repeat(32));
    expect(useTabKey(A)).toBeNull();
    setTabKey(A, k);
    expect(useTabKey(A)).toBe(k);
    // Another account signed in in this tab (or another tab): nothing to open its mail with.
    expect(useTabKey(B)).toBeNull();
    setTabKey(B, key("b".repeat(32)));
    expect(useTabKey(A)).toBeNull();
    forgetTabKey();
    expect(useTabKey(B)).toBeNull();
  });

  it("keeps nothing but the opened key, in memory only", () => {
    expect(Object.keys(tabKey).sort()).toEqual(["forgetTabKey", "setTabKey", "useTabKey"]);
    const code = withoutComments(source("lib/crypto/tab-key.ts"));
    expect(code).not.toMatch(/localStorage|sessionStorage|indexedDB|document\.cookie|caches\.|postMessage|BroadcastChannel/);
    // No Server Action, no other module: it opens nothing itself.
    expect(code.match(/^import .*$/gm)).toEqual(['import { useSyncExternalStore } from "react";', 'import type { PrivateRecipient } from "./envelope";']);
  });
});

describe("the logout leaves the page", () => {
  it("設定's logout is a native POST to /auth/signout (LogoutForm, on a page drawn by the server)", () => {
    const page = source("app/app/settings/(list)/page.tsx");
    expect(/^\s*["']use client["']/.test(withoutComments(page))).toBe(false);
    expect(withoutComments(page)).toContain("<LogoutForm userId={user.id} />");
    expect(withoutComments(page)).not.toContain("/auth/signout");
    expect(logoutFormProblems(source("app/app/settings/logout-form.tsx"))).toEqual([]);
  });

  it("/auth/signout signs out and answers with a redirect to the top page (a new document)", async () => {
    const { POST } = await import("@/app/auth/signout/route");
    const data = new FormData();
    data.set("expectedUserId", A);
    const res = await POST(new Request("https://otodoke.app/auth/signout", { method: "POST", body: data }) as never);
    expect(signedOut.calls).toBe(1);
    // This device only: the default (global) scope would sign out every device of a shared account.
    expect(signedOut.options).toEqual([{ scope: "local" }]);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("https://otodoke.app/");
  });

  it("negative control: a logout sent in code, or by GET, is caught", () => {
    expect(logoutFormProblems('<form action="/auth/signout" method="post" onSubmit={(e) => { e.preventDefault(); fetch("/auth/signout"); }}>')).toEqual(["sent in code"]);
    expect(logoutFormProblems('<form action="/auth/signout">')).toEqual(["not POST"]);
    expect(logoutFormProblems("<button onClick={signOut}>ログアウト</button>")).toEqual(["no logout form"]);
    // Positive control: forgetting the key at the press leaves the POST to the browser.
    expect(logoutFormProblems('<form action="/auth/signout" method="post" onSubmit={() => forgetTabKey()}>')).toEqual([]);
  });
});
