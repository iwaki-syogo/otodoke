/**
 * The words of 「これは荷物ではありません」 on the Web. Each sentence says who did what: おとどけは… / あなたが….
 * Taking a parcel out and putting it back fail with different sentences, so the person knows which one did not happen.
 */

/** The button on the parcel page. */
export const EXCLUDE_BUTTON_LABEL = "これは荷物ではありません";
/** The notice on the list right after taking a parcel out. */
export const EXCLUDED_TOAST = "おとどけは、この荷物を一覧と支出から外しました";
/** Taking out failed (on the parcel page). */
export const EXCLUDE_FAILED = "おとどけは、この荷物を外せませんでした。もう一度お試しください";
/** The notice after 「元に戻す」 worked. */
export const RESTORED_TOAST = "おとどけは、この荷物を一覧と支出に戻しました";
/** Putting back failed (the notice on the list, and the row on the page of taken-out parcels). */
export const RESTORE_FAILED = "おとどけは、この荷物を一覧に戻せませんでした";

/** The way in from the end of the list. No count: the number is seen after opening the page. */
export const EXCLUDED_PAGE_LABEL = "外した荷物";
export const EXCLUDED_PAGE_TITLE = "外した荷物";
export const EXCLUDED_EMPTY = "外した荷物はありません";
export const EXCLUDED_BY_USER = "あなたが外しました";
export const EXCLUDED_BY_RULE = "おとどけが自動で外しました";
export const RESTORE_BUTTON_LABEL = "一覧に戻す";
