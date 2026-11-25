import Link from "next/link";
import { redirect } from "next/navigation";
import { formatDateJa, yen } from "@/lib/format";
import { EXCLUDED_BY_RULE, EXCLUDED_BY_USER, EXCLUDED_EMPTY, EXCLUDED_PAGE_TITLE } from "@/lib/not-parcel-text";
import { createClient, getUser } from "@/lib/supabase/server";
import { StatusBadge } from "../parcel-card";
import { orderExcluded, readMarkTimes, seenUntilOf } from "@/lib/not-parcel-auto-view";
import { DeliveredToastProvider } from "../delivered-controls";
import { MarkAutoSeen } from "./mark-auto-seen";
import { RestoreWithNotice } from "./restore-with-notice";

export const metadata = { title: EXCLUDED_PAGE_TITLE };

/**
 * The parcels taken out of the list and the spending, newest first. They are read by the database function
 * (the policy that hides them from every other read does not apply to it), with the person's own session.
 * A row is not a link: the parcel page cannot open a parcel that is taken out.
 */
export default async function ExcludedPage() {
  const user = await getUser();
  if (!user) redirect("/login");
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("excluded_parcels");
  if (error) console.error("excluded page:", error.message);
  // The parcels the app took out by itself that have not arrived come first.
  const rows = error ? null : orderExcluded(data ?? []);
  // Written by the client part after this page is drawn; nothing is written when none of them is listed or the read failed.
  const seenUntil = rows ? seenUntilOf(rows, await readMarkTimes(supabase)) : null;

  return (
    <DeliveredToastProvider>
    <div className="flex flex-col gap-6">
      {seenUntil ? <MarkAutoSeen seenUntil={seenUntil} expectedUserId={user.id} /> : null}
      <Link href="/app" className="text-sm text-neutral-500">
        ‹ 荷物
      </Link>
      <h1 className="text-lg font-bold">{EXCLUDED_PAGE_TITLE}</h1>

      {rows === null ? (
        <p className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-900">読み込めませんでした</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-neutral-500">{EXCLUDED_EMPTY}</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {rows.map((r) => {
            const names = r.item_names.length > 0 ? r.item_names.join("、") : (r.title ?? "品名の記載なし");
            return (
              <li key={r.parcel_id} className="rounded-2xl border border-neutral-200 bg-white p-4">
                <p className="text-sm text-neutral-500">{r.shop}</p>
                <p className="mt-1 line-clamp-3 text-base font-bold leading-snug">{names}</p>
                <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-neutral-600">
                  <StatusBadge status={r.status} />
                  {r.ordered_at ? <span>{formatDateJa(r.ordered_at, { withYear: true })}</span> : null}
                  <span>{yen(r.total_amount)}</span>
                </div>
                <p className="mt-2 text-xs text-neutral-500">{r.kind === "rule" ? EXCLUDED_BY_RULE : EXCLUDED_BY_USER}</p>
                <div className="mt-3">
                  <RestoreWithNotice id={r.parcel_id} kind={r.kind} />
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
    </DeliveredToastProvider>
  );
}
