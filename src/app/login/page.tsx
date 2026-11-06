import Link from "next/link";
import { Wordmark } from "@/components/wordmark";
import { loginErrorMessage, loginFormPath, sentAddress } from "@/lib/login-errors";
import { readRememberedLogin } from "@/lib/login-email-cookie";
import { isLoginAddress } from "@/lib/login-form";
import { safeNextPath } from "@/lib/safe-next";
import { sendMagicLink, verifyLoginCode } from "./actions";
import { CodeSubmitButton } from "./code-submit-button";
import { LoginSubmitButton } from "./submit-button";
import { TurnstileWidget } from "./turnstile-widget";

type SearchParams = Promise<{ sent?: string; error?: string; next?: string }>;

/**
 * /login: the address form; after a send (?sent=1), the "sent" screen with the code form.
 *
 * The address never comes from the URL (anyone can write one, and it stays in the history): it is
 * the one this browser typed, kept in a cookie by the send action (login-email-cookie.ts). With no
 * address there is no code form (Supabase checks a code with its address); the link still works.
 */
export default async function LoginPage({ searchParams }: { searchParams: SearchParams }) {
  const { sent, error, next } = await searchParams;
  // From the URL, which anyone can write: fixed wording for the code, never the raw text.
  const errorMessage = loginErrorMessage(error);
  const typed = (await readRememberedLogin())?.email ?? "";
  const codeAddress = sent && isLoginAddress(typed) ? typed : null;
  // Said back only when it is a plain ASCII address; the sentence goes without it otherwise.
  const sentTo = codeAddress ? sentAddress(codeAddress) : null;
  const target = safeNextPath(next ?? null);
  const errorBox = errorMessage ? <div className="mt-6 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-900">{errorMessage}</div> : null;
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center px-4 py-10">
      <Link href="/" className="mb-8 text-sm text-neutral-500">
        ← <Wordmark className="text-lg" />
      </Link>
      <h1 className="text-2xl font-bold">ログイン</h1>

      {sent ? (
        <>
          <div className="mt-6 rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900">
            <p className="font-medium">{sentTo ? `${sentTo} にメールを送りました。` : "メールを送りました。"}</p>
            <p className="mt-1">
              {codeAddress ? "メールのリンクを開くか、コードを入力してください。" : "メールのリンクを開くとログインできます。"}
              届かないときは迷惑メールも見てください。
            </p>
          </div>
          {errorBox}
          {codeAddress ? (
            <form action={verifyLoginCode} className="mt-6 flex flex-col gap-3">
              <input type="hidden" name="next" value={target} />
              <label className="text-sm font-medium" htmlFor="code">
                コード
              </label>
              {/* No pattern or maxLength: full-width digits, spaces and dashes are read on the server. */}
              <input
                id="code"
                name="code"
                type="text"
                required
                inputMode="numeric"
                autoComplete="one-time-code"
                className="rounded-lg border border-neutral-300 px-3 py-3 text-base tracking-widest outline-none focus:border-neutral-900"
              />
              <CodeSubmitButton />
            </form>
          ) : null}
          <Link href={loginFormPath(target)} className="mt-6 self-start text-sm text-neutral-600 underline underline-offset-4">
            メールを送り直す
          </Link>
        </>
      ) : (
        <>
          <p className="mt-2 text-sm text-neutral-600">メールアドレスにログイン用のリンクを送ります。パスワードはありません。</p>
          {errorBox}
          <form action={sendMagicLink} className="mt-6 flex flex-col gap-3">
            <input type="hidden" name="next" value={target} />
            <label className="text-sm font-medium" htmlFor="email">
              メールアドレス
            </label>
            {/* Keyed by the address: React 19 resets a form's fields after its action, and a field
                already on the page does not take a new defaultValue. */}
            <input
              key={`email:${typed}`}
              id="email"
              name="email"
              type="email"
              required
              defaultValue={typed}
              autoComplete="email"
              inputMode="email"
              placeholder="you@example.com"
              className="rounded-lg border border-neutral-300 px-3 py-3 text-base outline-none focus:border-neutral-900"
            />
            {/* captcha_missing already says what the widget's notice would: show one of them. */}
            <TurnstileWidget hideUnavailableNotice={error === "captcha_missing"} />
            <LoginSubmitButton />
          </form>
        </>
      )}
    </main>
  );
}
