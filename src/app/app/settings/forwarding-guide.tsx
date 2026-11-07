import { FoldCard, GuideCardBody, VideoCredit } from "@/components/forwarding-steps";
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
            <GuideCardBody guide={guide} />
          </FoldCard>
        ))}
      </div>
      <VideoCredit />
    </section>
  );
}
