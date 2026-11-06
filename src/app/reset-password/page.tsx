import Link from "next/link";
import { Wordmark } from "@/components/wordmark";
import { checkFresh, isFresh, readCookieSession, type AmrEntry, type FreshCheck, type SessionRead } from "@/lib/auth-session";
import { createClient } from "@/lib/supabase/server";
import { LOGIN_MESSAGES } from "@/lib/login-errors";
import { RESET_LOSES_MAIL } from "@/lib/mail-notices";
import { ResetForm } from "./reset-form";

export const metadata = { title: "パスワードの再設定" };

/**
 * /reset-password (outside /auth/): where /auth/confirm sends a reset link it accepted. Only on a
 * session that link made in the last 15 minutes (auth-session.ts, `reset`) is the form shown, with
 * the account it is for and what a reset costs (decision 3). Any other visit gets the way to a new
 * mail instead, in words that fit it (notShownWords).
 */
export default async function ResetPasswordPage() {
  const read = await readCookieSession(await createClient());
  const check = checkFresh(read, "reset");
  const session = check.ok && check.session.email ? { email: check.session.email, userId: check.session.userId } : null;
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center px-4 py-10">
      <Link href="/" className="-mt-2 mb-6 py-2 text-sm text-neutral-500">
        <span aria-hidden="true">←</span> <Wordmark className="text-lg" />
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
          <p>{notShownWords(read, check)}</p>
          <Link href="/login/forgot" className="mt-3 inline-block rounded-lg bg-neutral-900 px-4 py-2 font-medium text-white">
            再設定のメールを送る
          </Link>
        </div>
      )}
    </main>
  );
}

/**
 * Whether the session's latest sign-in was a mail's token (a reset link, as far as it can be told:
 * auth-session.ts), however long ago. An entry is fresh for `reset` at its own time exactly when it
 * is one of those methods, so the list stays auth-session.ts's.
 */
function lastSignInWasMailLink(amr: AmrEntry[]): boolean {
  let latest: { method: string; at: number } | null = null;
  for (const e of amr) if (e.at !== null && (!latest || e.at > latest.at)) latest = { method: e.method, at: e.at };
  return latest !== null && isFresh([latest], "reset", latest.at);
}

/**
 * Why the form is not shown, in words: Supabase could not be asked; a reset link opened more than
 * 15 minutes ago (its time is up: a new mail); or no reset link at all, as when someone signed in
 * with the password opens this page (R3-PW-17: never told that a reset expired), or nobody is.
 */
function notShownWords(read: SessionRead, check: FreshCheck): string {
  if (read.state === "unknown") return LOGIN_MESSAGES.network;
  if (!check.ok && read.state === "signed_in" && lastSignInWasMailLink(read.session.amr)) return LOGIN_MESSAGES.reset_expired;
  return "メールのリンクから開いてください。";
}
