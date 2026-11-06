import { Bone, SkeletonScreen } from "@/components/skeleton";
import { BackToSettings } from "../sub-page";

/** アカウントの削除 while it loads. */
export default function Loading() {
  return (
    <SkeletonScreen className="flex flex-col gap-2">
      <BackToSettings />
      <h1 className="text-xl font-bold">アカウントの削除</h1>
      <div className="mt-4 flex flex-col gap-8">
        <Bone className="h-10 w-40 rounded-lg" />
        <Bone className="h-4 w-56" />
        <Bone className="h-4 w-48" />
      </div>
    </SkeletonScreen>
  );
}
