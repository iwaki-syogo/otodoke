import Link from "next/link";
import { Wordmark } from "@/components/wordmark";
import { freshCookieSession } from "@/lib/auth-session";
import { LOGIN_MESSAGES } from "@/lib/login-errors";
import { RESET_LOSES_MAIL } from "@/lib/mail-notices";
import { ResetForm } from "./reset-form";

export const metadata = { title: "パスワードの再設定" };

/**
 * /reset-password (outside /auth/): where /auth/confirm sends a reset link it accepted. Only on a
 * session that link made in the last 15 minutes (auth-session.ts, `reset`) is the form shown, with
 * the account it is for and what a reset costs (decision 3). Any other visit gets the way to a new
 * mail instead: a session that signed in with the password is not one, nor is no session.
 */
export default async function ResetPasswordPage() {
  const check = await freshCookieSession("reset");
  const session = check.ok && check.session.email ? { email: check.session.email, userId: check.session.userId } : null;
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center px-4 py-10">
      <Link href="/" className="mb-8 text-sm text-neutral-500">
        ← <Wordmark className="text-lg" />
      </Link>
      <h1 className="text-2xl font-bold">パスワードの再設定</h1>
      {session ? (
        <>
          <p className="mt-4 text-sm text-neutral-600">
            このアカウント: <span className="break-all font-medium text-neutral-900">{session.email}</span>
          </p>
          <p className="mt-4 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm leading-6 text-amber-950">{RESET_LOSES_MAIL}</p>
          <ResetForm email={session.email} userId={session.userId} />
        </>
      ) : (
        <div className="mt-6 rounded-lg border border-neutral-200 bg-white p-4 text-sm leading-6">
          <p>{!check.ok && check.reason === "stale" ? LOGIN_MESSAGES.reset_expired : !check.ok && check.reason === "unknown" ? LOGIN_MESSAGES.network : "メールのリンクから開いてください。"}</p>
          <Link href="/login/forgot" className="mt-3 inline-block rounded-lg bg-neutral-900 px-4 py-2 font-medium text-white">
            再設定のメールを送る
          </Link>
        </div>
      )}
    </main>
  );
}
