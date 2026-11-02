import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { daysInMonth, formatDateJa, monthLabel, shiftMonth, todayJst, yen } from "@/lib/format";
import type { ParcelRow } from "@/lib/match";

export const metadata = { title: "支出" };

type SearchParams = Promise<{ m?: string }>;

export default async function SpendPage({ searchParams }: { searchParams: SearchParams }) {
  const { m } = await searchParams;
  const today = todayJst();
  const ym = /^\d{4}-\d{2}$/.test(m ?? "") ? (m as string) : today.slice(0, 7);
  const [y, mo] = ym.split("-").map(Number);
  const first = `${ym}-01`;
  const last = `${ym}-${String(daysInMonth(y, mo)).padStart(2, "0")}`;

  const supabase = await createClient();
  const { data } = await supabase
    .from("parcels")
    .select("*")
    .gte("ordered_at", first)
    .lte("ordered_at", last)
    .neq("status", "cancelled")
    .order("ordered_at", { ascending: false });
  const parcels: ParcelRow[] = data ?? [];

  const priced = parcels.filter((p) => p.total_amount !== null);
  const unpriced = parcels.length - priced.length;
  const total = priced.reduce((s, p) => s + (p.total_amount ?? 0), 0);

  const byShop = new Map<string, number>();
  for (const p of priced) byShop.set(p.shop, (byShop.get(p.shop) ?? 0) + (p.total_amount ?? 0));
  const shops = [...byShop.entries()].sort((a, b) => b[1] - a[1]);
  const max = shops[0]?.[1] ?? 1;

  return (
    <div className="flex flex-col gap-6">
      <header className="flex items-center justify-between">
        <Link href={`/app/spend?m=${shiftMonth(ym, -1)}`} className="rounded-lg px-3 py-2 text-sm text-neutral-600 active:bg-neutral-100">
          ‹ 前月
        </Link>
        <h1 className="text-lg font-bold">{monthLabel(ym)}</h1>
        <Link href={`/app/spend?m=${shiftMonth(ym, 1)}`} className="rounded-lg px-3 py-2 text-sm text-neutral-600 active:bg-neutral-100">
          翌月 ›
        </Link>
      </header>

      <section className="rounded-2xl border border-neutral-200 bg-white p-5">
        <p className="text-sm text-neutral-500">ネット注文の合計</p>
        <p className="mt-1 text-4xl font-bold tracking-tight">{yen(total)}</p>
        <p className="mt-2 text-xs text-neutral-500">
          {priced.length} 件
          {unpriced > 0 ? `（ほかに金額を読み取れなかった注文が ${unpriced} 件）` : ""}
        </p>
      </section>

      {shops.length > 0 ? (
        <section>
          <h2 className="text-base font-bold">店ごと</h2>
          <ul className="mt-3 flex flex-col gap-3">
            {shops.map(([shop, amount]) => (
              <li key={shop}>
                <div className="flex items-baseline justify-between text-sm">
                  <span className="truncate font-medium">{shop}</span>
                  <span className="ml-3 shrink-0 text-neutral-700">{yen(amount)}</span>
                </div>
                <div className="mt-1 h-2 w-full overflow-hidden rounded-full bg-neutral-100">
                  <div className="h-full rounded-full bg-neutral-800" style={{ width: `${Math.max(3, Math.round((amount / max) * 100))}%` }} />
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section>
        <h2 className="text-base font-bold">注文</h2>
        {parcels.length === 0 ? (
          <p className="mt-2 text-sm text-neutral-500">この月の注文はありません</p>
        ) : (
          <ul className="mt-3 divide-y divide-neutral-200 rounded-2xl border border-neutral-200 bg-white">
            {parcels.map((p) => (
              <li key={p.id}>
                <Link href={`/app/parcels/${p.id}`} className="flex items-center gap-3 p-4 active:bg-neutral-50">
                  <div className="w-14 shrink-0 text-xs text-neutral-500">{p.ordered_at ? formatDateJa(p.ordered_at).replace(/\(.\)/, "") : ""}</div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs text-neutral-500">{p.shop}</p>
                    <p className="truncate text-sm font-medium">{p.title ?? "品名不明"}</p>
                  </div>
                  <div className="shrink-0 text-sm font-medium">{p.total_amount === null ? <span className="text-neutral-400">—</span> : yen(p.total_amount)}</div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
