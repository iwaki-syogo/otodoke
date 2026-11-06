import { Bone, SkeletonScreen } from "@/components/skeleton";

/** 設定 while it loads: the two cards of rows (メール, アカウント). */
export default function Loading() {
  return (
    <SkeletonScreen className="flex flex-col gap-8">
      <h1 className="text-xl font-bold">設定</h1>
      <RowsBones label="w-10" rows={6} />
      <RowsBones label="w-16" rows={4} />
    </SkeletonScreen>
  );
}

function RowsBones({ label, rows }: { label: string; rows: number }) {
  return (
    <section className="flex flex-col gap-2">
      <Bone className={`ml-1 h-3 ${label}`} />
      <div className="divide-y divide-neutral-100 overflow-hidden rounded-2xl border border-neutral-200 bg-white">
        {Array.from({ length: rows }, (_, i) => (
          <div key={i} className="flex min-h-[52px] items-center gap-3 px-4">
            <Bone className="h-5 w-5 rounded-full" />
            <Bone className="h-4 w-40" />
          </div>
        ))}
      </div>
    </section>
  );
}
