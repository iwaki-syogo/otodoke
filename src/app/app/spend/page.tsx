import { redirect } from "next/navigation";
import { categoryColor, categoryLabel, type Category } from "@/lib/category";
import { daysInMonth, shiftMonth, todayJst, yen } from "@/lib/format";
import type { ParcelRow } from "@/lib/match";
import { sharePercent, spendByCategory, spendByMonth, spendMonthParam, spendSlices, spendTotal, withEmptyMonths } from "@/lib/spend";
import { NONE, categoryParam, firstParam, normalizeShop, shopLabel } from "@/lib/shop";
import { readAll } from "@/lib/supabase/read-all";
import { MONTH_MIN, monthMax } from "@/lib/month-url";
import { createClient, getUser } from "@/lib/supabase/server";
import { FilterArea, FilterLink, FilterScope, FilterSpinner } from "./filter-link";
import { MonthPicker } from "../month-picker";
import { MonthBars } from "./month-bars";
import { OrderList } from "./order-list";

export const metadata = { title: "支出" };

type Param = string | string[] | undefined;
type SearchParams = Promise<{ m?: Param; c?: Param; s?: Param }>;

/** The whole period, as `?m=all`. */
const ALL = "all";

const cParam = (c: Category | null) => (c === null ? NONE : c);

/** A URL on this screen: `c` and `s` are put in only when given. */
type Here = (p: { m?: string; c?: Category | null; s?: string }) => string;

export default async function SpendPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const m = firstParam(params.m);
  const today = todayJst();
  const all = m === ALL;
  const ym = spendMonthParam(all ? undefined : m, today);
  const [y, mo] = ym.split("-").map(Number);
  const first = `${ym}-01`;
  const last = `${ym}-${String(daysInMonth(y, mo)).padStart(2, "0")}`;
  // undefined: no filter; null: 未分類 only.
  const only: Category | null | undefined = categoryParam(params.c);
  // The shop in full (never cut). A month reads only its own parcels, so a shop that is not in
  // it still narrows (to nothing), and its chip takes it off.
  const shop = firstParam(params.s) || undefined;

  const user = await getUser();
  if (!user) redirect("/login");
  const supabase = await createClient();
  let parcels: ParcelRow[] | null = null;
  try {
    parcels = await readAll<ParcelRow>(() => {
      const q = supabase.from("parcels").select("*", { count: "exact" }).eq("user_id", user.id).neq("status", "cancelled");
      return (all ? q : q.gte("ordered_at", first).lte("ordered_at", last)).order("ordered_at", { ascending: false, nullsFirst: false });
    });
  } catch (err) {
    console.error("spend page:", err instanceof Error ? err.message : err);
  }

  const here: Here = (p) => {
    const q = new URLSearchParams({ m: p.m ?? (all ? ALL : ym) });
    if (p.c !== undefined) q.set("c", cParam(p.c));
    if (p.s) q.set("s", p.s);
    return `/app/spend?${q.toString()}`;
  };

  return (
    // Every control that changes the conditions (the period, the month, a row, a chip, a bar)
    // shares one transition, so none is followed from an old URL while another is on the way.
    <FilterScope>
      <div className="flex flex-col gap-6">
        <nav className="grid grid-cols-2 rounded-xl bg-neutral-100 p-1 text-sm" aria-label="期間">
          <FilterLink href={here({ m: today.slice(0, 7), s: shop })} aria-current={!all ? "page" : undefined} className={`rounded-lg py-2 text-center ${!all ? "bg-white font-bold shadow-sm" : "text-neutral-600"}`}>
            月
          </FilterLink>
          <FilterLink href={here({ m: ALL, s: shop })} aria-current={all ? "page" : undefined} className={`rounded-lg py-2 text-center ${all ? "bg-white font-bold shadow-sm" : "text-neutral-600"}`}>
            全期間
          </FilterLink>
        </nav>

        {all ? (
          <h1 className="text-center text-lg font-bold">全期間</h1>
        ) : (
          <header className="flex items-center justify-between">
            <FilterLink href={here({ m: shiftMonth(ym, -1), c: only, s: shop })} className="rounded-lg px-3 py-2 text-sm text-neutral-600 active:bg-neutral-100">
              ‹ 前月
            </FilterLink>
            <h1 className="text-lg font-bold">
              <MonthPicker value={ym} basePath="/app/spend" keep={{ c: only === undefined ? undefined : cParam(only), s: shop }} min={MONTH_MIN} max={monthMax(today)} />
            </h1>
            <FilterLink href={here({ m: shiftMonth(ym, 1), c: only, s: shop })} className="rounded-lg px-3 py-2 text-sm text-neutral-600 active:bg-neutral-100">
              翌月 ›
            </FilterLink>
          </header>
        )}

        {parcels === null ? (
          <p className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-900">読み込めませんでした</p>
        ) : (
          <Spend parcels={parcels} all={all} only={only} shop={shop} here={here} />
        )}
      </div>
    </FilterScope>
  );
}

function Spend({ parcels, all, only, shop, here }: { parcels: ParcelRow[]; all: boolean; only: Category | null | undefined; shop: string | undefined; here: Here }) {
  // c and s narrow the total, the bars and the orders; each breakdown by the other one only.
  const slices = spendSlices(parcels, { all, c: only, s: shop });
  const card = spendTotal(slices.picked);
  const categories = spendByCategory(slices.byCategory);
  const narrowed = only !== undefined || shop !== undefined;
  // Category first, then shop: the order of the chips. The shop is cut for display only.
  const conditions = [...(only !== undefined ? [categoryLabel(only)] : []), ...(shop !== undefined ? [shopLabel(shop)] : [])];

  const byShop = new Map<string, number>();
  for (const p of slices.byShop) {
    if (p.total_amount === null) continue;
    // Amazon signs its mails under several names; one shop should read as one line.
    const name = normalizeShop(p);
    byShop.set(name, (byShop.get(name) ?? 0) + p.total_amount);
  }
  const shops = [...byShop.entries()].sort((a, b) => b[1] - a[1]);
  const maxShop = shops[0]?.[1] || 1;

  return (
    <FilterArea>
      <section className="rounded-2xl border border-neutral-200 bg-white p-5">
        <p className="truncate text-sm text-neutral-500">{narrowed ? `${conditions.join("・")}の合計` : "ネット注文の合計"}</p>
        <p className="mt-1 text-4xl font-bold tracking-tight">{yen(card.total)}</p>
        <p className="mt-2 text-xs text-neutral-500">
          {card.priced} 件
          {card.unpriced > 0 ? `（ほかに金額を読み取れなかった注文が ${card.unpriced} 件）` : ""}
          {slices.undated > 0 ? `（注文日の無い ${slices.undated} 件は除く）` : ""}
        </p>
      </section>

      {all ? <MonthBars months={withEmptyMonths(spendByMonth(slices.picked))} query={(month) => here({ m: month, c: only, s: shop })} /> : null}

      {categories.length > 0 ? (
        <section>
          <h2 className="text-base font-bold">分類ごと</h2>
          <ul className="mt-3 flex flex-col gap-1">
            {categories.map((r) => {
              const selected = only !== undefined && only === r.category;
              return (
                <li key={String(r.category)}>
                  <FilterLink
                    href={selected ? here({ s: shop }) : here({ c: r.category, s: shop })}
                    aria-current={selected ? "true" : undefined}
                    className={`block rounded-xl px-3 py-2 active:bg-neutral-100 ${selected ? "bg-neutral-100" : ""} ${only !== undefined && !selected ? "opacity-50" : ""}`}
                  >
                    <div className="flex items-center gap-2 text-sm">
                      <FilterSpinner>
                        <span aria-hidden className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: categoryColor(r.category) }} />
                      </FilterSpinner>
                      <span className="min-w-0 flex-1 truncate font-medium">{categoryLabel(r.category)}</span>
                      <span className="shrink-0 tabular-nums text-neutral-700">{yen(r.amount)}</span>
                      <span className="w-10 shrink-0 text-right text-xs tabular-nums text-neutral-500">{sharePercent(r.share)}</span>
                    </div>
                    <div className="mt-1.5 h-2 w-full rounded-full bg-neutral-100">
                      <div className="h-full rounded-full" style={{ width: `${r.amount > 0 ? Math.max(2, r.share * 100) : 0}%`, backgroundColor: categoryColor(r.category) }} />
                    </div>
                  </FilterLink>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      {shops.length > 0 ? (
        <section>
          <h2 className="text-sm font-bold text-neutral-700">店ごと</h2>
          <ul className="mt-2 flex flex-col gap-1">
            {shops.map(([name, amount]) => {
              const selected = shop === name;
              return (
                <li key={name}>
                  <FilterLink
                    href={selected ? here({ c: only }) : here({ c: only, s: name })}
                    prefetch={false}
                    aria-current={selected ? "true" : undefined}
                    className={`block rounded-xl px-3 py-1.5 active:bg-neutral-100 ${selected ? "bg-neutral-100" : ""} ${shop !== undefined && !selected ? "opacity-50" : ""}`}
                  >
                    <div className="flex items-baseline justify-between text-xs">
                      <span className="truncate text-neutral-700">{name}</span>
                      <span className="ml-3 flex shrink-0 items-center gap-1.5 tabular-nums text-neutral-500">
                        <FilterSpinner />
                        {yen(amount)}
                      </span>
                    </div>
                    <div className="mt-0.5 h-1 w-full rounded-full bg-neutral-100">
                      <div className="h-full rounded-full bg-neutral-400" style={{ width: `${Math.max(2, Math.round((amount / maxShop) * 100))}%` }} />
                    </div>
                  </FilterLink>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      <section>
        <h2 className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-base font-bold">
          注文
          {only !== undefined ? <Chip href={here({ s: shop })} label={categoryLabel(only)} /> : null}
          {shop !== undefined ? <Chip href={here({ c: only })} label={shopLabel(shop)} /> : null}
        </h2>
        {slices.orders.length === 0 ? (
          <p className="mt-2 text-sm text-neutral-500">{narrowed ? "この条件の注文はありません" : all ? "注文はありません" : "この月の注文はありません"}</p>
        ) : (
          <OrderList parcels={slices.orders} byMonth={all} />
        )}
      </section>
    </FilterArea>
  );
}

/** 「◯◯だけ ×」: takes its own condition off and keeps the other. */
function Chip({ href, label }: { href: string; label: string }) {
  return (
    <FilterLink href={href} className="inline-flex min-w-0 max-w-full items-center gap-1 text-sm font-normal text-neutral-500 underline underline-offset-4">
      <span className="min-w-0 truncate">{label}だけ</span> <FilterSpinner>×</FilterSpinner>
    </FilterLink>
  );
}
