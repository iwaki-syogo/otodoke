import type { Metadata } from "next";
import Link from "next/link";
import { Wordmark } from "@/components/wordmark";
import { ForgetTabKey } from "./forget-tab-key";

// Prerendered (○ in `next build`). Next renders the root not-found with every page as its
// fallback, so a root 404 that reads the request makes this page per request too: it did while
// src/app/not-found.tsx read the session. That 404 reads nothing now (review R3-6); the line stays
// so this page stays static if it ever does again. This page reads nothing from the request, and
// that fallback is never shown here.
export const dynamic = "force-static";

export const metadata: Metadata = { title: "アカウントを削除しました", robots: { index: false } };

/**
 * Where 設定「アカウントを削除」 ends (src/lib/account-deletion.ts ACCOUNT_DELETED_PATH). Outside
 * /app, so it opens without a session: the account and its sessions are gone by now. Reads nothing.
 */
export default function AccountDeletedPage() {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center px-4 py-10">
      <ForgetTabKey />
      <Link href="/" className="-mt-2 mb-6 py-2 text-sm text-neutral-500">
        <span aria-hidden="true">←</span> <Wordmark className="text-lg" />
      </Link>
      <h1 className="text-2xl font-bold">アカウントを削除しました</h1>
      <p className="mt-2 text-sm leading-6 text-neutral-600">ご利用ありがとうございました。Gmail などで設定した自動転送も、忘れずに外してください。</p>
      <Link href="/login" className="mt-8 inline-flex w-full items-center justify-center rounded-xl bg-neutral-900 px-5 py-4 text-base font-medium text-white active:opacity-80">
        ログイン画面へ
      </Link>
      <Link href="/privacy" className="mt-6 self-center text-xs text-neutral-500 underline underline-offset-4">
        プライバシーポリシー
      </Link>
    </main>
  );
}
