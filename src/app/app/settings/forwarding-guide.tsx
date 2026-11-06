import Link from "next/link";
import { FoldCard, GuideGroups, TextLink } from "@/components/forwarding-steps";
import { FORWARDING_GUIDES } from "@/lib/forwarding-guide";

/** 「自動転送の設定は最初の 1 回だけ」: one fold per service, from the shared words in src/lib/forwarding-guide.ts. */
export function ForwardingGuides() {
  return (
    <section>
      <h2 className="text-base font-bold">自動転送の設定は最初の 1 回だけ</h2>
      <p className="mt-1 text-sm leading-6 text-neutral-600">店ごとの設定はいりません。新しい店で買っても、そのまま読み取ります。</p>
      <div className="mt-2 flex flex-col gap-2">
        {FORWARDING_GUIDES.map((guide) => (
          <FoldCard key={guide.id} title={guide.title}>
            {guide.addresses && <p className="text-xs text-neutral-500">{guide.addresses}</p>}
            {guide.time && <p className="mt-1 text-xs text-neutral-500">目安: {guide.time}</p>}
            {guide.intro && <p className="text-sm leading-6 text-neutral-600">{guide.intro}</p>}
            {guide.link && (
              <div className="mt-2">
                <TextLink href={guide.link.href} label={guide.link.label} />
                {guide.linkNote && <p className="text-xs text-neutral-500">{guide.linkNote}</p>}
              </div>
            )}
            <GuideGroups groups={guide.groups} />
            {guide.notes.map((note) => (
              <p key={note} className="mt-4 text-xs leading-5 text-neutral-500">
                {note}
              </p>
            ))}
          </FoldCard>
        ))}
      </div>
      <Link href="/guide/forwarding" className="mt-3 flex items-center justify-center rounded-xl border border-neutral-300 bg-white py-3 text-sm font-medium active:bg-neutral-100">
        くわしい手順を見る
      </Link>
    </section>
  );
}
