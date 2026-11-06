import Link from "next/link";
import { Wordmark } from "@/components/wordmark";
import { RESET_LOSES_MAIL } from "@/lib/mail-notices";
import { ForgotForm } from "./forgot-form";

export const metadata = { title: "パスワードの再設定" };

/**
 * /login/forgot: the reset mail. Its link opens /reset-password (through /auth/confirm), where
 * the new password is set and a new key made: mail sealed before can no longer be opened, which
 * this page says before anything is sent (decision 3).
 */
export default function ForgotPage() {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center px-4 py-10">
      <Link href="/" className="mb-8 text-sm text-neutral-500">
        ← <Wordmark className="text-lg" />
      </Link>
      <h1 className="text-2xl font-bold">パスワードの再設定</h1>
      <p className="mt-4 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm leading-6 text-amber-950">{RESET_LOSES_MAIL}</p>
      <ForgotForm />
      <Link href="/login" className="mt-6 self-start text-sm text-neutral-600 underline underline-offset-4">
        ログイン
      </Link>
      <Link href="/privacy" className="mt-8 self-start text-xs text-neutral-500 underline underline-offset-4">
        プライバシーポリシー
      </Link>
    </main>
  );
}
