import Link from "next/link";
import { connection } from "next/server";
import { todayJst } from "@/lib/format";
import { ManualForm } from "../manual-form";

export const metadata = { title: "荷物を登録" };

export default async function NewParcelPage() {
  // Today is worked out per request, not frozen at build time.
  await connection();
  return (
    <div className="flex flex-col gap-6">
      <Link href="/app" className="text-sm text-neutral-500">
        ‹ 荷物
      </Link>
      <h1 className="text-xl font-bold">荷物を登録</h1>
      <ManualForm parcel={null} today={todayJst()} />
    </div>
  );
}
