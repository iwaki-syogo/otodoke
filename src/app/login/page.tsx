import Link from "next/link";
import { Wordmark } from "@/components/wordmark";
import { loginErrorMessage } from "@/lib/login-errors";

type SearchParams = Promise<{ error?: string }>;

/**
 * /login. The login by a mail's link and code is gone from the web (password-v1); the form that
 * signs in with the password takes this page's place (the screens' part of the change). Until then
 * this page only shows the fixed words for ?error=, which /auth/confirm still sends here.
 */
export default async function LoginPage({ searchParams }: { searchParams: SearchParams }) {
  const { error } = await searchParams;
  // From the URL, which anyone can write: fixed wording for the code, never the raw text.
  const errorMessage = loginErrorMessage(error);
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center px-4 py-10">
      <Link href="/" className="mb-8 text-sm text-neutral-500">
        ← <Wordmark className="text-lg" />
      </Link>
      <h1 className="text-2xl font-bold">ログイン</h1>
      {errorMessage ? <div className="mt-6 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-900">{errorMessage}</div> : null}
      <Link href="/privacy" className="mt-8 self-start text-xs text-neutral-500 underline underline-offset-4">
        プライバシーポリシー
      </Link>
    </main>
  );
}
