import { stripInvisible } from "@/lib/text/html-to-text";

/**
 * Sentences that more than one place tells in the same words, kept here once so that the screens,
 * the mails and the documents cannot drift apart unseen. Each constant names where it is used; the
 * tests that read those places import it from here.
 *
 * The mails cannot import: supabase/templates/*.html carry the words themselves, and
 * src/lib/__tests__/auth-mail-templates.test.ts checks them against these.
 */

/** What a mail with no body says, in the sealed mail and in the plain one. */
export const NO_BODY_TEXT = "本文はありません。";

/** Wording contract for an expired original mail; the native view must use the same notice. */
export const CONSENT_WAIT_EXPIRED_NOTICE = "保管の期限を過ぎたため、元のメールは残っていません。";

/** Ordinary unread storage, shared by settings and privacy; consent waiting has its own deadline. */
export const UNREAD_MAIL_STORAGE_NOTICE = "1 日の上限を超えた分など、読み取る前のメールは、読み取るまで暗号化せずに置いておきます。";

/**
 * What a mail with no subject says: in the list of mail not read (設定), in the plain mail of a
 * parcel's history and in the sealed mail once it is opened. Never for a sealed mail that is not
 * open yet: its subject is in the envelope, not unknown.
 */
export const NO_SUBJECT_TEXT = "件名はありません。";

/**
 * Whether a subject counts as none: empty, blank, or only characters that draw nothing (U+200B and
 * the like, which trim() keeps). The one test behind NO_SUBJECT_TEXT; the subject shown is still
 * the string as it came.
 */
export function isBlankSubject(subject: string | null | undefined): boolean {
  return stripInvisible(subject ?? "").trim() === "";
}

/**
 * What a reset costs (decision 3). The key that opens the stored mail is wrapped with a key made
 * from the password (docs/crypto/password-v1.md), so a new password cannot open what the old one
 * wrapped. Changing the password while knowing the current one wraps the same key again and keeps
 * the mail (that is not this sentence).
 *
 * Used in: supabase/templates/recovery.html, the new password page (/reset-password), 設定
 * 「あなたのメールの扱い」 (src/app/app/settings/mail-handling.tsx), /privacy and README.
 */
export const RESET_LOSES_MAIL = "パスワードを決め直すと、前に暗号化して保存したメールは開けなくなります。荷物は残ります。";

/**
 * Decision 7 (supabase/pending/20261114090000_drop_unsealed_plaintext.sql): on 2026-11-14 the
 * plaintext subject, sender and body of read mail go, for every user with no key in use. The key
 * is made in the browser when the user signs in with the password, so the sentence says it in
 * those words (no brackets). Its
 * second half is the notice the screens have said since the review fixes of 2026-11-06.
 *
 * Used in: 設定's password panel (src/app/app/settings/password-panel.tsx, to a user with
 * no key), 「あなたのメールの扱い」 (mail-handling.tsx), /privacy and README.
 * Reword all of them once the pending SQL has run.
 */
export const PLAINTEXT_DROP_NOTICE = "パスワードでログインすると、暗号化前に読み取った実メールを順に暗号化します。鍵がないまま残る分は、11 月 14 日に件名・差出人・本文を消す予定です。荷物と、お使いのメールの受信箱は、そのままです。";
