import { Bone, SkeletonScreen } from "@/components/skeleton";
import { BackToSettings } from "../sub-page";

/** 読まなかったメール while it loads. */
export default function Loading() {
  return (
    <SkeletonScreen className="flex flex-col gap-2">
      <BackToSettings />
      <h1 className="text-xl font-bold">読まなかったメール</h1>
      <div className="mt-4 flex flex-col gap-8">
        <section>
          <Bone className="h-4 w-full" />
          <Bone className="mt-2 h-4 w-3/4" />
          <Bone className="mt-3 h-12 w-full rounded-2xl" />
        </section>
      </div>
    </SkeletonScreen>
  );
}
