import Link from "next/link";
import { Bone, CardBones, HeadingBones, SkeletonScreen } from "@/components/skeleton";

/** 届いた荷物 while it loads: the search box and the three selects, then cards by month. */
export default function Loading() {
  return (
    <SkeletonScreen>
      <Link href="/app" className="text-sm text-neutral-500">
        ‹ 荷物
      </Link>
      <h1 className="flex items-baseline gap-2 text-lg font-bold">
        届いた荷物
        <Bone className="h-4 w-8 self-center" />
      </h1>
      <div className="flex flex-col gap-2">
        <Bone className="h-11 w-full rounded-lg" />
        <div className="grid grid-cols-2 gap-2">
          <Bone className="col-span-2 h-11 rounded-lg" />
          <Bone className="h-11 rounded-lg" />
          <Bone className="h-11 rounded-lg" />
        </div>
      </div>
      <section>
        <HeadingBones />
        <div className="mt-3">
          <CardBones count={3} />
        </div>
      </section>
    </SkeletonScreen>
  );
}
