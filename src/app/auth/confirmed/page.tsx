import Link from "next/link";
import { CONFIRMED, CONFIRMED_LOGIN_PATH } from "@/lib/onboarding";

// Prerendered: it reads nothing from the request, the cookies or the database. It works in any
// browser (the one the link was opened in need not be the one that signed up).
export const dynamic = "force-static";

export const metadata = { title: CONFIRMED.title };

/**
 * Where a new account's confirmation link ends (POST /auth/confirm, onboarding screen 2): the
 * address is confirmed. The tab that signed up goes on by itself when it is shown again; here
 * 「この画面でログインする」 opens the login (its `confirmed` words, no next): after it the first-run guide
 * when that sign-in made the first key, else the parcel list.
 *
 * Anyone can open this URL: it says only that a confirmation went through, and the button is the
 * login, which asks for the password.
 */
export default function ConfirmedPage() {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center px-4 py-10">
      <h1 className="text-2xl font-bold">{CONFIRMED.title}</h1>
      <p className="mt-2 text-sm leading-6 text-neutral-600">{CONFIRMED.body}</p>
      <Link href={CONFIRMED_LOGIN_PATH} className="mt-6 flex w-full items-center justify-center rounded-xl border border-neutral-300 bg-white py-4 text-base font-medium text-neutral-900 active:bg-neutral-100">
        {CONFIRMED.logIn}
      </Link>
    </main>
  );
}
