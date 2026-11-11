/** Date/number formatting for the UI. All dates are JST calendar dates ("YYYY-MM-DD"), never shifted through UTC. */

const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

/** Today's calendar date in Asia/Tokyo as "YYYY-MM-DD". */
export function todayJst(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** Parse "YYYY-MM-DD" into parts without constructing a Date in local time. */
export function splitDate(ymd: string): { y: number; m: number; d: number } | null {
  const m = ymd.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  return { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
}

/** Weekday index (0 = Sunday) of a calendar date, computed in UTC to avoid DST/zone effects. */
export function weekdayOf(ymd: string): number {
  const p = splitDate(ymd);
  if (!p) return 0;
  return new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay();
}

export function addDays(ymd: string, days: number): string {
  const p = splitDate(ymd);
  if (!p) return ymd;
  const t = new Date(Date.UTC(p.y, p.m - 1, p.d + days));
  return t.toISOString().slice(0, 10);
}

export function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** "11/3(月)" — with the year only when it differs from this year. */
export function formatDateJa(ymd: string | null | undefined, opts: { withYear?: boolean } = {}): string {
  if (!ymd) return "";
  const p = splitDate(ymd);
  if (!p) return ymd;
  const thisYear = Number(todayJst().slice(0, 4));
  const wd = WEEKDAYS[weekdayOf(ymd)];
  const base = `${p.m}/${p.d}(${wd})`;
  return opts.withYear || p.y !== thisYear ? `${p.y}/${base}` : base;
}

/** Relative label for a delivery date: 今日 / 明日 / 11/5(水) / 2 日前. */
export function relativeDateJa(ymd: string | null | undefined, today = todayJst()): string {
  if (!ymd) return "";
  if (ymd === today) return "今日";
  if (ymd === addDays(today, 1)) return "明日";
  if (ymd === addDays(today, -1)) return "昨日";
  return formatDateJa(ymd);
}

/** "14:00-16:00" / "午前中" / "" */
export function formatWindow(start: string | null | undefined, end: string | null | undefined): string {
  const s = start?.slice(0, 5) ?? "";
  const e = end?.slice(0, 5) ?? "";
  if (s === "08:00" && e === "12:00") return "午前中";
  if (s && e) return `${s}〜${e}`;
  if (s) return `${s}〜`;
  if (e) return `〜${e}`;
  return "";
}

export function yen(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  return `¥${n.toLocaleString("ja-JP")}`;
}

/** "2026-11-02T09:00:00Z" → "11/2(月) 18:00" in JST. */
export function formatDateTimeJa(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  const time = new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", hour: "2-digit", minute: "2-digit", hour12: false }).format(d);
  return `${formatDateJa(date)} ${time}`;
}

/** "2026-11-02(月) 02:21" in JST, used as the base date given to the model. */
export function formatJstStamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const date = todayJst(d);
  const time = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Tokyo", hour: "2-digit", minute: "2-digit", hour12: false }).format(d);
  return `${date}(${WEEKDAYS[weekdayOf(date)]}) ${time}`;
}

export const STATUS_LABEL: Record<string, string> = {
  ordered: "注文中",
  shipped: "発送済み",
  out_for_delivery: "配達中",
  attempted: "不在・再配達",
  delivered: "届いた",
  cancelled: "キャンセル",
  unknown: "不明",
};

/**
 * delivered is two states on the Web: 配達済み (a mail or the person said it was delivered) and
 * 受け取り済み (the person said they have it: received_at). STATUS_LABEL above is copied by the iOS
 * app and pinned by its parity test, so it keeps its old word for delivered; the Web shows a parcel's
 * state with parcelStatusLabel. Change both together when the app follows (build 14).
 */
export const DELIVERED_LABEL = "配達済み";
export const RECEIVED_LABEL = "受け取り済み";
/** Shown when 元に戻す put back only some of the parcels. No count: the person looks at the list. */
export const PARTLY_RESTORED_NOTICE = "受け取り済みのままの荷物があります";

export function parcelStatusLabel(status: string, receivedAt: string | null | undefined): string {
  if (status === "delivered") return receivedAt ? RECEIVED_LABEL : DELIVERED_LABEL;
  return STATUS_LABEL[status] ?? status;
}

export const RELEVANCE_LABEL: Record<string, string> = {
  order: "注文を受け付け",
  payment: "決済・手続き",
  shipped: "発送",
  out_for_delivery: "配達中",
  delivered: "配達完了",
  attempted: "不在・再配達",
  cancelled: "キャンセル",
  other_purchase: "その他の連絡",
  forwarding_confirmation: "転送の確認",
};

/** "YYYY-MM" for a date string. */
export function monthOf(ymd: string): string {
  return ymd.slice(0, 7);
}

export function monthLabel(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  const thisYear = Number(todayJst().slice(0, 4));
  return y === thisYear ? `${m}月` : `${y}年${m}月`;
}

/** The month a `?m=` names: "YYYY-MM" with a month of 01 to 12, else this month. */
export function monthParam(m: string | undefined, today: string): string {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(m ?? "") ? (m as string) : today.slice(0, 7);
}

export function shiftMonth(ym: string, delta: number): string {
  const [y, m] = ym.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1 + delta, 1));
  return t.toISOString().slice(0, 7);
}
