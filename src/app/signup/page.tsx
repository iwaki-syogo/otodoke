import Link from "next/link";
import { Wordmark } from "@/components/wordmark";
import { PublicPageLinks } from "@/components/public-page-links";
import { SignupForm } from "./signup-form";

export const metadata = { title: "アカウントを作る" };

/**
 * /signup: a new account with the address and the password (password-v1). Supabase mails the
 * confirmation link; this tab then waits for it and signs in by itself (SignupForm), and the key is
 * made at that sign-in. The heading, the privacy policy and the way to log in are the form's: the
 * waiting screen has its own heading and none of the links.
 * Those who used to sign in by a mail's link have an account already: they set a password from
 * 「パスワードを忘れた」 on /login (decision 7). This page has no word for them: it is the public
 * page of an app made new for the contest.
 */
export default function SignupPage() {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center px-4 py-10">
      <Link href="/" className="-mt-2 mb-6 py-2 text-sm text-neutral-500">
        <span aria-hidden="true">←</span> <Wordmark className="text-lg" />
      </Link>
      <SignupForm />
      <PublicPageLinks includePrivacy={false} />
    </main>
  );
}
