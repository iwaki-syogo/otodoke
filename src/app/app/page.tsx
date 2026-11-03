import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { addDays, formatWindow, relativeDateJa, todayJst } from "@/lib/format";
import { isOverdue, type ParcelRow } from "@/lib/match";
import { UNREAD_FILTER } from "@/lib/unread";
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
  const { count: waiting } = await supabase
    .from("emails")
    .select("id", { count: "exact", head: true })
    .or(UNREAD_FILTER());

  const overdue = parcels.filter((p) => isOverdue(p, today));
  const current = parcels.filter((p) => !isOverdue(p, today));
  const incoming = current.filter((p) => ["shipped", "out_for_delivery", "attempted"].includes(p.status)).sort(byNextArrival(today));
  const ordered = current.filter((p) => ["ordered", "unknown"].includes(p.status));
  const delivered = parcels
    .filter((p) => p.status === "delivered" && (p.last_email_at ?? "") >= addDays(today, -30))
    .sort((a, b) => (b.last_email_at ?? "").localeCompare(a.last_email_at ?? ""));
  const cancelled = parcels.filter((p) => p.status === "cancelled");
  const presenceSoon = incoming.filter((p) => p.requires_presence && lastDay(p) && (lastDay(p) as string) >= today);

  const waitingNotice = waiting ? (
    <Link href="/app/settings" className="block rounded-2xl border border-amber-300 bg-amber-50 p-4 text-sm">
      まだ読んでいないメールが {waiting} 通あります。この一覧は最新ではないかもしれません。
    </Link>
  ) : null;

  if (parcels.length === 0) {
    return (
      <div className="flex flex-col gap-4">
        {waitingNotice}
        <EmptyState />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-8">
      {waitingNotice}
      {presenceSoon.length > 0 ? (
        <section className="rounded-2xl border border-red-200 bg-red-50 p-4">
          <h2 className="text-sm font-bold text-red-900">家にいる必要がある日</h2>
          <ul className="mt-2 flex flex-col gap-1 text-sm text-red-900">
            {presenceSoon.map((p) => (
              <li key={p.id}>
                <Link href={`/app/parcels/${p.id}`} className="underline underline-offset-4">
                  {relativeDateJa(p.expected_date)} {formatWindow(p.expected_window_start, p.expected_window_end)} {p.title ?? p.shop}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <Section title="もうすぐ届く" count={incoming.length} items={incoming} />
      <Section title="注文中" count={ordered.length} items={ordered} empty="注文中の荷物はありません" />
      <Section title="届いた（30 日）" count={delivered.length} items={delivered} empty="最近届いた荷物はありません" />
      <Folded summary={`届いたか分からない荷物 ${overdue.length} 件`} items={overdue} />
      <Folded summary={`キャンセル ${cancelled.length} 件`} items={cancelled} />
    </div>
  );
}

/** The last day a parcel may still arrive on time: the end of a window, or the one date. */
function lastDay(p: ParcelRow): string | null {
  return p.expected_date_end ?? p.expected_date;
}

/** What arrives next comes first, then what is running late, then what has no date yet. */
function byNextArrival(today: string) {
  const rank = (p: ParcelRow) => (!p.expected_date ? 2 : (lastDay(p) as string) >= today ? 0 : 1);
  return (a: ParcelRow, b: ParcelRow) => rank(a) - rank(b) || (a.expected_date ?? "").localeCompare(b.expected_date ?? "");
}

function Folded({ summary, items }: { summary: string; items: ParcelRow[] }) {
  if (items.length === 0) return null;
  return (
    <details className="group">
      <summary className="cursor-pointer text-sm text-neutral-500">{summary}</summary>
      <div className="mt-3 flex flex-col gap-3">
        {items.map((p) => (
          <ParcelCard key={p.id} parcel={p} />
        ))}
      </div>
    </details>
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
      <Link href="/app/settings" className="mt-6 w-full rounded-xl bg-neutral-900 px-5 py-3 text-sm font-medium text-white">
        転送先を見る
      </Link>
      <Link href="/app/settings#demo" className="mt-3 w-full rounded-xl border border-neutral-300 px-5 py-3 text-sm font-medium">
        サンプルで試す
      </Link>
    </div>
  );
}
