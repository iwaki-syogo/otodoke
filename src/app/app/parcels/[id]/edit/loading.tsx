import { SkeletonScreen } from "@/components/skeleton";
import { ManualFormBones } from "../../manual-form-bones";

/** 荷物を編集 while it loads. 「‹ 戻る」 waits for the page: its link needs the parcel's id. */
export default function Loading() {
  return (
    <SkeletonScreen>
      <span className="text-sm text-neutral-400">‹ 戻る</span>
      <h1 className="text-xl font-bold">荷物を編集</h1>
      <ManualFormBones />
    </SkeletonScreen>
  );
}
