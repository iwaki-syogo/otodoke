import Link from "next/link";
import { safeNextPath } from "@/lib/safe-next";

export const metadata = { title: "ログイン" };

type SearchParams = Promise<{ token_hash?: string; type?: string; next?: string }>;

export default async function ContinuePage({ searchParams }: { searchParams: SearchParams }) {
  const { token_hash: tokenHash, type, next } = await searchParams;
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center px-4 py-10">
      <h1 className="text-2xl font-bold">Otodoke にログインしますか？</h1>
      {tokenHash && type ? (
        <form action="/auth/confirm" method="post" className="mt-6">
          <input type="hidden" name="token_hash" value={tokenHash} />
          <input type="hidden" name="type" value={type} />
          <input type="hidden" name="next" value={safeNextPath(next ?? null)} />
          <button type="submit" className="w-full rounded-lg bg-neutral-900 px-4 py-3 text-base font-medium text-white active:opacity-80">
            ログインする
          </button>
        </form>
      ) : (
        <p className="mt-4 text-sm text-neutral-600">
          リンクが不完全です。
          <Link href="/login" className="underline underline-offset-4">
            もう一度リンクを送ってください。
          </Link>
        </p>
      )}
    </main>
  );
}
