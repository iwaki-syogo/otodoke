import Link from "next/link";
import { Wordmark } from "@/components/wordmark";
import { getUser } from "@/lib/supabase/server";

export default async function Home() {
  const user = await getUser();
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col px-4 py-10">
      <header className="flex items-center justify-between">
        <Wordmark className="text-2xl" />
        <Link href={user ? "/app" : "/login"} className="text-sm font-medium text-neutral-700 underline-offset-4 hover:underline">
          {user ? "荷物を見る" : "ログイン"}
        </Link>
      </header>

      <section className="mt-16">
        <h1 className="text-4xl font-bold leading-tight tracking-tight">
          荷物に、
          <br />
          予定を合わせない。
        </h1>
        <p className="mt-5 text-base leading-7 text-neutral-600">
          どの店で買った荷物も、いつ届くか・いつ家にいればいいかが 1 つのカレンダーに並びます。設定は最初の 1 回だけ。
        </p>
        <Link
          href={user ? "/app" : "/login"}
          className="mt-8 inline-flex w-full items-center justify-center rounded-xl bg-neutral-900 px-5 py-4 text-base font-medium text-white active:opacity-80"
        >
          {user ? "荷物を見る" : "メールアドレスで始める"}
        </Link>
      </section>

      <section className="mt-14 grid gap-4">
        <Feature title="置き配できない荷物が分かる" body="対面受け取り・代引き・クール便など、家にいないと受け取れない荷物をメールの文面から見つけて、その日を強調します。" />
        <Feature title="どの店でも同じ画面" body="店ごとのアプリを開かなくても、注文中・発送済み・届いた、が 1 つの一覧とカレンダーに。" />
        <Feature title="根拠が見える" body="読み取った値には元メールの該当行を添えます。迷ったものは断定せず「要確認」と表示します。" />
      </section>

      <footer className="mt-auto pt-16 text-xs leading-5 text-neutral-500">
        Built with Claude: Japan 2026 の作品。メールの判定・読み取りに Claude を使っています。
        <br />
        <a href="https://github.com/iwaki-syogo/otodoke" className="underline underline-offset-4" target="_blank" rel="noopener noreferrer">
          GitHub
        </a>
      </footer>
    </main>
  );
}

function Feature({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-2xl border border-neutral-200 bg-white p-5">
      <h2 className="text-base font-bold">{title}</h2>
      <p className="mt-2 text-sm leading-6 text-neutral-600">{body}</p>
    </div>
  );
}
