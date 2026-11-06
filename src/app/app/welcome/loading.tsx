import { Bone, SkeletonScreen } from "@/components/skeleton";
import { WELCOME } from "@/lib/onboarding";

/** The first-run guide while it loads: its heading, then the address and the four cards in grey. */
export default function Loading() {
  return (
    <SkeletonScreen className="flex flex-col">
      <h1 className="text-2xl font-bold">{WELCOME.title}</h1>
      <Bone className="mt-2 h-4 w-48" />
      <section className="mt-8">
        <Bone className="h-5 w-48" />
        <Bone className="mt-3 h-14 w-full rounded-2xl" />
      </section>
      <section className="mt-8">
        <Bone className="h-5 w-40" />
        <div className="mt-3 flex flex-col gap-2">
          <Bone className="h-12 w-full rounded-2xl" />
          <Bone className="h-12 w-full rounded-2xl" />
          <Bone className="h-12 w-full rounded-2xl" />
          <Bone className="h-12 w-full rounded-2xl" />
        </div>
      </section>
    </SkeletonScreen>
  );
}
