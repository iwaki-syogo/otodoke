/**
 * Sentences that more than one place tells in the same words, kept here once so that the screens,
 * the mails and the documents cannot drift apart unseen. Each constant names where it is used; the
 * tests that read those places import it from here.
 *
 * The mails cannot import: supabase/templates/*.html carry the words themselves, and
 * src/lib/__tests__/auth-mail-templates.test.ts checks them against these.
 */

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
