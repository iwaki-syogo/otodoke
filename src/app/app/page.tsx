import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { formatWindow, relativeDateJa, todayJst } from "@/lib/format";
import { faceToFace, isLate, lastExpectedDay, needsCheck, type ParcelRow } from "@/lib/match";
import { UNREAD_FILTER } from "@/lib/unread";
import { DeliverAll, DeliveredToastProvider, SwipeToDeliver } from "./delivered-controls";
import { DeliveredLink } from "./delivered-link";
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
  // Counted by the database, so the 1000-row cap on reads cannot cut it short.
  const { count: deliveredCount, error: deliveredError } = await supabase
    .from("parcels")
    .select("id", { count: "exact", head: true })
    .eq("status", "delivered");

  const open = parcels.filter((p) => p.status !== "delivered" && p.status !== "cancelled");
  // Two weeks past the date with no word: ask the user instead of guessing.
  const toCheck = open.filter((p) => needsCheck(p, today));
  const active = open.filter((p) => !needsCheck(p, today));
  const delivering = active.filter((p) => p.status === "out_for_delivery" && !isLate(p, today));
  const ordered = active.filter((p) => ["ordered", "unknown"].includes(p.status) && !isLate(p, today));
  // Everything else on its way, including a parcel past its date that may still come.
  const soon = active.filter((p) => !delivering.includes(p) && !ordered.includes(p)).sort(byNextArrival(today));
  const cancelled = parcels.filter((p) => p.status === "cancelled");
  const inPerson = active.filter((p) => faceToFace(p) === true && (lastExpectedDay(p) ?? "") >= today).sort(byNextArrival(today));

  const addLink = (
    <div className="flex justify-end">
      <Link href="/app/parcels/new" className="rounded-full border border-neutral-300 bg-white px-3 py-1.5 text-sm font-medium active:bg-neutral-100">
        ＋ 登録
      </Link>
    </div>
  );

  const waitingNotice = waiting ? (
    <Link href="/app/settings" className="block rounded-2xl border border-amber-300 bg-amber-50 p-4 text-sm">
      まだ読んでいないメールが {waiting} 通あります。この一覧は最新ではないかもしれません。
    </Link>
  ) : null;

  if (parcels.length === 0) {
    return (
      <div className="flex flex-col gap-4">
        {addLink}
        {waitingNotice}
        <EmptyState />
      </div>
    );
  }

  return (
    <DeliveredToastProvider>
    <div className="flex flex-col gap-8">
      {addLink}
      {waitingNotice}
      {inPerson.length > 0 ? (
        <section className="rounded-2xl border border-red-200 bg-red-50 p-4">
          <h2 className="text-sm font-bold text-red-900">対面受け取りが必要な商品</h2>
          <ul className="mt-2 flex flex-col gap-1 text-sm text-red-900">
            {inPerson.map((p) => (
              <li key={p.id}>
                <Link href={`/app/parcels/${p.id}`} className="underline underline-offset-4">
                  {relativeDateJa(p.expected_date)} {formatWindow(p.expected_window_start, p.expected_window_end)} {p.title ?? p.shop}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <CheckSection items={toCheck} />
      <Section title="配達中" count={delivering.length} items={delivering} swipe />
      <Section title="もうすぐ届く" count={soon.length} items={soon} swipe />
      <Section title="注文中" count={ordered.length} items={ordered} empty="注文中の荷物はありません" swipe />
      <DeliveredLink count={deliveredError ? undefined : (deliveredCount ?? undefined)} />
      <Folded summary={`キャンセル ${cancelled.length} 件`} items={cancelled} />
      {open.length > 0 ? <p className="text-center text-xs text-neutral-500">届いた荷物は、左にスワイプして「届いた」にできます</p> : null}
    </div>
    </DeliveredToastProvider>
  );
}

/** Parcels two weeks past their date with no delivery mail, to be confirmed by the user. */
function CheckSection({ items }: { items: ParcelRow[] }) {
  if (items.length === 0) return null;
  const shown = items.slice(0, 5);
  const rest = items.slice(5);
  return (
    <section className="rounded-2xl border border-amber-300 bg-amber-50 p-4">
      <h2 className="flex items-baseline gap-2 text-base font-bold text-amber-950">
        要確認
        <span className="text-sm font-normal text-amber-900">{items.length}</span>
      </h2>
      <p className="mt-1 text-sm text-amber-950">お届け予定から 2 週間以上たっても、届いた連絡がない荷物です。届いていますか？</p>
      <div className="mt-3">
        <DeliverAll items={items.map((p) => ({ id: p.id, status: p.status }))} />
      </div>
      <div className="mt-3 flex flex-col gap-3">
        {shown.map((p) => (
          <SwipeToDeliver key={p.id} id={p.id} status={p.status}>
            <ParcelCard parcel={p} />
          </SwipeToDeliver>
        ))}
      </div>
      {rest.length > 0 ? (
        <details className="mt-3">
          <summary className="cursor-pointer text-sm text-amber-900">ほか {rest.length} 件を見る</summary>
          <div className="mt-3 flex flex-col gap-3">
            {rest.map((p) => (
              <SwipeToDeliver key={p.id} id={p.id} status={p.status}>
                <ParcelCard parcel={p} />
              </SwipeToDeliver>
            ))}
          </div>
        </details>
      ) : null}
    </section>
  );
}

/** What arrives next comes first, then what is running late, then what has no date yet. */
function byNextArrival(today: string) {
  const rank = (p: ParcelRow) => (!p.expected_date ? 2 : (lastExpectedDay(p) as string) >= today ? 0 : 1);
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

function Section({ title, count, items, empty, swipe = false }: { title: string; count: number; items: ParcelRow[]; empty?: string; swipe?: boolean }) {
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
          {items.map((p) =>
            swipe ? (
              <SwipeToDeliver key={p.id} id={p.id} status={p.status}>
                <ParcelCard parcel={p} />
              </SwipeToDeliver>
            ) : (
              <ParcelCard key={p.id} parcel={p} />
            ),
          )}
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
