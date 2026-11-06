import Link from "next/link";
import { SkeletonScreen } from "@/components/skeleton";
import { ManualFormBones } from "../manual-form-bones";

/** 荷物を登録 while it loads. */
export default function Loading() {
  return (
    <SkeletonScreen>
      <Link href="/app" className="text-sm text-neutral-500">
        ‹ 荷物
      </Link>
      <h1 className="text-xl font-bold">荷物を登録</h1>
      <ManualFormBones />
    </SkeletonScreen>
  );
}
