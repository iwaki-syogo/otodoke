import Link from "next/link";
import { redirect } from "next/navigation";
import { readAll } from "@/lib/supabase/read-all";
import { createClient, getUser } from "@/lib/supabase/server";
import { todayJst } from "@/lib/format";
import type { ParcelRow } from "@/lib/match";
import { parcelSections } from "@/lib/parcel-sections";
import { UNREAD_FILTER } from "@/lib/unread";
import { DeliverAll, DeliveredToastProvider, SwipeToDeliver } from "./delivered-controls";
import { PageLink } from "./page-link";
import { ParcelCard } from "./parcel-card";

export const metadata = { title: "荷物" };

export default async function ParcelsPage() {
  const user = await getUser();
  if (!user) redirect("/login");
  const supabase = await createClient();
  // Independent reads, sent together. Each keeps its own result: a failed count shows no count,
  // and never stands in for the list or the other counts.
  const [list, { count: waiting }, { count: deliveredCount, error: deliveredError }, { count: cancelledCount, error: cancelledError }] =
    await Promise.all([
      // Every parcel, past the 1000-row cap: the sections and their counts are read as complete.
      // A failed page is caught here, so the counts below still show.
      readAll<ParcelRow>(() =>
        supabase
          .from("parcels")
          .select("*", { count: "exact" })
          .eq("user_id", user.id)
          .order("expected_date", { ascending: true, nullsFirst: false })
          .order("last_email_at", { ascending: false, nullsFirst: false }),
      ).then(
        (rows): ParcelRow[] | null => rows,
        (err: unknown) => {
          console.error("parcels page:", err instanceof Error ? err.message : err);
          return null;
        },
      ),
      supabase.from("emails").select("id", { count: "exact", head: true }).or(UNREAD_FILTER()),
      // Counted by the database, so the 1000-row cap on reads cannot cut it short.
      supabase.from("parcels").select("id", { count: "exact", head: true }).eq("user_id", user.id).eq("status", "delivered"),
      supabase.from("parcels").select("id", { count: "exact", head: true }).eq("user_id", user.id).eq("status", "cancelled"),
    ]);
  // A failed read is told apart from having no parcels: by null, never by the empty list.
  const listFailed = list === null;
  const parcels: ParcelRow[] = list ?? [];
  const { open, toCheck, delivering, soon, ordered } = parcelSections(parcels, todayJst());

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

  // At the end of the list, on the empty screen too.
  const pageLinks = (
    <div className="flex flex-col gap-3">
      <PageLink href="/app/delivered" label="届いた荷物" count={deliveredError ? undefined : (deliveredCount ?? undefined)} />
      <PageLink href="/app/cancelled" label="キャンセルした荷物" count={cancelledError ? undefined : (cancelledCount ?? undefined)} />
    </div>
  );

  if (listFailed) {
    return (
      <div className="flex flex-col gap-4">
        {addLink}
        {waitingNotice}
        <p className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-900">読み込めませんでした</p>
        {pageLinks}
      </div>
    );
  }

  if (parcels.length === 0) {
    return (
      <div className="flex flex-col gap-4">
        {addLink}
        {waitingNotice}
        <EmptyState />
        {pageLinks}
      </div>
    );
  }

  return (
    <DeliveredToastProvider>
    <div className="flex flex-col gap-8">
      {addLink}
      {waitingNotice}
      <CheckSection items={toCheck} />
      <Section title="配達中" count={delivering.length} items={delivering} swipe />
      <Section title="もうすぐ届く" count={soon.length} items={soon} swipe />
      <Section title="注文中" count={ordered.length} items={ordered} empty="注文中の荷物はありません" swipe />
      {pageLinks}
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
