import { READ_FAILED_NOTICE, READ_OVER_LIMIT_NOTICE, READ_UNAVAILABLE_NOTICE } from "@/lib/read-notices";

/**
 * What ?error=<code> on the 設定 pages (/app/settings/demo, /trouble, /dropped) may say. The query
 * carries only a code; the words come from here, so a crafted link cannot put its own text on a
 * settings page.
 * The actions log the database's own message on the server instead of putting it in the URL.
 */
export const SETTINGS_ERROR_MESSAGES = {
  demo_failed: "サンプルを最後まで読み込めませんでした。もう一度お試しください。",
  read_failed: READ_FAILED_NOTICE,
  read_unavailable: READ_UNAVAILABLE_NOTICE,
  read_over_limit: READ_OVER_LIMIT_NOTICE,
  // Provisional Web wording: acknowledging a notice does not attempt to read any mail.
  notice_confirm_failed: "通知を閉じられませんでした。もう一度お試しください。",
  flag_failed: "記録できませんでした。もう一度お試しください。",
  clear_confirm: "「本当に消す」にチェックを入れてください",
  clear_failed: "消せませんでした。もう一度お試しください。",
} as const;

export type SettingsErrorCode = keyof typeof SETTINGS_ERROR_MESSAGES;

/** Shown for a code this version does not know (an old link, or one somebody typed). */
export const UNKNOWN_SETTINGS_ERROR = "うまくいきませんでした。もう一度お試しください。";

/** The page that shows each code: the one whose action failed. */
export const SETTINGS_ERROR_PAGES: Record<SettingsErrorCode, string> = {
  demo_failed: "/app/settings/demo",
  clear_confirm: "/app/settings/demo",
  clear_failed: "/app/settings/demo",
  read_failed: "/app/settings/trouble",
  read_unavailable: "/app/settings/trouble",
  read_over_limit: "/app/settings/trouble",
  notice_confirm_failed: "/app/settings/trouble",
  flag_failed: "/app/settings/dropped",
};

export function settingsErrorPath(code: SettingsErrorCode, extra = ""): string {
  return `${SETTINGS_ERROR_PAGES[code]}?error=${code}${extra}`;
}

/** The message for a query value; null when there is no error to show. */
export function settingsErrorMessage(code: string | undefined): string | null {
  if (!code) return null;
  return Object.hasOwn(SETTINGS_ERROR_MESSAGES, code) ? SETTINGS_ERROR_MESSAGES[code as SettingsErrorCode] : UNKNOWN_SETTINGS_ERROR;
}

/** ?demo=<count>: a number only, never text from the link. */
export function demoCount(value: string | undefined): number | null {
  return value && /^\d{1,3}$/.test(value) ? Number(value) : null;
}
