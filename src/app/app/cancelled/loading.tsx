import Link from "next/link";
import { Bone, CardBones, HeadingBones, SkeletonScreen } from "@/components/skeleton";

/** キャンセルした荷物 while it loads: the heading, then cards by month. */
export default function Loading() {
  return (
    <SkeletonScreen>
      <Link href="/app" className="text-sm text-neutral-500">
        ‹ 荷物
      </Link>
      <h1 className="flex items-baseline gap-2 text-lg font-bold">
        キャンセルした荷物
        <Bone className="h-4 w-8 self-center" />
      </h1>
      <section>
        <HeadingBones />
        <div className="mt-3">
          <CardBones count={3} />
        </div>
      </section>
    </SkeletonScreen>
  );
}
