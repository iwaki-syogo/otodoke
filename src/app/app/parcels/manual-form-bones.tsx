import { Bone } from "@/components/skeleton";

/** The fields of ManualForm in grey blocks, for the loading screens of 登録 and 編集. */
export function ManualFormBones() {
  return (
    <div className="flex flex-col gap-4">
      {Array.from({ length: 10 }, (_, i) => (
        <div key={i}>
          <Bone className="h-4 w-20" />
          <Bone className="mt-1 h-11 w-full rounded-xl" />
        </div>
      ))}
      <Bone className="h-11 w-full rounded-xl" />
    </div>
  );
}
