import { Bone, SkeletonScreen } from "@/components/skeleton";
import { BackToSettings } from "../sub-page";

/** あなたのメールの扱い while it loads. */
export default function Loading() {
  return (
    <SkeletonScreen className="flex flex-col gap-2">
      <BackToSettings />
      <h1 className="text-xl font-bold">あなたのメールの扱い</h1>
      <div className="mt-4 flex flex-col gap-8">
        <section className="flex flex-col gap-3 rounded-2xl border border-neutral-200 bg-white p-4">
          <Bone className="h-4 w-full" />
          <Bone className="h-4 w-5/6" />
          <Bone className="h-4 w-full" />
          <Bone className="h-4 w-2/3" />
        </section>
        {/* The privacy policy link under the list. */}
        <Bone className="-mt-6 h-4 w-32" />
      </div>
    </SkeletonScreen>
  );
}
