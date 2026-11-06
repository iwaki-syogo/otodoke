import { Bone, SkeletonScreen } from "@/components/skeleton";
import { BackToSettings } from "../sub-page";

/** メールの転送 while it loads. */
export default function Loading() {
  return (
    <SkeletonScreen className="flex flex-col gap-2">
      <BackToSettings />
      <h1 className="text-xl font-bold">メールの転送</h1>
      <div className="mt-4 flex flex-col gap-8">
        <section>
          <Bone className="h-5 w-28" />
          <Bone className="mt-2 h-4 w-full" />
          <Bone className="mt-3 h-14 w-full rounded-2xl" />
        </section>
        <section>
          <Bone className="h-5 w-48" />
          <div className="mt-2 flex flex-col gap-2">
            <Bone className="h-12 w-full rounded-2xl" />
            <Bone className="h-12 w-full rounded-2xl" />
          </div>
        </section>
      </div>
    </SkeletonScreen>
  );
}
