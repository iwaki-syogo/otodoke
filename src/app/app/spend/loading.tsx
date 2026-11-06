import { Bone, SkeletonScreen } from "@/components/skeleton";

/** 支出 while it loads: the period switch, the month heading, the total, the breakdown and the orders. */
export default function Loading() {
  return (
    <SkeletonScreen>
      <div className="grid grid-cols-2 rounded-xl bg-neutral-100 p-1 text-sm">
        <span className="rounded-lg bg-white py-2 text-center font-bold text-neutral-400 shadow-sm">月</span>
        <span className="py-2 text-center text-neutral-400">全期間</span>
      </div>

      <header className="flex items-center justify-between">
        <span className="px-3 py-2 text-sm text-neutral-400">‹ 前月</span>
        <Bone className="h-6 w-28" />
        <span className="px-3 py-2 text-sm text-neutral-400">翌月 ›</span>
      </header>

      <section className="rounded-2xl border border-neutral-200 bg-white p-5">
        <Bone className="h-4 w-28" />
        <Bone className="mt-2 h-9 w-40" />
        <Bone className="mt-3 h-3 w-12" />
      </section>

      <section className="flex flex-col gap-3">
        <Bone className="h-5 w-20" />
        {[0, 1, 2].map((i) => (
          <div key={i} className="px-3">
            <Bone className="h-4 w-full" />
            <Bone className="mt-1.5 h-2 w-full rounded-full" />
          </div>
        ))}
      </section>

      <section>
        <Bone className="h-5 w-12" />
        <div className="mt-3 divide-y divide-neutral-200 rounded-2xl border border-neutral-200 bg-white">
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex items-start gap-3 p-4">
              <Bone className="h-3 w-12 shrink-0" />
              <div className="min-w-0 flex-1">
                <Bone className="h-3 w-16" />
                <Bone className="mt-2 h-4 w-3/4" />
              </div>
              <Bone className="h-4 w-14 shrink-0" />
            </div>
          ))}
        </div>
      </section>
    </SkeletonScreen>
  );
}
