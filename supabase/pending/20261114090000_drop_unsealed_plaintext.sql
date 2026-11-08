-- Decision 7 (2026-11-06): the plaintext subject, sender and body that users with no mail key in
-- use left behind are removed on 2026-11-14. Since the password sign-in (password-v1) the key is
-- made when a user signs in with the password, so users are told it as "not signed in with the
-- password". Their parcels stay; the original mail does not come back. A one-off data change,
-- written ahead and NOT applied.
--
-- 🚨 Not applied yet, and not to be applied without the owner's YES on the day. Before running:
--   1. supabase/verify/20261114090000_drop_unsealed_plaintext.before.sql: the counts of what this
--      removes, by user state (one row). Look at them; nothing here can be undone. And
--      supabase/verify/20261114090000_drop_unsealed_plaintext.count-control.sql: its verdict must
--      be 'OK' (the counting itself finds what it should).
--   2. Users must have been told, with the date, in the one sentence of src/lib/mail-notices.ts
--      (PLAINTEXT_DROP_NOTICE): 設定's src/app/app/settings/password-panel.tsx (to a user with
--      plaintext mail and no key), mail-handling.tsx (「あなたのメールの扱い」), the privacy policy
--      (src/app/privacy/page.tsx) and README.md's 「あなたのメールの扱い」. Check that all of them
--      are in production well before the day.
--   Decision 8 (supabase/pending/20261107090000_retire_passphrase_keys.sql) retires the keys made
--   with a passphrase: until such a user signs in with a password, they count here as having no
--   key, and their read plaintext mail goes too.
-- Run with `supabase db query --linked -f` (or move to supabase/migrations/ renamed with a fresh
-- timestamp, supabase/pending/README.md). Then
-- supabase/verify/20261114090000_drop_unsealed_plaintext.after.sql: its verdict must be 'OK'.
--
-- What it touches: read mail (processing_status 'processed') still 'plain', of a user with no key
-- in use, that is not a public sample (provider_email_id 'demo:…', anonymized fixtures).
-- What it leaves:
--   - unread mail (pending / over_limit / failed): kept so it can be read again; it is sealed or
--     dropped when read (the code does that).
--   - users who have a key in use: their plaintext is sealed with 「暗号化する」, not dropped here.
--   - the public sample mails.
--   - from_domain, message_id, forwarding_confirm_url, the parcel data and the readings.
--
-- Gmail's forwarding confirmation stored before 20261106120000 has its approval link only in the
-- body (forwarding_confirm_url was added then). It is moved into that column in the same update,
-- as the automatic sealing does (src/lib/mail-keys.ts sealPlainBatch), so 設定's 「承認ページを開く」 stays.
-- The pattern matches Google's page only; the settings page checks the link again
-- (src/lib/forwarding.ts) before it shows the button.
--
-- How: body_state 'dropped' and all five plaintext columns null, in ONE update. Once the trigger
-- of supabase/pending/20261106130000 is on, an UPDATE that only nulls the body of a read plain
-- row is refused (23514); this one turns the row into 'dropped' and so passes it (checked on a
-- local Postgres 17). The sender's domain is kept first where it was never filled in. Every
-- expression on the right reads the row as it was before this update.

update public.emails e
set from_domain = coalesce(e.from_domain, nullif(lower(trim(split_part(e.from_address, '@', 2))), '')),
    forwarding_confirm_url = coalesce(
      e.forwarding_confirm_url,
      case when e.classification = 'forwarding_confirmation' then
        coalesce(
          substring(e.text_body from '(?i)https://mail-settings\.google\.com/mail/[^[:space:]<>"'')]*'),
          substring(e.html_body from '(?i)https://mail-settings\.google\.com/mail/[^[:space:]<>"'')]*')
        )
      end
    ),
    body_state = 'dropped',
    body_envelope = null,
    subject = null,
    from_name = null,
    from_address = null,
    text_body = null,
    html_body = null
where e.processing_status = 'processed'
  and e.body_state = 'plain'
  and coalesce(e.provider_email_id, '') not like 'demo:%'
  and not exists (
    select 1 from public.user_keys k
    where k.user_id = e.user_id and k.activated_at is not null and k.retired_at is null
  );
