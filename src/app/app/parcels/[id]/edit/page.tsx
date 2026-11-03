import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { todayJst } from "@/lib/format";
import { createClient } from "@/lib/supabase/server";
import { ManualForm } from "../../manual-form";

export const metadata = { title: "荷物を編集" };

type Params = Promise<{ id: string }>;

export default async function EditParcelPage({ params }: { params: Params }) {
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) notFound();
  const supabase = await createClient();
  const { data: parcel, error } = await supabase.from("parcels").select("*").eq("id", id).maybeSingle();
  if (error) throw new Error(`parcel lookup failed: ${error.message}`);
  // Only parcels typed in by hand are edited here; a mail parcel changes only its category.
  if (!parcel || parcel.source !== "manual") notFound();

  return (
    <div className="flex flex-col gap-6">
      <Link href={`/app/parcels/${parcel.id}`} className="text-sm text-neutral-500">
        ‹ 戻る
      </Link>
      <h1 className="text-xl font-bold">荷物を編集</h1>
      <ManualForm parcel={parcel} today={todayJst()} />
    </div>
  );
}
