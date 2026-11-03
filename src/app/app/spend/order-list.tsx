import Link from "next/link";
import { groupByOrderMonth } from "@/lib/delivered";
import { formatDateJa, yen } from "@/lib/format";
import type { ParcelRow } from "@/lib/match";
import { CategorySheet } from "../category-sheet";

/**
 * The spend screen's orders: date, shop, title, amount and the category chip. Over the whole
 * period they sit under order-month headings (newest first, undated last); a month is one list.
 */
export function OrderList({ parcels, byMonth }: { parcels: ParcelRow[]; byMonth: boolean }) {
  if (!byMonth) return <Orders parcels={parcels} />;
  return (
    <div className="mt-3 flex flex-col gap-4">
      {groupByOrderMonth(parcels).map((g) => (
        <section key={g.label}>
          <h3 className="flex items-baseline gap-2 text-xs font-bold text-neutral-500">
            {g.label}
            <span className="font-normal">{g.parcels.length}</span>
          </h3>
          <Orders parcels={g.parcels} />
        </section>
      ))}
    </div>
  );
}

function Orders({ parcels }: { parcels: ParcelRow[] }) {
  return (
    <ul className="mt-3 divide-y divide-neutral-200 rounded-2xl border border-neutral-200 bg-white">
      {parcels.map((p) => (
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
  );
}
