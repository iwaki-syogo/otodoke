import Link from "next/link";
import { redirect } from "next/navigation";
import { deliveredFilterOptions, filterDelivered, groupByOrderMonth, itemNamesByParcel, searchWord } from "@/lib/delivered";
import type { ParcelRow } from "@/lib/match";
import { firstParam } from "@/lib/shop";
import { readAll } from "@/lib/supabase/read-all";
import { createClient, getUser } from "@/lib/supabase/server";
import { ParcelCard } from "../parcel-card";
import { DeliveredFilter } from "./filter-form";

export const metadata = { title: "届いた荷物" };

type Param = string | string[] | undefined;
type SearchParams = Promise<{ q?: Param; s?: Param; c?: Param; m?: Param }>;

export default async function DeliveredPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  // As given: filterDelivered trims it and cuts it to length.
  const q = firstParam(params.q) ?? "";
  const s = firstParam(params.s) ?? "";
  const c = firstParam(params.c) ?? "";
  const m = firstParam(params.m) ?? "";

  const user = await getUser();
  if (!user) redirect("/login");
  const supabase = await createClient();
  let parcels: ParcelRow[] | null = null;
  let items: Array<{ parcel_id: string; name: string }> | null = null;
  try {
    // Every item is read rather than asked for by parcel id: a long id list breaks the URL and
    // the 1,000-row cap would drop items. Items only serve the search word, so with none they
    // are not read. Either read failing fails the page.
    [parcels, items] = await Promise.all([
      readAll<ParcelRow>(() =>
        supabase
          .from("parcels")
          .select("*", { count: "exact" })
          .eq("user_id", user.id)
          .eq("status", "delivered")
          .order("ordered_at", { ascending: false, nullsFirst: false }),
      ),
      searchWord(q)
        ? readAll<{ parcel_id: string; name: string }>(() => supabase.from("parcel_items").select("parcel_id,name", { count: "exact" }).eq("user_id", user.id))
        : Promise.resolve([]),
    ]);
  } catch (err) {
    parcels = null;
    console.error("delivered page:", err instanceof Error ? err.message : err);
  }

  const shown = parcels && items ? filterDelivered(parcels, itemNamesByParcel(items), { q, s, c, m }) : null;

  return (
    <div className="flex flex-col gap-6">
      <Link href="/app" className="text-sm text-neutral-500">
        ‹ 荷物
      </Link>
      <h1 className="flex items-baseline gap-2 text-lg font-bold">
        届いた荷物
        {shown ? <span className="text-sm font-normal text-neutral-500">{shown.length.toLocaleString("ja-JP")}</span> : null}
      </h1>

      {parcels === null || shown === null ? (
        <p className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-900">読み込めませんでした</p>
      ) : parcels.length === 0 ? (
        <p className="text-sm text-neutral-500">届いた荷物はありません</p>
      ) : (
        <DeliveredFilter q={searchWord(q)} s={s} c={c} m={m} options={deliveredFilterOptions(parcels)}>
          {shown.length === 0 ? (
            <p className="text-sm text-neutral-500">見つかりません</p>
          ) : (
            <div className="flex flex-col gap-6">
              {groupByOrderMonth(shown).map((g) => (
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
              ))}
            </div>
          )}
        </DeliveredFilter>
      )}
    </div>
  );
}
