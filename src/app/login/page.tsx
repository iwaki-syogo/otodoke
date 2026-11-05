import Link from "next/link";
import { Wordmark } from "@/components/wordmark";
import { sendMagicLink } from "./actions";

type SearchParams = Promise<{ sent?: string; error?: string; next?: string }>;

export default async function LoginPage({ searchParams }: { searchParams: SearchParams }) {
  const { sent, error, next } = await searchParams;
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center px-4 py-10">
      <Link href="/" className="mb-8 text-sm text-neutral-500">
        ← <Wordmark className="text-lg" />
      </Link>
      <h1 className="text-2xl font-bold">ログイン</h1>
      <p className="mt-2 text-sm text-neutral-600">メールアドレスにログイン用のリンクを送ります。パスワードはありません。</p>

      {sent ? (
        <div className="mt-6 rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900">
          <p className="font-medium">{sent} にリンクを送りました。</p>
          <p className="mt-1">届いたメールのリンクを開くとログインできます。届かないときは迷惑メールも見てください。</p>
        </div>
      ) : null}
      {error ? (
        <div className="mt-6 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-900">{error}</div>
      ) : null}

      <form action={sendMagicLink} className="mt-6 flex flex-col gap-3">
        <input type="hidden" name="next" value={next ?? "/app"} />
        <label className="text-sm font-medium" htmlFor="email">
          メールアドレス
        </label>
        <input
          id="email"
          name="email"
          type="email"
          required
          autoComplete="email"
          inputMode="email"
          placeholder="you@example.com"
          className="rounded-lg border border-neutral-300 px-3 py-3 text-base outline-none focus:border-neutral-900"
        />
        <button
          type="submit"
          className="rounded-lg bg-neutral-900 px-4 py-3 text-base font-medium text-white active:opacity-80"
        >
          リンクを送る
        </button>
      </form>
    </main>
  );
}
