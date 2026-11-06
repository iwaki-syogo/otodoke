import Link from "next/link";
import { Wordmark } from "@/components/wordmark";
import { LOGIN_MESSAGES, loginErrorMessage } from "@/lib/login-errors";
import { safeNextPath } from "@/lib/safe-next";
import { LoginForm } from "./login-form";

type SearchParams = Promise<{ error?: string; next?: string; confirmed?: string }>;

/**
 * /login: the address and the password (password-v1). The key that opens the stored mail is
 * opened, or made at the first sign-in, in the browser (LoginForm).
 *
 * From the URL, which anyone can write, only codes are read: ?error= (from /auth/confirm) and
 * ?confirmed=1 get fixed words, never text from the link; ?next= (from proxy.ts) goes through
 * safeNextPath.
 */
export default async function LoginPage({ searchParams }: { searchParams: SearchParams }) {
  const { error, next, confirmed } = await searchParams;
  const errorMessage = loginErrorMessage(error);
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center px-4 py-10">
      <Link href="/" className="mb-8 text-sm text-neutral-500">
        ← <Wordmark className="text-lg" />
      </Link>
      <h1 className="text-2xl font-bold">ログイン</h1>
      {confirmed === "1" ? <p className="mt-6 rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900">{LOGIN_MESSAGES.confirmed}</p> : null}
      {errorMessage ? <p className="mt-6 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-900">{errorMessage}</p> : null}
      <LoginForm next={safeNextPath(next ?? null)} />
      <div className="mt-6 flex flex-wrap gap-x-6 gap-y-2 text-sm">
        <Link href="/signup" className="font-medium text-neutral-900 underline underline-offset-4">
          アカウントを作る
        </Link>
        <Link href="/login/forgot" className="text-neutral-600 underline underline-offset-4">
          パスワードを忘れた
        </Link>
      </div>
      <Link href="/privacy" className="mt-8 self-start text-xs text-neutral-500 underline underline-offset-4">
        プライバシーポリシー
      </Link>
    </main>
  );
}
