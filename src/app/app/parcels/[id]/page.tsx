import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { amazonOrderTrackingUrl, identifyCarrier, normalizeTracking, trackingLinkFor } from "@/lib/carriers";
import { createClient, getUser } from "@/lib/supabase/server";
import { RELEVANCE_LABEL, formatDateJa, formatDateTimeJa, formatWindow, yen } from "@/lib/format";
import { faceToFace, faceToFaceAssumed } from "@/lib/match";
import { isHttpsUrl } from "@/lib/safe-url";
import { NO_BODY_TEXT, NO_SUBJECT_TEXT, isBlankSubject } from "@/lib/mail-notices";
import { htmlToText } from "@/lib/text/html-to-text";
import { CategorySheet } from "../../category-sheet";
import { ASSUMED_FACE_TO_FACE, PresenceBadge, StatusBadge } from "../../parcel-card";
import { MarkDeliveredButton } from "./mark-delivered-button";
import { NotDeliveredButton } from "./not-delivered-button";
import { TrackingButton } from "./tracking-button";
import { SealedMail } from "./sealed-mail";

type Params = Promise<{ id: string }>;

/**
 * The tab's title, as on the other pages: what the page is, never which parcel. A product or shop
 * name in the tab would show to anyone who sees the screen shared or the tab bar.
 */
export const metadata = { title: "荷物" };

export default async function ParcelDetailPage({ params }: { params: Params }) {
  const { id } = await params;
  // Postgres answers a malformed id with an error; that is a page that is not there, not a failed read.
  if (!z.uuid().safeParse(id).success) notFound();
  const supabase = await createClient();
  const user = await getUser();
  const userId = user?.id ?? "";

  const [{ data: parcel, error: parcelError }, { data: items, error: itemsError }, { data: extractions, error: extractionsError }] = await Promise.all([
    supabase.from("parcels").select("*").eq("id", id).maybeSingle(),
    supabase.from("parcel_items").select("*").eq("parcel_id", id).order("created_at"),
    supabase
      .from("extractions")
      .select("id, confidence, result, created_at, emails(id, subject, from_address, from_name, from_domain, sent_at, classification, body_state, text_body, html_body)")
      .eq("parcel_id", id),
  ]);
  // A failed read is told apart from a parcel, an item list or a mail history that is not there.
  for (const [what, err] of [["parcel", parcelError], ["items", itemsError], ["extractions", extractionsError]] as const) {
    if (err) console.error(`parcel page (${what}):`, err.message);
  }
  if (parcelError) {
    return (
      <article className="flex flex-col gap-6">
        <Link href="/app" className="text-sm text-neutral-500">
          ‹ 荷物
        </Link>
        <p className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-900">読み込めませんでした</p>
      </article>
    );
  }
  if (!parcel) notFound();

  const timeline = (extractions ?? [])
    .map((x) => ({ ...x, email: Array.isArray(x.emails) ? x.emails[0] : x.emails }))
    .filter((x) => x.email)
    .sort((a, b) => (a.email!.sent_at ?? "").localeCompare(b.email!.sent_at ?? ""));

  const windowText = formatWindow(parcel.expected_window_start, parcel.expected_window_end);
  // Worked out when shown, so parcels saved with an old carrier URL get the current way in.
  // A stored URL is linked only when it is https: (never javascript: or data:).
  const tracking = trackingLinkFor(parcel.tracking_number, parcel.carrier) ?? (isHttpsUrl(parcel.tracking_url) ? { kind: "open" as const, url: parcel.tracking_url } : null);
  // Most Amazon parcels name no carrier or number; Amazon's own page tracks them by order.
  const amazonUrl = parcel.shop_key === "amazon" ? amazonOrderTrackingUrl(parcel.order_number) : null;
  const presence = faceToFace(parcel);
  const presenceAssumed = faceToFaceAssumed(parcel);

  return (
    <article className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <Link href="/app" className="text-sm text-neutral-500">
          ‹ 荷物
        </Link>
        {/* Only a parcel typed in by hand is edited; a mail parcel changes its category alone. */}
        {parcel.source === "manual" ? (
          <Link href={`/app/parcels/${parcel.id}/edit`} className="rounded-full border border-neutral-300 bg-white px-3 py-1 text-sm active:bg-neutral-100">
            編集
          </Link>
        ) : null}
      </div>

      <header>
        <p className="text-sm text-neutral-500">{parcel.shop}</p>
        <h1 className="mt-1 line-clamp-3 text-xl font-bold leading-snug">{parcel.title ?? "品名の記載なし"}</h1>
        <div className="mt-3 flex flex-wrap gap-2">
          <StatusBadge status={parcel.status} />
          <PresenceBadge parcel={parcel} />
          {parcel.needs_review ? <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-900">要確認</span> : null}
        </div>
        {parcel.status === "delivered" ? (
          <div className="mt-3">
            <NotDeliveredButton id={parcel.id} />
          </div>
        ) : parcel.status !== "cancelled" ? (
          <div className="mt-3">
            <MarkDeliveredButton id={parcel.id} />
          </div>
        ) : null}
      </header>

      <section className="rounded-2xl border border-neutral-200 bg-white p-4">
        <dl className="grid grid-cols-[6rem_1fr] gap-y-3 text-sm">
          <dt className="text-neutral-500">お届け予定</dt>
          <dd className="font-medium">
            {parcel.expected_date ? (
              <>
                {formatDateJa(parcel.expected_date)}
                {parcel.expected_date_end ? `〜${formatDateJa(parcel.expected_date_end)}` : ""} {windowText}
                {parcel.expected_text ? <span className="block text-xs font-normal text-neutral-500">原文: {parcel.expected_text}</span> : null}
              </>
            ) : (
              <span className="font-normal text-neutral-500">未定</span>
            )}
          </dd>
          <dt className="text-neutral-500">受け取り</dt>
          <dd>
            {presence === true ? (presenceAssumed ? ASSUMED_FACE_TO_FACE : "対面受け取りが必要") : presence === false ? "置き配・投函でOK" : <span className="text-neutral-500">メールに記載なし</span>}
            {/* The default rests on nothing being said, so that fact stands where evidence would. */}
            {presenceAssumed ? (
              <span className="block text-xs text-neutral-500">{parcel.source === "manual" ? "指定なし" : "メールに記載なし"}</span>
            ) : parcel.presence_evidence ? (
              <span className="block text-xs text-neutral-500">根拠: 「{parcel.presence_evidence}」</span>
            ) : null}
          </dd>
          <dt className="text-neutral-500">配送</dt>
          <dd>
            {parcel.carrier ?? (amazonUrl ? null : <span className="text-neutral-500">メールに記載なし</span>)}
            {parcel.tracking_number ? (
              <div className="text-xs text-neutral-600">
                伝票 {parcel.tracking_number}
                {tracking ? (
                  <TrackingButton
                    link={tracking}
                    number={normalizeTracking(parcel.tracking_number)}
                    shown={parcel.tracking_number}
                    carrierName={identifyCarrier(parcel.tracking_number, parcel.carrier).name}
                  />
                ) : null}
              </div>
            ) : null}
            {amazonUrl ? (
              <a href={amazonUrl} target="_blank" rel="noopener noreferrer" className={`${parcel.carrier || parcel.tracking_number ? "mt-1 " : ""}block text-xs font-medium text-sky-700 underline underline-offset-4`}>
                Amazonで配送状況を見る
              </a>
            ) : null}
          </dd>
          <dt className="text-neutral-500">注文</dt>
          <dd>
            {parcel.ordered_at ? formatDateJa(parcel.ordered_at, { withYear: true }) : <span className="text-neutral-500">不明</span>}
            {parcel.order_number ? <span className="block text-xs text-neutral-600">番号 {parcel.order_number}</span> : null}
          </dd>
          <dt className="text-neutral-500">金額</dt>
          <dd className="font-medium">{yen(parcel.total_amount)}</dd>
          <dt className="text-neutral-500">分類</dt>
          <dd>
            <CategorySheet parcelId={parcel.id} category={parcel.category} />
          </dd>
        </dl>
      </section>

      {itemsError ? (
        <section>
          <h2 className="text-base font-bold">内容</h2>
          <p className="mt-2 rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-900">読み込めませんでした</p>
        </section>
      ) : items && items.length > 0 ? (
        <section>
          <h2 className="text-base font-bold">内容</h2>
          <ul className="mt-2 divide-y divide-neutral-200 rounded-2xl border border-neutral-200 bg-white">
            {items.map((it) => (
              <li key={it.id} className="flex items-start justify-between gap-3 p-3 text-sm">
                <span className="leading-snug">{it.name}</span>
                <span className="shrink-0 text-neutral-600">
                  {it.quantity ? `×${it.quantity}` : ""}
                  {it.unit_price !== null ? ` ${yen(it.unit_price)}` : ""}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section>
        <h2 className="text-base font-bold">メールの履歴</h2>
        {extractionsError ? (
          <p className="mt-2 rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-900">読み込めませんでした</p>
        ) : timeline.length === 0 ? (
          <p className="mt-2 text-sm text-neutral-500">元メールがありません</p>
        ) : (
          <ol className="mt-2 flex flex-col gap-2">
            {timeline.map((x) => {
              const email = x.email!;
              const result = x.result as { notes?: string | null } | null;
              const body = email.text_body?.trim() || (email.html_body ? htmlToText(email.html_body) : "");
              const notes = result?.notes ?? null;
              const confidence = x.confidence !== null ? <p className="mt-1 text-[11px] text-neutral-500">確信度 {Math.round(Number(x.confidence) * 100)}%</p> : null;
              return (
                <li key={x.id} className="rounded-2xl border border-neutral-200 bg-white p-3">
                  <div className="flex items-center justify-between gap-2 text-xs text-neutral-500">
                    <span className="font-medium text-neutral-800">{RELEVANCE_LABEL[email.classification ?? ""] ?? email.classification ?? "メール"}</span>
                    <span>{formatDateTimeJa(email.sent_at)}</span>
                  </div>
                  {email.body_state === "sealed" ? (
                    // Opened in the browser with the password; the server never sees the content.
                    <SealedMail userId={userId} email={user?.email ?? null} emailId={email.id} fromDomain={email.from_domain} notes={notes} confidence={confidence} />
                  ) : email.body_state === "dropped" ? (
                    <>
                      <p className="mt-1 text-sm leading-snug text-neutral-500">本文は保存していません</p>
                      {email.from_domain ? <p className="mt-0.5 truncate text-xs text-neutral-500">{email.from_domain}</p> : null}
                      {confidence}
                      <details className="mt-2">
                        <summary className="cursor-pointer text-xs text-sky-700">元メールを見る</summary>
                        {notes ? <p className="mt-2 text-xs leading-5 text-neutral-500">読み取りメモ: {notes}</p> : null}
                        <p className="mt-2 text-xs leading-5 text-neutral-600">メールの鍵ができる前に読み取ったメールです。件名・差出人・本文は残していません。</p>
                      </details>
                    </>
                  ) : (
                    <>
                      {!isBlankSubject(email.subject) ? (
                        <p className="mt-1 text-sm leading-snug">{email.subject}</p>
                      ) : (
                        <p className="mt-1 text-sm leading-snug text-neutral-500">{NO_SUBJECT_TEXT}</p>
                      )}
                      <p className="mt-0.5 truncate text-xs text-neutral-500">{email.from_name ? `${email.from_name} <${email.from_address}>` : email.from_address}</p>
                      {confidence}
                      <details className="mt-2">
                        <summary className="cursor-pointer text-xs text-sky-700">元メールを見る</summary>
                        {notes ? <p className="mt-2 text-xs leading-5 text-neutral-500">読み取りメモ: {notes}</p> : null}
                        <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-neutral-50 p-3 text-xs leading-5 text-neutral-700">
                          {body || NO_BODY_TEXT}
                        </pre>
                      </details>
                    </>
                  )}
                </li>
              );
            })}
          </ol>
        )}
      </section>
    </article>
  );
}
