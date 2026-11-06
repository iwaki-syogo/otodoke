import Link from "next/link";
import { Wordmark } from "@/components/wordmark";
import { SignupForm } from "./signup-form";

export const metadata = { title: "アカウントを作る" };

/**
 * /signup: a new account with the address and the password (password-v1). Supabase mails the
 * confirmation link; after it, the person signs in with the password and the key is made then.
 * Those who used to sign in by a mail's link have an account already: they set a password from
 * 「パスワードを忘れた」 (decision 7).
 */
export default function SignupPage() {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center px-4 py-10">
      <Link href="/" className="mb-8 text-sm text-neutral-500">
        ← <Wordmark className="text-lg" />
      </Link>
      <h1 className="text-2xl font-bold">アカウントを作る</h1>
      <SignupForm />
      <p className="mt-6 text-sm leading-6 text-neutral-600">
        前にメールのリンクでログインしていた方は、
        <Link href="/login/forgot" className="font-medium text-neutral-900 underline underline-offset-4">
          パスワードを忘れた
        </Link>
        からパスワードを決めてください。
      </p>
      <Link href="/login" className="mt-4 self-start text-sm text-neutral-600 underline underline-offset-4">
        ログイン
      </Link>
      <Link href="/privacy" className="mt-8 self-start text-xs text-neutral-500 underline underline-offset-4">
        プライバシーポリシー
      </Link>
    </main>
  );
}
