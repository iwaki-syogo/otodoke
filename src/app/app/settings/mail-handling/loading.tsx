import { Bone, SkeletonScreen } from "@/components/skeleton";
import { BackToSettings } from "../sub-page";

/** あなたのメールの扱い while it loads. */
export default function Loading() {
  return (
    <SkeletonScreen className="flex flex-col gap-2">
      <BackToSettings />
      <h1 className="text-xl font-bold">あなたのメールの扱い</h1>
      <div className="mt-4 flex flex-col gap-8">
        <section>
          <Bone className="h-64 w-full rounded-2xl" />
          <Bone className="mt-3 h-4 w-48" />
        </section>
        <Bone className="h-4 w-32" />
      </div>
    </SkeletonScreen>
  );
}
