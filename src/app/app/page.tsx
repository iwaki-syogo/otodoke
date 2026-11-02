import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { addDays, todayJst } from "@/lib/format";
import type { ParcelRow } from "@/lib/match";
import { ParcelCard } from "./parcel-card";

export const metadata = { title: "荷物" };

export default async function ParcelsPage() {
  const supabase = await createClient();
  const { data } = await supabase
    .from("parcels")
    .select("*")
    .order("expected_date", { ascending: true, nullsFirst: false })
    .order("last_email_at", { ascending: false, nullsFirst: false });
  const parcels: ParcelRow[] = data ?? [];
  const today = todayJst();

  const incoming = parcels.filter((p) => ["shipped", "out_for_delivery", "attempted"].includes(p.status));
  const ordered = parcels.filter((p) => ["ordered", "unknown"].includes(p.status));
  const delivered = parcels
    .filter((p) => p.status === "delivered" && (p.last_email_at ?? "") >= addDays(today, -30))
    .sort((a, b) => (b.last_email_at ?? "").localeCompare(a.last_email_at ?? ""));
  const cancelled = parcels.filter((p) => p.status === "cancelled");
  const presenceSoon = incoming.filter((p) => p.requires_presence && p.expected_date && p.expected_date >= today);

  if (parcels.length === 0) return <EmptyState />;

  return (
    <div className="flex flex-col gap-8">
      {presenceSoon.length > 0 ? (
        <section className="rounded-2xl border border-red-200 bg-red-50 p-4">
          <h2 className="text-sm font-bold text-red-900">家にいる必要がある日</h2>
          <ul className="mt-2 flex flex-col gap-1 text-sm text-red-900">
            {presenceSoon.map((p) => (
              <li key={p.id}>
                <Link href={`/app/parcels/${p.id}`} className="underline underline-offset-4">
                  {p.expected_date ? `${p.expected_date.slice(5).replace("-", "/")} ` : ""}
                  {p.title ?? p.shop}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <Section title="もうすぐ届く" count={incoming.length} items={incoming} />
      <Section title="注文中" count={ordered.length} items={ordered} empty="注文中の荷物はありません" />
      <Section title="届いた（30 日）" count={delivered.length} items={delivered} empty="最近届いた荷物はありません" />
      {cancelled.length > 0 ? (
        <details className="group">
          <summary className="cursor-pointer text-sm text-neutral-500">キャンセル {cancelled.length} 件</summary>
          <div className="mt-3 flex flex-col gap-3">
            {cancelled.map((p) => (
              <ParcelCard key={p.id} parcel={p} />
            ))}
          </div>
        </details>
      ) : null}
    </div>
  );
}

function Section({ title, count, items, empty }: { title: string; count: number; items: ParcelRow[]; empty?: string }) {
  if (items.length === 0 && !empty) return null;
  return (
    <section>
      <h2 className="flex items-baseline gap-2 text-base font-bold">
        {title}
        <span className="text-sm font-normal text-neutral-500">{count}</span>
      </h2>
      {items.length === 0 ? (
        <p className="mt-2 text-sm text-neutral-500">{empty}</p>
      ) : (
        <div className="mt-3 flex flex-col gap-3">
          {items.map((p) => (
            <ParcelCard key={p.id} parcel={p} />
          ))}
        </div>
      )}
    </section>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center py-20 text-center">
      <p className="text-5xl">📬</p>
      <h2 className="mt-4 text-lg font-bold">まだ荷物がありません</h2>
      <p className="mt-2 text-sm leading-6 text-neutral-600">
        注文メールを転送用アドレスに送ると、ここに並びます。
        <br />
        まずは設定から転送先を確認してください。
      </p>
      <Link href="/app/settings" className="mt-6 rounded-xl bg-neutral-900 px-5 py-3 text-sm font-medium text-white">
        転送先を見る
      </Link>
    </div>
  );
}
