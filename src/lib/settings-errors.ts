/**
 * What /app/settings?error=<code> may say. The query carries only a code; the words come from
 * here, so a crafted link cannot put its own text on the settings page (next to the passphrase).
 * The actions log the database's own message on the server instead of putting it in the URL.
 */
export const SETTINGS_ERROR_MESSAGES = {
  demo_failed: "サンプルを最後まで読み込めませんでした。もう一度お試しください。",
  read_failed: "読み取れなかったメールがあります。少し時間をおいて、もう一度お試しください。",
  flag_failed: "記録できませんでした。もう一度お試しください。",
  clear_confirm: "「本当に消す」にチェックを入れてください",
  clear_failed: "消せませんでした。もう一度お試しください。",
} as const;

export type SettingsErrorCode = keyof typeof SETTINGS_ERROR_MESSAGES;

/** Shown for a code this version does not know (an old link, or one somebody typed). */
export const UNKNOWN_SETTINGS_ERROR = "うまくいきませんでした。もう一度お試しください。";

export function settingsErrorPath(code: SettingsErrorCode, extra = ""): string {
  return `/app/settings?error=${code}${extra}`;
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
