import { Bone, SkeletonScreen } from "@/components/skeleton";
import { BackToSettings } from "../sub-page";

/** パスワードとメールの鍵 while it loads. */
export default function Loading() {
  return (
    <SkeletonScreen className="flex flex-col gap-2">
      <BackToSettings />
      <h1 className="text-xl font-bold">パスワードとメールの鍵</h1>
      <div className="mt-4 flex flex-col gap-8">
        <Bone className="h-36 w-full rounded-2xl" />
        <Bone className="h-5 w-28" />
        <Bone className="h-24 w-full rounded-2xl" />
      </div>
    </SkeletonScreen>
  );
}
