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
        <div className="divide-y divide-neutral-100 overflow-hidden rounded-2xl border border-neutral-200 bg-white">
          <Bone className="m-4 h-4 w-40" />
          <Bone className="m-4 h-4 w-32" />
        </div>
      </div>
    </SkeletonScreen>
  );
}
