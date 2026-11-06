import { Bone, CardBones, HeadingBones, SkeletonScreen } from "@/components/skeleton";
import { BonesForPath } from "./bones-for-path";
import { WelcomeBones } from "./welcome/loading";

/**
 * /app while it loads: the 「＋ 登録」 button's place, then sections of parcel cards. Only grey
 * blocks: this also stands in, for a moment, while another page under /app is on its way, except
 * on the way to the first-run guide, which gets its own frame (BonesForPath).
 */
export default function Loading() {
  return (
    <SkeletonScreen className="flex flex-col gap-8">
      <BonesForPath welcome={<WelcomeBones />}>
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
      </BonesForPath>
    </SkeletonScreen>
  );
}
