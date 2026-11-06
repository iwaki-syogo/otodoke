import { Bone, SkeletonScreen } from "@/components/skeleton";

const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

/** The calendar while it loads: the month heading, the grid of days and the days ahead. */
export default function Loading() {
  return (
    <SkeletonScreen>
      <header className="flex items-center justify-between">
        <span className="px-3 py-2 text-sm text-neutral-400">‹ 前月</span>
        <Bone className="h-6 w-28" />
        <span className="px-3 py-2 text-sm text-neutral-400">翌月 ›</span>
      </header>

      <div className="rounded-2xl border border-neutral-200 bg-white p-2">
        <div className="grid grid-cols-7 text-center text-[11px] text-neutral-500">
          {WEEKDAYS.map((w, i) => (
            <div key={w} className={`py-1 ${i === 0 ? "text-red-600" : i === 6 ? "text-sky-700" : ""}`}>
              {w}
            </div>
          ))}
        </div>
        <div className="grid grid-cols-7 gap-y-1">
          {Array.from({ length: 35 }, (_, i) => (
            <div key={i} className="flex min-h-16 flex-col items-center px-0.5 py-1">
              <Bone className="h-6 w-6 rounded-full" />
            </div>
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-5">
        {[2, 1].map((n, i) => (
          <div key={i}>
            <Bone className="h-4 w-24" />
            <div className="mt-2 flex flex-col gap-2">
              {Array.from({ length: n }, (_, j) => (
                <div key={j} className="flex items-start gap-3 rounded-xl border border-neutral-200 bg-white p-3">
                  <Bone className="h-4 w-20 shrink-0" />
                  <div className="min-w-0 flex-1">
                    <Bone className="h-3 w-16" />
                    <Bone className="mt-2 h-4 w-3/4" />
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </SkeletonScreen>
  );
}
