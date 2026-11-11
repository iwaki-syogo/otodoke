/**
 * What the app says when Claude is stopped, the daily allowance is used up, or a mail could not be
 * read. Kept here once so the screens and the tests read the same words (like mail-notices.ts).
 * No date, and no "Claude" / "API" / "クレジット": the person sees what to do, not why.
 */

/** 「うまく届かないとき」: a reason for the waiting mail, shown only when it applies. */
export const READ_STOPPED_REASON = "メールの読み取りは停止中です。荷物を手で登録しますか？";
export const READ_STOPPED_BUTTON = "荷物を登録";
export const READ_OVER_LIMIT_REASON = "今日の読み取り上限に達しました。明日の0時から読み取れます。";
export const READ_FAILED_REASON = "読み取れなかったメールがあります。時間をおいて読み取りますか？";

/** After 「読み取る」 (?error=<code> on /app/settings/trouble). */
export const READ_UNAVAILABLE_NOTICE = "メールの読み取りは停止中です。";
export const READ_OVER_LIMIT_NOTICE = "今日の読み取り上限に達しました。残りは明日の0時から読み取れます。";
export const READ_FAILED_NOTICE = "読み取れなかったメールがあります。時間をおいてお試しください。";
