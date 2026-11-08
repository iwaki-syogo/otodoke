import Image from "next/image";
import Link from "next/link";
import { Wordmark } from "@/components/wordmark";
import { getUser } from "@/lib/supabase/server";

const SCREENS = [
  { src: "/screens/list.webp", alt: "荷物の一覧。店も運送会社もまとめて、届く日と対面での受け取りが分かる" },
  { src: "/screens/calendar.webp", alt: "カレンダー。家にいる必要のある日に赤い印" },
  { src: "/screens/detail.webp", alt: "荷物の詳細。読み取った値の横に、元のメールの一文" },
];

export default async function Home() {
  const user = await getUser();
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col px-4 py-10">
      <header className="flex items-center justify-between">
        <Wordmark className="text-2xl" />
        {user ? (
          <Link href="/app" className="text-sm font-medium text-neutral-700 underline-offset-4 hover:underline">
            荷物を見る
          </Link>
        ) : null}
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
        {/* Signed out: the account first (the address and a password), then the login right under it. */}
        <Link
          href={user ? "/app" : "/signup"}
          className="mt-8 inline-flex w-full items-center justify-center rounded-xl bg-neutral-900 px-5 py-4 text-base font-medium text-white active:opacity-80"
        >
          {user ? "荷物を見る" : "アカウントを作る"}
        </Link>
        {user ? null : (
          <Link
            href="/login"
            className="mt-3 inline-flex w-full items-center justify-center rounded-xl border border-neutral-300 bg-white px-5 py-4 text-base font-medium text-neutral-900 active:opacity-80"
          >
            ログイン
          </Link>
        )}
      </section>

      <div className="mt-10">
        <div className="-mx-4 flex snap-x snap-mandatory gap-3 overflow-x-auto px-4">
          {SCREENS.map((s) => (
            <Image
              key={s.src}
              src={s.src}
              alt={s.alt}
              width={720}
              height={1415}
              sizes="(max-width: 448px) 62vw, 280px"
              className="h-auto w-[62%] shrink-0 snap-start rounded-2xl border border-neutral-200"
            />
          ))}
        </div>
        <a href="https://youtu.be/BLPMP_bYJ8c" target="_blank" rel="noopener noreferrer" className="mt-6 block">
          <Image src="/screens/video-thumb.jpg" alt="" width={960} height={540} sizes="(max-width: 448px) 100vw, 416px" className="h-auto w-full rounded-2xl" />
          <span className="mt-2 block text-sm text-neutral-600">デモ動画（3 分）</span>
        </a>
      </div>

      <section className="mt-14 grid gap-4">
        <Feature title="置き配できない荷物が分かる" body="対面受け取り・代引き・クール便など、家にいないと受け取れない荷物をメールの文面から見つけて、その日を強調します。" />
        <Feature title="どの店でも同じ画面" body="店ごとのアプリを開かなくても、注文中・発送済み・届いた、が 1 つの一覧とカレンダーに。" />
        <Feature title="根拠が見える" body="読み取った値には元メールの該当行を添えます。迷ったものは断定せず「要確認」と表示します。" />
      </section>

      <footer className="mt-auto pt-16 text-xs leading-5 text-neutral-500">
        Built with Claude: Japan 2026 の作品。メールの判定・読み取りに Claude を使っています。
        <br />
        <a href="https://github.com/iwaki-syogo/otodoke" className="inline-block py-2 underline underline-offset-4" target="_blank" rel="noopener noreferrer">
          GitHub
        </a>
        <Link href="/privacy" className="ml-4 inline-block py-2 underline underline-offset-4">
          プライバシーポリシー
        </Link>
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
