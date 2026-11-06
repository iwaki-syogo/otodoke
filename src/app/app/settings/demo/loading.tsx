import { Bone, SkeletonScreen } from "@/components/skeleton";
import { BackToSettings } from "../sub-page";

/** サンプルで試す while it loads. */
export default function Loading() {
  return (
    <SkeletonScreen className="flex flex-col gap-2">
      <BackToSettings />
      <h1 className="text-xl font-bold">サンプルで試す</h1>
      <div className="mt-4 flex flex-col gap-8">
        <section className="rounded-2xl border border-dashed border-neutral-300 p-4">
          <Bone className="h-4 w-full" />
          <Bone className="mt-2 h-4 w-2/3" />
          <Bone className="mt-3 h-11 w-full rounded-xl" />
        </section>
      </div>
    </SkeletonScreen>
  );
}
