import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { daysInMonth, formatDateJa, formatWindow, monthLabel, monthParam, shiftMonth, todayJst, weekdayOf } from "@/lib/format";
import { faceToFace, type ParcelRow } from "@/lib/match";
import { upcomingByDay } from "@/lib/calendar";
import { DeliveredLink } from "../delivered-link";
import { PresenceBadge, StatusBadge } from "../parcel-card";

export const metadata = { title: "カレンダー" };

type SearchParams = Promise<{ m?: string }>;

export default async function CalendarPage({ searchParams }: { searchParams: SearchParams }) {
  const { m } = await searchParams;
  const today = todayJst();
  const ym = monthParam(m, today);
  const [y, mo] = ym.split("-").map(Number);
  const first = `${ym}-01`;
  const last = `${ym}-${String(daysInMonth(y, mo)).padStart(2, "0")}`;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("parcels")
    .select("*")
    // A window that started last month and runs into this one belongs here too.
    .lte("expected_date", last)
    .or(`expected_date.gte.${first},expected_date_end.gte.${first}`)
    .neq("status", "cancelled")
    .order("expected_date", { ascending: true })
    .order("expected_window_start", { ascending: true, nullsFirst: false });
  // A failed read is told apart from a month with nothing ahead.
  if (error) console.error("calendar page:", error.message);
  const failed = Boolean(error);
  const parcels: ParcelRow[] = data ?? [];

  // Only what is still ahead: past days, delivered and cancelled parcels are not shown.
  const byDay = upcomingByDay(parcels, today, first, last);

  const leading = weekdayOf(first);
  const cells: Array<string | null> = [...Array<null>(leading).fill(null)];
  for (let d = 1; d <= daysInMonth(y, mo); d++) cells.push(`${ym}-${String(d).padStart(2, "0")}`);
  while (cells.length % 7 !== 0) cells.push(null);

  const days = [...byDay.keys()].sort();

  return (
    <div className="flex flex-col gap-6">
      <header className="flex items-center justify-between">
        <Link href={`/app/calendar?m=${shiftMonth(ym, -1)}`} className="rounded-lg px-3 py-2 text-sm text-neutral-600 active:bg-neutral-100" aria-label="前の月">
          ‹ 前月
        </Link>
        <h1 className="text-lg font-bold">{monthLabel(ym)}</h1>
        <Link href={`/app/calendar?m=${shiftMonth(ym, 1)}`} className="rounded-lg px-3 py-2 text-sm text-neutral-600 active:bg-neutral-100" aria-label="次の月">
          翌月 ›
        </Link>
      </header>

      <div className="rounded-2xl border border-neutral-200 bg-white p-2">
        <div className="grid grid-cols-7 text-center text-[11px] text-neutral-500">
          {["日", "月", "火", "水", "木", "金", "土"].map((w, i) => (
            <div key={w} className={`py-1 ${i === 0 ? "text-red-600" : i === 6 ? "text-sky-700" : ""}`}>
              {w}
            </div>
          ))}
        </div>
        <div className="grid grid-cols-7 gap-y-1">
          {cells.map((day, i) => {
            if (!day) return <div key={`e${i}`} />;
            const list = byDay.get(day) ?? [];
            const presence = list.some((p) => faceToFace(p) === true);
            const isToday = day === today;
            const dnum = Number(day.slice(8));
            const Cell = list.length ? "a" : "div";
            return (
              <Cell
                key={day}
                href={list.length ? `#d-${day}` : undefined}
                className={`flex min-h-16 flex-col items-center rounded-lg px-0.5 py-1 ${list.length ? "active:bg-neutral-100" : ""}`}
              >
                <span
                  className={`flex h-6 w-6 items-center justify-center rounded-full text-sm ${
                    isToday ? "bg-neutral-900 font-bold text-white" : i % 7 === 0 ? "text-red-600" : i % 7 === 6 ? "text-sky-700" : ""
                  }`}
                >
                  {dnum}
                </span>
                {list.length > 0 ? (
                  <span
                    className={`mt-1 w-full truncate rounded px-1 text-center text-[10px] leading-4 ${
                      presence ? "bg-red-600 font-bold text-white" : "bg-sky-100 text-sky-900"
                    }`}
                  >
                    {presence ? "🤝" : ""}
                    {list.length}件
                  </span>
                ) : null}
              </Cell>
            );
          })}
        </div>
      </div>

      {failed ? (
        <p className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-900">読み込めませんでした</p>
      ) : days.length === 0 ? (
        <p className="py-6 text-center text-sm text-neutral-500">この月の予定はありません</p>
      ) : (
        <ol className="flex flex-col gap-5">
          {days.map((day) => {
            const list = byDay.get(day)!;
            const presence = list.some((p) => faceToFace(p) === true);
            return (
              <li key={day} id={`d-${day}`} className="scroll-mt-4">
                <h2 className={`flex items-center gap-2 text-sm font-bold ${day === today ? "text-neutral-900" : "text-neutral-700"}`}>
                  {formatDateJa(day)}
                  {day === today ? <span className="rounded-full bg-neutral-900 px-2 py-0.5 text-[10px] text-white">今日</span> : null}
                  {presence ? <span className="text-[11px] font-bold text-red-700">対面受け取り</span> : null}
                </h2>
                <ul className="mt-2 flex flex-col gap-2">
                  {list.map((p) => (
                    <li key={p.id}>
                      <Link href={`/app/parcels/${p.id}`} className="flex items-start gap-3 rounded-xl border border-neutral-200 bg-white p-3 active:bg-neutral-50">
                        <div className="w-20 shrink-0 text-sm font-bold">
                          {p.expected_date_end ? `${formatDateJa(p.expected_date)}〜${formatDateJa(p.expected_date_end)}のどこか` : formatWindow(p.expected_window_start, p.expected_window_end) || <span className="font-normal text-neutral-500">時間未定</span>}
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-xs text-neutral-500">{p.shop}</p>
                          <p className="line-clamp-2 text-sm font-medium leading-snug">{p.title ?? "品名の記載なし"}</p>
                          <div className="mt-1.5 flex flex-wrap gap-1.5">
                            <StatusBadge status={p.status} />
                            <PresenceBadge parcel={p} compact />
                          </div>
                        </div>
                      </Link>
                    </li>
                  ))}
                </ul>
              </li>
            );
          })}
        </ol>
      )}
      <DeliveredLink />
    </div>
  );
}
