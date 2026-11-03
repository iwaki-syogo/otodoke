import Link from "next/link";
import { categoryColor, categoryLabel, isCategory, type Category } from "@/lib/category";
import { daysInMonth, formatDateJa, monthLabel, shiftMonth, todayJst, yen } from "@/lib/format";
import type { ParcelRow } from "@/lib/match";
import { categoryOf, spendByCategory, spendByMonth, spendMonthParam, spendTotal, withEmptyMonths } from "@/lib/spend";
import { readAll } from "@/lib/supabase/read-all";
import { createClient } from "@/lib/supabase/server";
import { CategorySheet } from "../category-sheet";
import { MonthBars } from "./month-bars";

export const metadata = { title: "支出" };

type SearchParams = Promise<{ m?: string; c?: string }>;

/** The whole period, as `?m=all`. */
const ALL = "all";
/** 未分類 in `?c=`. */
const NONE = "none";

const cParam = (c: Category | null) => (c === null ? NONE : c);

export default async function SpendPage({ searchParams }: { searchParams: SearchParams }) {
  const { m, c } = await searchParams;
  const today = todayJst();
  const all = m === ALL;
  const ym = spendMonthParam(all ? undefined : m, today);
  const [y, mo] = ym.split("-").map(Number);
  const first = `${ym}-01`;
  const last = `${ym}-${String(daysInMonth(y, mo)).padStart(2, "0")}`;
  // undefined: no filter; null: 未分類 only.
  const only: Category | null | undefined = c === NONE ? null : isCategory(c) ? c : undefined;

  const supabase = await createClient();
  let parcels: ParcelRow[] | null = null;
  try {
    parcels = await readAll<ParcelRow>(() => {
      const q = supabase.from("parcels").select("*", { count: "exact" }).neq("status", "cancelled");
      return (all ? q : q.gte("ordered_at", first).lte("ordered_at", last)).order("ordered_at", { ascending: false, nullsFirst: false });
    });
  } catch (err) {
    console.error("spend page:", err instanceof Error ? err.message : err);
  }

  const here = (params: { m?: string; c?: Category | null }) => {
    const q = new URLSearchParams({ m: params.m ?? (all ? ALL : ym) });
    if (params.c !== undefined) q.set("c", cParam(params.c));
    return `/app/spend?${q.toString()}`;
  };

  return (
    <div className="flex flex-col gap-6">
      <nav className="grid grid-cols-2 rounded-xl bg-neutral-100 p-1 text-sm" aria-label="期間">
        <Link href={`/app/spend?m=${today.slice(0, 7)}`} aria-current={!all ? "page" : undefined} className={`rounded-lg py-2 text-center ${!all ? "bg-white font-bold shadow-sm" : "text-neutral-600"}`}>
          月
        </Link>
        <Link href={`/app/spend?m=${ALL}`} aria-current={all ? "page" : undefined} className={`rounded-lg py-2 text-center ${all ? "bg-white font-bold shadow-sm" : "text-neutral-600"}`}>
          全期間
        </Link>
      </nav>

      {all ? (
        <h1 className="text-center text-lg font-bold">全期間</h1>
      ) : (
        <header className="flex items-center justify-between">
          <Link href={here({ m: shiftMonth(ym, -1), c: only })} className="rounded-lg px-3 py-2 text-sm text-neutral-600 active:bg-neutral-100">
            ‹ 前月
          </Link>
          <h1 className="text-lg font-bold">{monthLabel(ym)}</h1>
          <Link href={here({ m: shiftMonth(ym, 1), c: only })} className="rounded-lg px-3 py-2 text-sm text-neutral-600 active:bg-neutral-100">
            翌月 ›
          </Link>
        </header>
      )}

      {parcels === null ? (
        <p className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-900">読み込めませんでした</p>
      ) : (
        <Spend parcels={parcels} all={all} only={only} here={here} />
      )}
    </div>
  );
}

function Spend({
  parcels,
  all,
  only,
  here,
}: {
  parcels: ParcelRow[];
  all: boolean;
  only: Category | null | undefined;
  here: (p: { m?: string; c?: Category | null }) => string;
}) {
  // The whole period is told by order month, so parcels with no order date stay out of every
  // figure and the bars add up to the total.
  const counted = all ? parcels.filter((p) => p.ordered_at) : parcels;
  const categories = spendByCategory(counted);
  const picked = only === undefined ? counted : counted.filter((p) => categoryOf(p) === only);
  // Over the whole period a picked category narrows the total card too; the breakdowns stay whole.
  const narrowed = all && only !== undefined;
  const card = spendTotal(narrowed ? picked : counted);
  const undated = narrowed ? parcels.filter((p) => !p.ordered_at && categoryOf(p) === only).length : parcels.length - counted.length;
  const priced = counted.filter((p) => p.total_amount !== null);

  const byShop = new Map<string, number>();
  for (const p of priced) {
    // Amazon signs its mails under several names; one shop should read as one line.
    const name = p.shop_key === "amazon" ? "Amazon" : p.shop;
    byShop.set(name, (byShop.get(name) ?? 0) + (p.total_amount ?? 0));
  }
  const shops = [...byShop.entries()].sort((a, b) => b[1] - a[1]);
  const maxShop = shops[0]?.[1] || 1;

  return (
    <>
      <section className="rounded-2xl border border-neutral-200 bg-white p-5">
        <p className="text-sm text-neutral-500">{narrowed ? `${categoryLabel(only)}の合計` : "ネット注文の合計"}</p>
        <p className="mt-1 text-4xl font-bold tracking-tight">{yen(card.total)}</p>
        <p className="mt-2 text-xs text-neutral-500">
          {card.priced} 件
          {card.unpriced > 0 ? `（ほかに金額を読み取れなかった注文が ${card.unpriced} 件）` : ""}
          {undated > 0 ? `（注文日の無い ${undated} 件は除く）` : ""}
        </p>
      </section>

      {all ? <MonthBars months={withEmptyMonths(spendByMonth(picked))} query={(month) => here({ m: month, c: only })} /> : null}

      {categories.length > 0 ? (
        <section>
          <h2 className="text-base font-bold">分類ごと</h2>
          <ul className="mt-3 flex flex-col gap-1">
            {categories.map((r) => {
              const selected = only !== undefined && only === r.category;
              return (
                <li key={String(r.category)}>
                  <Link
                    href={selected ? here({}) : here({ c: r.category })}
                    aria-current={selected ? "true" : undefined}
                    className={`block rounded-xl px-3 py-2 active:bg-neutral-100 ${selected ? "bg-neutral-100" : ""} ${only !== undefined && !selected ? "opacity-50" : ""}`}
                  >
                    <div className="flex items-center gap-2 text-sm">
                      <span aria-hidden className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: categoryColor(r.category) }} />
                      <span className="min-w-0 flex-1 truncate font-medium">{categoryLabel(r.category)}</span>
                      <span className="shrink-0 tabular-nums text-neutral-700">{yen(r.amount)}</span>
                      <span className="w-10 shrink-0 text-right text-xs tabular-nums text-neutral-500">{Math.round(r.share * 100)}%</span>
                    </div>
                    <div className="mt-1.5 h-2 w-full rounded-full bg-neutral-100">
                      <div className="h-full rounded-full" style={{ width: `${r.amount > 0 ? Math.max(2, r.share * 100) : 0}%`, backgroundColor: categoryColor(r.category) }} />
                    </div>
                  </Link>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      {shops.length > 0 ? (
        <section>
          <h2 className="text-sm font-bold text-neutral-700">店ごと</h2>
          <ul className="mt-2 flex flex-col gap-2">
            {shops.map(([shop, amount]) => (
              <li key={shop}>
                <div className="flex items-baseline justify-between text-xs">
                  <span className="truncate text-neutral-700">{shop}</span>
                  <span className="ml-3 shrink-0 tabular-nums text-neutral-500">{yen(amount)}</span>
                </div>
                <div className="mt-0.5 h-1 w-full rounded-full bg-neutral-100">
                  <div className="h-full rounded-full bg-neutral-400" style={{ width: `${Math.max(2, Math.round((amount / maxShop) * 100))}%` }} />
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {all ? null : (
        <section>
          <h2 className="flex items-baseline gap-2 text-base font-bold">
            注文
            {only !== undefined ? (
              <Link href={here({})} className="text-sm font-normal text-neutral-500 underline underline-offset-4">
                {categoryLabel(only)}だけ ×
              </Link>
            ) : null}
          </h2>
          {picked.length === 0 ? (
            <p className="mt-2 text-sm text-neutral-500">{counted.length === 0 ? "この月の注文はありません" : "この分類の注文はありません"}</p>
          ) : (
            <ul className="mt-3 divide-y divide-neutral-200 rounded-2xl border border-neutral-200 bg-white">
              {picked.map((p) => (
                <li key={p.id} className="relative">
                  {/* The chip is a button of its own, outside the link. */}
                  <Link href={`/app/parcels/${p.id}`} className="flex items-start gap-3 p-4 pb-12 active:bg-neutral-50">
                    <div className="w-14 shrink-0 pt-0.5 text-xs text-neutral-500">{p.ordered_at ? formatDateJa(p.ordered_at).replace(/\(.\)/, "") : ""}</div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs text-neutral-500">{p.shop}</p>
                      <p className="truncate text-sm font-medium">{p.title ?? "品名の記載なし"}</p>
                    </div>
                    <div className="shrink-0 text-sm font-medium tabular-nums">{p.total_amount === null ? <span className="text-neutral-400">—</span> : yen(p.total_amount)}</div>
                  </Link>
                  <div className="absolute bottom-3 left-[5.25rem]">
                    <CategorySheet parcelId={p.id} category={p.category} />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </>
  );
}
