import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { RELEVANCE_LABEL, formatDateJa, formatDateTimeJa, formatWindow, yen } from "@/lib/format";
import { htmlToText } from "@/lib/text/html-to-text";
import { PresenceBadge, StatusBadge } from "../../parcel-card";

type Params = Promise<{ id: string }>;

export default async function ParcelDetailPage({ params }: { params: Params }) {
  const { id } = await params;
  const supabase = await createClient();

  const [{ data: parcel }, { data: items }, { data: extractions }] = await Promise.all([
    supabase.from("parcels").select("*").eq("id", id).maybeSingle(),
    supabase.from("parcel_items").select("*").eq("parcel_id", id).order("created_at"),
    supabase
      .from("extractions")
      .select("id, confidence, result, created_at, emails(id, subject, from_address, from_name, sent_at, classification, text_body, html_body)")
      .eq("parcel_id", id),
  ]);
  if (!parcel) notFound();

  const timeline = (extractions ?? [])
    .map((x) => ({ ...x, email: Array.isArray(x.emails) ? x.emails[0] : x.emails }))
    .filter((x) => x.email)
    .sort((a, b) => (a.email!.sent_at ?? "").localeCompare(b.email!.sent_at ?? ""));

  const windowText = formatWindow(parcel.expected_window_start, parcel.expected_window_end);

  return (
    <article className="flex flex-col gap-6">
      <Link href="/app" className="text-sm text-neutral-500">
        ‹ 荷物
      </Link>

      <header>
        <p className="text-sm text-neutral-500">{parcel.shop}</p>
        <h1 className="mt-1 line-clamp-3 text-xl font-bold leading-snug">{parcel.title ?? "品名の記載なし"}</h1>
        <div className="mt-3 flex flex-wrap gap-2">
          <StatusBadge status={parcel.status} />
          <PresenceBadge value={parcel.requires_presence} />
          {parcel.needs_review ? <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-900">要確認</span> : null}
        </div>
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
            {parcel.requires_presence === true ? "在宅が必要" : parcel.requires_presence === false ? "置き配・投函でOK" : <span className="text-neutral-500">メールに記載なし</span>}
            {parcel.presence_evidence ? <span className="block text-xs text-neutral-500">根拠: 「{parcel.presence_evidence}」</span> : null}
          </dd>
          <dt className="text-neutral-500">配送</dt>
          <dd>
            {parcel.carrier ?? <span className="text-neutral-500">メールに記載なし</span>}
            {parcel.tracking_number ? (
              <span className="block text-xs text-neutral-600">
                伝票 {parcel.tracking_number}
                {parcel.tracking_url ? (
                  <>
                    {" "}
                    <a href={parcel.tracking_url} target="_blank" rel="noopener noreferrer" className="font-medium text-sky-700 underline underline-offset-4">
                      追跡ページを開く
                    </a>
                  </>
                ) : null}
              </span>
            ) : null}
          </dd>
          <dt className="text-neutral-500">注文</dt>
          <dd>
            {parcel.ordered_at ? formatDateJa(parcel.ordered_at, { withYear: true }) : <span className="text-neutral-500">不明</span>}
            {parcel.order_number ? <span className="block text-xs text-neutral-600">番号 {parcel.order_number}</span> : null}
          </dd>
          <dt className="text-neutral-500">金額</dt>
          <dd className="font-medium">{yen(parcel.total_amount)}</dd>
        </dl>
      </section>

      {items && items.length > 0 ? (
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
        {timeline.length === 0 ? (
          <p className="mt-2 text-sm text-neutral-500">元メールがありません</p>
        ) : (
          <ol className="mt-2 flex flex-col gap-2">
            {timeline.map((x) => {
              const email = x.email!;
              const result = x.result as { notes?: string | null } | null;
              const body = email.text_body?.trim() || (email.html_body ? htmlToText(email.html_body) : "");
              return (
                <li key={x.id} className="rounded-2xl border border-neutral-200 bg-white p-3">
                  <div className="flex items-center justify-between gap-2 text-xs text-neutral-500">
                    <span className="font-medium text-neutral-800">{RELEVANCE_LABEL[email.classification ?? ""] ?? email.classification ?? "メール"}</span>
                    <span>{formatDateTimeJa(email.sent_at)}</span>
                  </div>
                  <p className="mt-1 text-sm leading-snug">{email.subject}</p>
                  <p className="mt-0.5 truncate text-xs text-neutral-500">{email.from_name ? `${email.from_name} <${email.from_address}>` : email.from_address}</p>
                  {result?.notes ? <p className="mt-2 text-xs text-amber-800">読み取りメモ: {result.notes}</p> : null}
                  {x.confidence !== null ? <p className="mt-1 text-[11px] text-neutral-400">確信度 {Math.round(Number(x.confidence) * 100)}%</p> : null}
                  <details className="mt-2">
                    <summary className="cursor-pointer text-xs text-sky-700">元メールを見る</summary>
                    <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-neutral-50 p-3 text-xs leading-5 text-neutral-700">
                      {body || "（本文なし）"}
                    </pre>
                  </details>
                </li>
              );
            })}
          </ol>
        )}
      </section>
    </article>
  );
}
