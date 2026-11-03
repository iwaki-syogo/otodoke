import Link from "next/link";
import type { ParcelRow } from "@/lib/match";
import { STATUS_LABEL, formatWindow, relativeDateJa, todayJst, yen } from "@/lib/format";

const STATUS_STYLE: Record<string, string> = {
  ordered: "bg-neutral-100 text-neutral-700",
  shipped: "bg-sky-100 text-sky-800",
  out_for_delivery: "bg-amber-100 text-amber-900",
  attempted: "bg-red-100 text-red-800",
  delivered: "bg-emerald-100 text-emerald-800",
  cancelled: "bg-neutral-100 text-neutral-500 line-through",
  unknown: "bg-neutral-100 text-neutral-500",
};

export function StatusBadge({ status }: { status: string }) {
  return (
    <span className={`inline-flex shrink-0 items-center whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium ${STATUS_STYLE[status] ?? STATUS_STYLE.unknown}`}>
      {STATUS_LABEL[status] ?? status}
    </span>
  );
}

export function PresenceBadge({ value, compact = false }: { value: boolean | null; compact?: boolean }) {
  if (value === true) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-red-600 px-2 py-0.5 text-[11px] font-bold text-white">
        🤝 {compact ? "対面受け取り" : "対面受け取りが必要"}
      </span>
    );
  }
  if (value === false) {
    return <span className="inline-flex items-center rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-800">置き配・投函OK</span>;
  }
  return null;
}

export function ParcelCard({ parcel, showAmount = false }: { parcel: ParcelRow; showAmount?: boolean }) {
  const today = todayJst();
  // A window ("10/23〜10/31") is late only after its last day.
  const lastDay = parcel.expected_date_end ?? parcel.expected_date;
  const late = lastDay !== null && lastDay < today && parcel.status !== "delivered" && parcel.status !== "cancelled";
  const days = parcel.expected_date_end ? `${relativeDateJa(parcel.expected_date, today)}〜${relativeDateJa(parcel.expected_date_end, today)}` : relativeDateJa(parcel.expected_date, today);
  const when = parcel.expected_date ? `${days}${late ? "の予定" : ""}` : null;
  const window = formatWindow(parcel.expected_window_start, parcel.expected_window_end);
  return (
    <Link
      href={`/app/parcels/${parcel.id}`}
      className="block rounded-2xl border border-neutral-200 bg-white p-4 active:bg-neutral-50"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-xs text-neutral-500">{parcel.shop}</p>
          <p className="mt-0.5 line-clamp-2 text-[15px] font-medium leading-snug">{parcel.title ?? "品名の記載なし"}</p>
        </div>
        <StatusBadge status={parcel.status} />
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-sm">
        {when ? (
          <span className="font-bold">
            {when}
            {window ? <span className="ml-1 font-normal text-neutral-600">{window}</span> : null}
          </span>
        ) : parcel.status === "ordered" ? (
          <span className="text-neutral-500">お届け日はまだ未定</span>
        ) : null}
        <PresenceBadge value={parcel.requires_presence} compact />
        {parcel.needs_review ? <span className="text-xs text-amber-700">要確認</span> : null}
        {showAmount && parcel.total_amount !== null ? <span className="ml-auto text-neutral-700">{yen(parcel.total_amount)}</span> : null}
      </div>
    </Link>
  );
}
