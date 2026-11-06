"use client";

import { useActionState } from "react";
import { SubmitButton } from "@/components/pending-button";
import { CARRIERS } from "@/lib/carriers";
import { CATEGORIES, categoryLabel, isCategory } from "@/lib/category";
import { STATUS_LABEL } from "@/lib/format";
import {
  MANUAL_CANCELLED,
  MANUAL_CARRIED_STATUSES,
  MANUAL_CARRIERS,
  MANUAL_KEEP_CARRIER,
  MANUAL_LIMITS,
  MANUAL_STATUSES,
  manualCarrierChoice,
  type ManualFormState,
} from "@/lib/manual-parcel";
import type { ParcelRow } from "@/lib/match";
import { createManualParcel, deleteManualParcel, updateManualParcel } from "./manual-actions";

const STATUS_CHOICES: Record<string, string> = {
  ordered: "注文済み",
  shipped: "発送済み",
  delivered: "届いた",
};
/** Statuses only a mail sets: offered while the parcel is there, so it saves back unchanged. */
const KEPT_STATUSES: readonly string[] = [...MANUAL_CARRIED_STATUSES, MANUAL_CANCELLED];
const ALL_STATUSES: readonly string[] = [...MANUAL_STATUSES, ...KEPT_STATUSES];

/** The status choices for a parcel whose status is `current`. */
export function manualStatusChoices(current: string): string[] {
  return [...MANUAL_STATUSES, ...KEPT_STATUSES.filter((s) => s === current)];
}
const NAMED_CARRIERS = MANUAL_CARRIERS.filter((c) => c !== "auto");

/**
 * The values the form starts with, as strings under the names ManualParcelSchema reads.
 * A new parcel was ordered today; an edited one starts with what is stored.
 */
export function manualFormDefaults(parcel: ParcelRow | null, today: string): Record<string, string> {
  if (!parcel) {
    return { title: "", shop: "", ordered_at: today, expected_date: "", total_amount: "", category: "", tracking_number: "", carrier: "auto", presence: "", status: "ordered" };
  }
  return {
    title: parcel.title ?? "",
    shop: parcel.shop,
    ordered_at: parcel.ordered_at ?? "",
    expected_date: parcel.expected_date ?? "",
    total_amount: parcel.total_amount === null ? "" : String(parcel.total_amount),
    category: isCategory(parcel.category) ? parcel.category : "",
    tracking_number: parcel.tracking_number ?? "",
    carrier: manualCarrierChoice(parcel.carrier, parcel.tracking_number),
    presence: parcel.requires_presence === null ? "" : parcel.requires_presence ? "face" : "drop",
    status: ALL_STATUSES.includes(parcel.status) ? parcel.status : "ordered",
  };
}

const field = "mt-1 w-full rounded-xl border border-neutral-300 bg-white px-3 py-2.5 text-base";
// iOS Safari gives type=date a minimum width of its own; min-h is the other fields' height.
const dateField = `${field} block min-w-0 max-w-full appearance-none min-h-[2.875rem]`;

/** Register (parcel = null) or edit a parcel typed in by hand. */
export function ManualForm({ parcel, today }: { parcel: ParcelRow | null; today: string }) {
  const defaults = manualFormDefaults(parcel, today);
  const [state, action] = useActionState<ManualFormState, FormData>(parcel ? updateManualParcel : createManualParcel, { error: null, values: defaults });
  const values = { ...defaults, ...state.values };
  // Statuses a mail moved the parcel to are offered only while it is there.
  const statuses = manualStatusChoices(values.status);
  // A carrier name a mail filled in that the five do not cover stays as a choice of its own.
  const keptCarrier = parcel && manualCarrierChoice(parcel.carrier, parcel.tracking_number) === MANUAL_KEEP_CARRIER ? parcel.carrier : null;

  return (
    <div className="flex flex-col gap-6">
      <form action={action} className="flex flex-col gap-4">
        {parcel ? <input type="hidden" name="id" value={parcel.id} /> : null}
        {/* React resets the fields after the action; a key from the values redraws them with what was sent. */}
        <div key={JSON.stringify(values)} className="flex flex-col gap-4">
          <label className="text-sm font-medium">
            品名
            <input name="title" required maxLength={MANUAL_LIMITS.title} defaultValue={values.title} className={field} />
          </label>
          <label className="text-sm font-medium">
            店
            <input name="shop" required maxLength={MANUAL_LIMITS.shop} defaultValue={values.shop} className={field} />
          </label>
          <label className="text-sm font-medium">
            注文日
            <input type="date" name="ordered_at" defaultValue={values.ordered_at} className={dateField} />
          </label>
          <label className="text-sm font-medium">
            お届け予定日
            <input type="date" name="expected_date" defaultValue={values.expected_date} className={dateField} />
          </label>
          <label className="flex flex-wrap items-center gap-x-2 text-sm font-medium">
            <span className="w-full">金額</span>
            <input name="total_amount" inputMode="numeric" autoComplete="off" placeholder="2480" defaultValue={values.total_amount} className={`${field} w-auto min-w-0 flex-1`} />
            <span className="mt-1 text-base">円</span>
          </label>
          <label className="text-sm font-medium">
            分類
            <select name="category" defaultValue={values.category} className={field}>
              <option value="">{categoryLabel(null)}</option>
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {categoryLabel(c)}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm font-medium">
            追跡番号
            <input name="tracking_number" maxLength={MANUAL_LIMITS.tracking} autoComplete="off" defaultValue={values.tracking_number} className={field} />
          </label>
          <label className="text-sm font-medium">
            運送会社
            <select name="carrier" defaultValue={values.carrier} className={field}>
              <option value="auto">自動判定</option>
              {keptCarrier ? <option value={MANUAL_KEEP_CARRIER}>{keptCarrier}</option> : null}
              {NAMED_CARRIERS.map((c) => (
                <option key={c} value={c}>
                  {CARRIERS[c].name}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm font-medium">
            受け取り
            <select name="presence" defaultValue={values.presence} className={field}>
              <option value="">指定なし</option>
              <option value="face">対面</option>
              <option value="drop">置き配・投函</option>
            </select>
          </label>
          <label className="text-sm font-medium">
            状態
            <select name="status" defaultValue={values.status} className={field}>
              {statuses.map((s) => (
                <option key={s} value={s}>
                  {STATUS_CHOICES[s] ?? STATUS_LABEL[s] ?? s}
                </option>
              ))}
            </select>
          </label>
        </div>
        {state.error ? (
          <p role="alert" className="text-sm text-red-800">
            {state.error}
          </p>
        ) : null}
        <SubmitButton pendingLabel="保存しています…" tone="light" className="flex w-full items-center justify-center gap-2 rounded-xl bg-neutral-900 px-4 py-3 text-sm font-medium text-white">
          {parcel ? "保存" : "登録"}
        </SubmitButton>
      </form>

      {parcel ? <DeleteForm id={parcel.id} /> : null}
    </div>
  );
}

function DeleteForm({ id }: { id: string }) {
  const [state, action] = useActionState<ManualFormState, FormData>(deleteManualParcel, { error: null, values: {} });
  return (
    <details className="text-sm">
      <summary className="cursor-pointer text-neutral-500">この荷物を消す</summary>
      <form action={action} className="mt-2 flex flex-col gap-2 rounded-xl bg-neutral-50 p-3">
        <input type="hidden" name="id" value={id} />
        <label className="flex items-center gap-2">
          <input type="checkbox" name="confirm" value="yes" required className="h-4 w-4" />
          本当に消します。元に戻せません。
        </label>
        {state.error ? (
          <p role="alert" className="text-sm text-red-800">
            {state.error}
          </p>
        ) : null}
        {/* Not disabled while sending (a disabled button drops out of the POST): see SubmitButton. */}
        <SubmitButton pendingLabel="消しています…" className="flex items-center gap-2 self-start rounded-lg border border-red-300 px-3 py-2 text-sm text-red-800">
          消す
        </SubmitButton>
      </form>
    </details>
  );
}
