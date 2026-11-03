import Link from "next/link";
import { redirect } from "next/navigation";
import { groupByOrderMonth } from "@/lib/delivered";
import type { ParcelRow } from "@/lib/match";
import { readAll } from "@/lib/supabase/read-all";
import { createClient, getUser } from "@/lib/supabase/server";
import { ParcelCard } from "../parcel-card";

export const metadata = { title: "キャンセルした荷物" };

export default async function CancelledPage() {
  const user = await getUser();
  if (!user) redirect("/login");
  const supabase = await createClient();
  let parcels: ParcelRow[] | null = null;
  try {
    parcels = await readAll<ParcelRow>(() =>
      supabase
        .from("parcels")
        .select("*", { count: "exact" })
        .eq("user_id", user.id)
        .eq("status", "cancelled")
        .order("ordered_at", { ascending: false, nullsFirst: false }),
    );
  } catch (err) {
    console.error("cancelled page:", err instanceof Error ? err.message : err);
  }

  return (
    <div className="flex flex-col gap-6">
      <Link href="/app" className="text-sm text-neutral-500">
        ‹ 荷物
      </Link>
      <h1 className="flex items-baseline gap-2 text-lg font-bold">
        キャンセルした荷物
        {parcels ? <span className="text-sm font-normal text-neutral-500">{parcels.length.toLocaleString("ja-JP")}</span> : null}
      </h1>

      {parcels === null ? (
        <p className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-900">読み込めませんでした</p>
      ) : parcels.length === 0 ? (
        <p className="text-sm text-neutral-500">キャンセルした荷物はありません</p>
      ) : (
        groupByOrderMonth(parcels).map((g) => (
          <section key={g.label}>
            <h2 className="flex items-baseline gap-2 text-base font-bold">
              {g.label}
              <span className="text-sm font-normal text-neutral-500">{g.parcels.length}</span>
            </h2>
            <div className="mt-3 flex flex-col gap-3">
              {g.parcels.map((p) => (
                <ParcelCard key={p.id} parcel={p} />
              ))}
            </div>
          </section>
        ))
      )}
    </div>
  );
}
