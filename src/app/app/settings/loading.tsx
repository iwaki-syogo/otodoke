import { Bone, SkeletonScreen } from "@/components/skeleton";

/**
 * 設定 while it loads: the passphrase panel, the address, the guides and the sample. The page's
 * #demo section is scrolled to once the page is in (「サンプルで試す」 links there).
 */
export default function Loading() {
  return (
    <SkeletonScreen className="flex flex-col gap-8">
      <h1 className="text-xl font-bold">設定</h1>
      <Bone className="h-36 w-full rounded-2xl" />
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
      <section>
        <Bone className="h-5 w-36" />
        <Bone className="mt-2 h-4 w-full" />
      </section>
      <Bone className="h-32 w-full rounded-2xl" />
    </SkeletonScreen>
  );
}
