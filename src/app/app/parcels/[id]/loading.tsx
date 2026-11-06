import Link from "next/link";
import { Bone, SkeletonScreen } from "@/components/skeleton";

const ROWS = ["w-32", "w-24", "w-28", "w-24", "w-16", "w-20"];

/** A parcel while it loads: the name and badges, the facts, and the mail history. */
export default function Loading() {
  return (
    <SkeletonScreen>
      <Link href="/app" className="text-sm text-neutral-500">
        ‹ 荷物
      </Link>
      <header>
        <Bone className="h-4 w-24" />
        <Bone className="mt-2 h-6 w-full" />
        <Bone className="mt-1.5 h-6 w-2/3" />
        <div className="mt-3 flex gap-2">
          <Bone className="h-5 w-14 rounded-full" />
          <Bone className="h-5 w-20 rounded-full" />
        </div>
      </header>
      <section className="rounded-2xl border border-neutral-200 bg-white p-4">
        <div className="grid grid-cols-[6rem_1fr] gap-y-3">
          {ROWS.map((w, i) => (
            <div key={i} className="contents">
              <Bone className="h-4 w-16" />
              <Bone className={`h-4 ${w}`} />
            </div>
          ))}
        </div>
      </section>
      <section>
        <Bone className="h-5 w-28" />
        <div className="mt-2 flex flex-col gap-2">
          {[0, 1].map((i) => (
            <div key={i} className="rounded-2xl border border-neutral-200 bg-white p-3">
              <Bone className="h-3 w-24" />
              <Bone className="mt-2 h-4 w-3/4" />
              <Bone className="mt-1.5 h-3 w-1/2" />
            </div>
          ))}
        </div>
      </section>
    </SkeletonScreen>
  );
}
