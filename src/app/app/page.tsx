import Link from "next/link";
import { redirect } from "next/navigation";
import { readAll } from "@/lib/supabase/read-all";
import { createClient, getUser } from "@/lib/supabase/server";
import { scheduleSealRemaining } from "@/lib/seal-later";
import { todayJst } from "@/lib/format";
import type { ParcelRow } from "@/lib/match";
import { parcelSections } from "@/lib/parcel-sections";
import { PENDING_GRACE_MS, UNREAD_FILTER } from "@/lib/unread";
import { DeliverAll, DeliveredToastProvider, SwipeToDeliver } from "./delivered-controls";
import { NotYetButton } from "./not-yet-button";
import { PageLink } from "./page-link";
import { LOAD_DEMO_LABEL } from "./settings/demo-labels";
import { readMailSoFar, type MailSoFar } from "./settings/settings-reads";
import { ParcelCard } from "./parcel-card";

export const metadata = { title: "荷物" };

type SearchParams = Promise<{ demo?: string | string[] }>;

export default async function ParcelsPage({ searchParams }: { searchParams?: SearchParams } = {}) {
  // Only a fixed marker is read: the sample load leaves ?demo=busy when another load is running.
  const sampleBusy = (await searchParams)?.demo === "busy";
  const user = await getUser();
  if (!user) redirect("/login");
  // Old plaintext mail is sealed in the background, bounded; nothing to do without a key or plaintext.
  scheduleSealRemaining(user.id);
  const supabase = await createClient();
  // Independent reads, sent together. Each keeps its own result: a failed count shows no count,
  // and never stands in for the list. The links to the received and cancelled pages carry no
  // count; the number is seen after opening the page.
  const [list, { count: waiting }] =
    await Promise.all([
      // Every parcel, past the 1000-row cap: the sections and their counts are read as complete.
      // A failed page is caught here, so the links below and the rest of the page still show.
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
    ]);
  // A failed read is told apart from having no parcels: by null, never by the empty list.
  const listFailed = list === null;
  const parcels: ParcelRow[] = list ?? [];
  const { arrived, toCheck, delivering, soon, ordered } = parcelSections(parcels, todayJst());

  const addLink = (
    <div className="flex justify-end">
      <Link href="/app/parcels/new" className="rounded-full border border-neutral-300 bg-white px-3 py-1.5 text-sm font-medium active:bg-neutral-100">
        ＋ 登録
      </Link>
    </div>
  );

  const waitingNotice = waiting ? (
    <Link href="/app/settings/trouble" className="block rounded-2xl border border-amber-300 bg-amber-50 p-4 text-sm">
      まだ読んでいないメールが {waiting} 通あります。この一覧は最新ではないかもしれません。
    </Link>
  ) : null;

  const sampleBusyNotice = sampleBusy ? (
    <p className="rounded-2xl border border-amber-300 bg-amber-50 p-4 text-sm">
      ほかの人がサンプルを読み込んでいるかもしれません。{PENDING_GRACE_MS / 60_000} 分ほど待ってから、もう一度サンプルを読み込んでください。
      <Link href="/app/settings/demo" className="mt-3 block w-full rounded-xl border border-neutral-300 bg-white px-5 py-3 text-center text-sm font-medium">
        {LOAD_DEMO_LABEL}
      </Link>
    </p>
  ) : null;

  // At the end of the list, on the empty screen too.
  const pageLinks = (
    <div className="flex flex-col gap-3">
      <PageLink href="/app/delivered" label="受け取り済み" />
      <PageLink href="/app/cancelled" label="キャンセルした荷物" />
    </div>
  );

  if (listFailed) {
    return (
      <div className="flex flex-col gap-4">
        {addLink}
        {sampleBusyNotice}
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
        {sampleBusyNotice}
        {waitingNotice}
        <EmptyState mail={await mailSoFar(supabase, user.id)} />
        {pageLinks}
      </div>
    );
  }

  return (
    <DeliveredToastProvider>
    <div className="flex flex-col gap-8">
      {addLink}
      {sampleBusyNotice}
      {waitingNotice}
      <Section title="配達済み" count={arrived.length} items={arrived} swipe />
      <CheckSection items={toCheck} />
      <Section title="配達中" count={delivering.length} items={delivering} swipe />
      <Section title="もうすぐ届く" count={soon.length} items={soon} swipe />
      <Section title="注文中" count={ordered.length} items={ordered} empty="注文中の荷物はありません" swipe />
      {pageLinks}
    </div>
    </DeliveredToastProvider>
  );
}

/** Parcels two weeks past their date with no delivery mail, or two weeks delivered with no word from the user, to be confirmed. */
function CheckSection({ items }: { items: ParcelRow[] }) {
  if (items.length === 0) return null;
  const shown = items.slice(0, 5);
  const rest = items.slice(5);
  // Each line is there only when some parcel in the section fits it.
  const notDelivered = items.some((p) => p.status !== "delivered");
  const delivered = items.some((p) => p.status === "delivered");
  return (
    <section className="rounded-2xl border border-amber-300 bg-amber-50 p-4">
      <h2 className="flex items-baseline gap-2 text-base font-bold text-amber-950">
        要確認
        <span className="text-sm font-normal text-amber-900">{items.length}</span>
      </h2>
      {notDelivered ? <p className="mt-1 text-sm text-amber-950">お届け予定から 2 週間以上たっても、届いた連絡がない荷物です。届いていますか？</p> : null}
      {delivered ? <p className="mt-1 text-sm text-amber-950">受け取りましたか？</p> : null}
      <div className="mt-3">
        <DeliverAll items={items.map((p) => ({ id: p.id, status: p.status, received_at: p.received_at }))} />
      </div>
      <div className="mt-3 flex flex-col gap-3">
        {shown.map((p) => (
          <CheckCard key={p.id} parcel={p} />
        ))}
      </div>
      {rest.length > 0 ? (
        <details className="mt-3">
          <summary className="cursor-pointer text-sm text-amber-900">ほか {rest.length} 件を見る</summary>
          <div className="mt-3 flex flex-col gap-3">
            {rest.map((p) => (
              <CheckCard key={p.id} parcel={p} />
            ))}
          </div>
        </details>
      ) : null}
    </section>
  );
}

/** A card in 要確認. A delivered one also has 「まだ」: it leaves 要確認 and is not asked about again. */
function CheckCard({ parcel }: { parcel: ParcelRow }) {
  return (
    <div>
      <SwipeToDeliver id={parcel.id} status={parcel.status} receivedAt={parcel.received_at}>
        <ParcelCard parcel={parcel} />
      </SwipeToDeliver>
      {parcel.status === "delivered" ? <NotYetButton id={parcel.id} /> : null}
    </div>
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
              <SwipeToDeliver key={p.id} id={p.id} status={p.status} receivedAt={p.received_at}>
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

/**
 * What has come in so far, for the empty list:
 * - "received": forwarded mail of the person's own, a stored mail or one the screen dropped
 *   (screen_events keeps those 14 days).
 * - "approval": only Gmail's forwarding confirmation. Gmail forwards nothing until it is approved,
 *   so waiting brings nothing: the person is asked to approve it (the button is in 設定).
 * - "none": nothing. The public samples never count (no sample is a Gmail confirmation), and
 *   clearing them (「すべての荷物を消す」 takes their mails too) brings the setup question back.
 * Read only for the empty list. A failed read answers "none": the setup question shows, as before.
 */
async function mailSoFar(supabase: Awaited<ReturnType<typeof createClient>>, userId: string): Promise<MailSoFar> {
  // Shared with the approval cards in 設定 (settings-reads.ts). A failed read answers "none".
  return (await readMailSoFar(supabase, userId, "parcels page")) ?? "none";
}

/** The empty list's words and its first button, by what has come in so far. */
const EMPTY_GUIDE: Record<MailSoFar, { lines: [string, string]; button: string; href: string }> = {
  // Setting up is once, never a mail at a time; the button does not promise the address at once.
  none: { lines: ["メールの自動転送を設定しますか？", "設定は最初の 1 回だけです。"], button: "設定する", href: "/app/settings/forwarding" },
  // Forwarding is there: asking again would send them to set it up twice.
  received: { lines: ["メールは届いています。", "荷物のメールが届くまで、お待ちください。"], button: "設定を見る", href: "/app/settings/trouble" },
  // Worded for both: not approved yet, or approved and no mail since. The button goes to the
  // approval in 設定 (its section is id="gmail-approval"; the loading screen scrolls there once
  // the page is in). Without that id the hash is ignored and it is 設定 as before.
  approval: { lines: ["Gmail の転送は承認しましたか？", "承認すると、荷物のメールが届きはじめます。"], button: "設定で承認する", href: "/app/settings/forwarding#gmail-approval" },
};

function EmptyState({ mail }: { mail: MailSoFar }) {
  const guide = EMPTY_GUIDE[mail];
  return (
    <div className="flex flex-col items-center justify-center py-20 text-center">
      <p className="text-5xl">📬</p>
      <h2 className="mt-4 text-lg font-bold">まだ荷物がありません</h2>
      <p className="mt-2 text-sm leading-6 text-neutral-600">
        {guide.lines[0]}
        <br />
        {guide.lines[1]}
      </p>
      <Link href={guide.href} className="mt-6 w-full rounded-xl bg-neutral-900 px-5 py-3 text-sm font-medium text-white">
        {guide.button}
      </Link>
      <Link href="/app/settings/demo" className="mt-3 w-full rounded-xl border border-neutral-300 px-5 py-3 text-sm font-medium">
        サンプルで試す
      </Link>
    </div>
  );
}
