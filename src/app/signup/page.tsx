import Link from "next/link";
import { Wordmark } from "@/components/wordmark";
import { SignupForm } from "./signup-form";

export const metadata = { title: "アカウントを作る" };

/**
 * /signup: a new account with the address and the password (password-v1). Supabase mails the
 * confirmation link; after it, the person signs in with the password and the key is made then.
 * Those who used to sign in by a mail's link have an account already: they set a password from
 * 「パスワードを忘れた」 on /login (decision 7). This page has no word for them: it is the public
 * page of an app made new for the contest.
 */
export default function SignupPage() {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center px-4 py-10">
      <Link href="/" className="mb-8 text-sm text-neutral-500">
        ← <Wordmark className="text-lg" />
      </Link>
      <h1 className="text-2xl font-bold">アカウントを作る</h1>
      <SignupForm />
      <Link href="/privacy" className="mt-4 self-start text-sm text-neutral-600 underline underline-offset-4">
        プライバシーポリシー
      </Link>
      <Link href="/login" className="mt-4 self-start text-sm text-neutral-600 underline underline-offset-4">
        ログイン
      </Link>
    </main>
  );
}
