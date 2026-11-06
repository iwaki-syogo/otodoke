import { CATEGORIES, categoryColor, categoryLabel, type Category } from "@/lib/category";
import { yen } from "@/lib/format";
import { axisTicks, tickLabel, type spendByMonth } from "@/lib/spend";
import { FilterLink } from "./filter-link";

type Month = ReturnType<typeof spendByMonth>[number];

const PLOT = 160; // px, the bars' area; month labels sit below it
const BAR = 20; // px, under the 24px cap
const SLOT = 32; // px, each bar's tap target

/**
 * Spending per order month as stacked columns, one colour per category in a fixed order.
 * Plain HTML and CSS (no chart library). Newest month on the right; the row scrolls sideways
 * and starts at the newest. Tapping a column opens that month, through the FilterArea's one
 * transition (so it waits while another condition is on the way).
 */
export function MonthBars({ months, query }: { months: Month[]; query: (month: string) => string }) {
  if (months.length === 0) return null;
  const ticks = axisTicks(Math.max(...months.map((m) => m.total)));
  const top = ticks[ticks.length - 1] || 1;
  // Legend in the stacking order, listing only categories that appear.
  const present = ([...CATEGORIES, null] as Array<Category | null>).filter((c) => months.some((m) => m.segments.some((s) => s.category === c)));

  return (
    <figure className="rounded-2xl border border-neutral-200 bg-white p-4">
      <div className="flex">
        {/* y axis */}
        <div className="relative w-10 shrink-0" style={{ height: PLOT }} aria-hidden>
          {ticks.map((t) => (
            <span key={t} className="absolute right-2 translate-y-1/2 text-[10px] tabular-nums text-neutral-500" style={{ bottom: (t / top) * PLOT }}>
              {tickLabel(t)}
            </span>
          ))}
        </div>
        <div className="relative min-w-0 flex-1">
          {/* gridlines behind the columns */}
          <div className="pointer-events-none absolute inset-x-0 top-0" style={{ height: PLOT }} aria-hidden>
            {ticks.map((t) => (
              <div key={t} className={`absolute inset-x-0 h-px ${t === 0 ? "bg-neutral-300" : "bg-neutral-100"}`} style={{ bottom: (t / top) * PLOT }} />
            ))}
          </div>
          <ol className="relative flex flex-row-reverse overflow-x-auto" aria-label="月ごとの支出">
            {[...months].reverse().map((m, i, list) => {
              const [y, mo] = m.month.split("-").map(Number);
              const prev = list[i + 1];
              const showYear = !prev || prev.month.slice(0, 4) !== m.month.slice(0, 4);
              const height = (m.total / top) * PLOT;
              return (
                <li key={m.month} className="shrink-0" style={{ width: SLOT }}>
                  <FilterLink
                    href={query(m.month)}
                    aria-label={`${y}年${mo}月 ${yen(m.total)}`}
                    title={`${y}年${mo}月 ${yen(m.total)}`}
                    className="group flex flex-col items-center"
                  >
                    <div className="flex items-end" style={{ height: PLOT }}>
                      {/* stacked bottom-up; a 2px surface gap between parts; rounded only at the top */}
                      <div className="flex flex-col-reverse gap-[2px] overflow-hidden rounded-t-[4px] group-active:opacity-70" style={{ width: BAR, height }}>
                        {m.segments.map((s) => (
                          <div key={String(s.category)} style={{ flexGrow: s.amount, flexBasis: 0, backgroundColor: categoryColor(s.category) }} />
                        ))}
                      </div>
                    </div>
                    <span className="mt-1 text-[10px] tabular-nums text-neutral-500">{mo}月</span>
                    <span className="h-3 text-[9px] leading-3 text-neutral-400">{showYear ? `${String(y).slice(2)}年` : ""}</span>
                  </FilterLink>
                </li>
              );
            })}
          </ol>
        </div>
      </div>
      <figcaption className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-neutral-600">
        {present.map((c) => (
          <span key={String(c)} className="inline-flex items-center gap-1">
            <span aria-hidden className="h-2 w-2 rounded-full" style={{ backgroundColor: categoryColor(c) }} />
            {categoryLabel(c)}
          </span>
        ))}
      </figcaption>
    </figure>
  );
}
