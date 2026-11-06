import { Bone, CardBones, HeadingBones, SkeletonScreen } from "@/components/skeleton";

/**
 * /app while it loads: the 「＋ 登録」 button's place, then sections of parcel cards. Only grey
 * blocks: this also stands in, for a moment, while another page under /app is on its way.
 */
export default function Loading() {
  return (
    <SkeletonScreen className="flex flex-col gap-8">
      <div className="flex justify-end">
        <Bone className="h-8 w-20 rounded-full" />
      </div>
      <section>
        <HeadingBones />
        <div className="mt-3">
          <CardBones count={2} />
        </div>
      </section>
      <section>
        <HeadingBones className="w-28" />
        <div className="mt-3">
          <CardBones count={3} />
        </div>
      </section>
    </SkeletonScreen>
  );
}
