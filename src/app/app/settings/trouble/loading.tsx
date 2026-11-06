import { Bone, SkeletonScreen } from "@/components/skeleton";
import { BackToSettings } from "../sub-page";

/** うまく届かないとき while it loads. */
export default function Loading() {
  return (
    <SkeletonScreen className="flex flex-col gap-2">
      <BackToSettings />
      <h1 className="text-xl font-bold">うまく届かないとき</h1>
      <div className="mt-4 flex flex-col gap-8">
        <Bone className="h-28 w-full rounded-2xl" />
        <section>
          <Bone className="h-5 w-48" />
          <Bone className="mt-2 h-4 w-full" />
          <div className="mt-2 flex flex-col gap-2">
            <Bone className="h-12 w-full rounded-2xl" />
            <Bone className="h-12 w-full rounded-2xl" />
            <Bone className="h-12 w-full rounded-2xl" />
          </div>
        </section>
        <div className="divide-y divide-neutral-100 overflow-hidden rounded-2xl border border-neutral-200 bg-white">
          <div className="flex min-h-[52px] items-center gap-3 px-4">
            <Bone className="h-5 w-5 rounded-full" />
            <Bone className="h-4 w-40" />
          </div>
          <div className="flex min-h-[52px] items-center gap-3 px-4">
            <Bone className="h-5 w-5 rounded-full" />
            <Bone className="h-4 w-32" />
          </div>
        </div>
      </div>
    </SkeletonScreen>
  );
}
