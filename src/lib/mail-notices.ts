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
 * those words (the coordinator's wording of 2026-11-06 22:40; no brackets, the owner's rule). Its
 * second half is the notice the screens have said since the review fixes of 2026-11-06.
 *
 * Used in: 設定's password panel (src/app/app/settings/password-panel.tsx, to a user with
 * plaintext mail and no key), 「あなたのメールの扱い」 (mail-handling.tsx), /privacy and README.
 * Reword all of them once the pending SQL has run.
 */
export const PLAINTEXT_DROP_NOTICE = "パスワードでログインしていない場合は、11 月 14 日に件名・差出人・本文を消します。荷物は残ります。";
