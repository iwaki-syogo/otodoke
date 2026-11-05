-- The database itself refuses a read mail that is still in plaintext.
--
-- 🚨 Apply ONLY after the code that seals mail (src/lib/mail-seal.ts) is in production, and
-- after supabase/verify/20261106130000_mail_sealed_after_processing.sql says so. The code
-- before it stores every read mail in plaintext: with this trigger, every incoming mail would
-- fail and nothing would be read.
--
-- That is why this file waits in supabase/pending/: `supabase db push` applies every file in
-- supabase/migrations/, so keeping it there would apply it together with 20261106120000.
-- When the time comes: move it to supabase/migrations/ renamed with a fresh timestamp
-- (supabase/pending/README.md) and push, or run it with `supabase db query --linked -f`.
--
-- Rule, for every insert or update of public.emails whose result is processing_status
-- 'processed' and body_state 'plain':
--   - refused when the user has a key in use (the mail must be sealed), and
--   - refused when the user has no key, unless it is a public sample mail (message_id 'demo:…',
--     anonymized fixtures from the repository). A real mail is dropped instead.
-- Unread mail (pending / over_limit / failed) stays plaintext so it can be read again later.
-- Rows written before this trigger are not touched; the "暗号化する" flow seals them. Any other
-- UPDATE of such a row (read and still plain) is refused too, since its result is processed and
-- plain; nothing in the app updates a read mail except to seal it. DELETE is not affected.
-- (Checked on a local Postgres 17 on 2026-11-06: see the commit that added this line.)
--
-- Rollback: supabase/rollback/20261106130000_mail_sealed_after_processing.down.sql

create or replace function public.emails_refuse_plaintext_after_reading() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.processing_status = 'processed' and new.body_state = 'plain' then
    if exists (
      select 1 from public.user_keys k
      where k.user_id = new.user_id and k.activated_at is not null and k.retired_at is null
    ) or coalesce(new.message_id, '') not like 'demo:%' then
      raise exception 'a read mail must be sealed or dropped (email %)', new.id
        using errcode = '23514';
    end if;
  end if;
  -- Always the new row: returning old here would silently throw the write away.
  return new;
end
$$;

revoke all on function public.emails_refuse_plaintext_after_reading() from public, anon, authenticated;

create trigger emails_refuse_plaintext_after_reading
  before insert or update on public.emails
  for each row execute function public.emails_refuse_plaintext_after_reading();
