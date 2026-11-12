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
-- supabase/verify/20261114090000_drop_unsealed_plaintext.after.sql: its verdict must be 'OK'
-- (that verdict says only that nothing is left to drop and no dropped row keeps plaintext).
--
-- THE TWO NUMBERS THE OWNER SAID YES TO (the one line below the header, and nothing else to edit).
-- On the day, put the owner's two numbers into the line that starts `select set_config('otodoke.expected_users'`:
-- replace <USERS> (the number of users) and <MAILS> (the number of mails) by the digits, save the
-- result under another name, and check that `diff` against this file shows that one line and no
-- other. Run the saved file. The statement counts what it actually changes, and when the users or
-- the mails are not exactly those numbers it raises, and NOTHING is changed (the whole statement
-- is one transaction). A number left as <USERS> / <MAILS>, empty, zero or not a plain integer
-- stops it the same way: there is no default that lets it through.
-- It also stops, changing nothing, when: statement_timeout is 0 or above 2 min; a lock is not
-- obtained in 5 s; any row it did not mean to change differs after (the rows it did not change are
-- hashed whole, before and after, in the same transaction); the counts of the three kinds it must
-- keep (key in use / sample / unread) differ; any row it meant to drop still has plaintext or any
-- target is left. Its last statement prints one row: verdict 'DROPPED' with the users and mails it
-- dropped, or 'NOT_RUN' (read as: nothing was changed; look at the error above it).
--
-- What this does NOT protect (a limit, not a promise): the rows of OTHER tables (parcels,
-- extractions, ...) are not compared, only public.emails; and a user who gets a key between the
-- owner's count and this run is not synchronised with here: close the entrance and let work
-- already started finish (the apply procedure) so no key is made while it runs.
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


select set_config('otodoke.expected_users', '<USERS>', false), set_config('otodoke.expected_mails', '<MAILS>', false);

select set_config('otodoke.drop_run', gen_random_uuid()::text, false), set_config('otodoke.drop_result', '', false);

do $$
declare
  v_run text := current_setting('otodoke.drop_run');
  v_expected_users text := current_setting('otodoke.expected_users', true);
  v_expected_mails text := current_setting('otodoke.expected_mails', true);
  v_statement_timeout bigint;
  v_users bigint; v_mails bigint;
  v_keys0 bigint; v_sample0 bigint; v_unread0 bigint; v_hash0 text;
  v_keys1 bigint; v_sample1 bigint; v_unread1 bigint; v_hash1 text;
  v_ids uuid[]; v_users_done bigint; v_left bigint; v_plain bigint;
begin
  perform set_config('lock_timeout', '5s', true);
  select s.setting::bigint into v_statement_timeout from pg_settings s where s.name = 'statement_timeout';
  if v_statement_timeout = 0 or v_statement_timeout > 120000 then
    raise exception 'drop_unsealed: statement_timeout is % ms; it must be 1 ms to 2 min', v_statement_timeout using errcode = '55000';
  end if;
  -- The owner's numbers: positive plain integers, or stop. '<USERS>' / '' / null / '0' / '05' / '5 ' all stop.
  if v_expected_users is null or v_expected_users !~ '^[1-9][0-9]{0,8}$'
     or v_expected_mails is null or v_expected_mails !~ '^[1-9][0-9]{0,8}$' then
    raise exception 'drop_unsealed: the expected users / mails line was not replaced by the owner''s two numbers; nothing was changed' using errcode = '22023';
  end if;

  -- Before: the targets, the three kinds that must stay, and a hash of every row that is not a target.
  select count(*) filter (where s.target), count(distinct s.user_id) filter (where s.target),
         count(*) filter (where s.kept_key), count(*) filter (where s.kept_sample), count(*) filter (where s.kept_unread),
         md5(coalesce(string_agg(s.txt, '|' order by s.id) filter (where not s.target), ''))
    into v_mails, v_users, v_keys0, v_sample0, v_unread0, v_hash0
  from (
    select e.id, e.user_id, e::text as txt,
           e.processing_status = 'processed' and e.body_state = 'plain' and coalesce(e.provider_email_id, '') not like 'demo:%'
             and not exists (select 1 from public.user_keys k where k.user_id = e.user_id and k.activated_at is not null and k.retired_at is null) as target,
           e.processing_status = 'processed' and e.body_state = 'plain' and coalesce(e.provider_email_id, '') not like 'demo:%'
             and exists (select 1 from public.user_keys k where k.user_id = e.user_id and k.activated_at is not null and k.retired_at is null) as kept_key,
           e.processing_status = 'processed' and e.body_state = 'plain' and coalesce(e.provider_email_id, '') like 'demo:%' as kept_sample,
           e.processing_status <> 'processed' and e.body_state = 'plain' as kept_unread
    from public.emails e
  ) s;
  if v_users <> v_expected_users::bigint or v_mails <> v_expected_mails::bigint then
    raise exception 'drop_unsealed: now % users / % mails would be dropped, the owner said % / %; nothing was changed', v_users, v_mails, v_expected_users, v_expected_mails using errcode = '22023';
  end if;

  with u as (
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
    )
    returning e.id, e.user_id
  )
  select coalesce(array_agg(u.id), '{}'), count(distinct u.user_id) into v_ids, v_users_done from u;

  if cardinality(v_ids) <> v_mails or v_users_done <> v_users then
    raise exception 'drop_unsealed: changed % mails / % users, counted % / % just before; rolled back', cardinality(v_ids), v_users_done, v_mails, v_users using errcode = '55000';
  end if;

  -- After, in the same transaction: nothing left to drop, no plaintext on a dropped target, and
  -- the rows that were not changed are exactly as they were (whole-row hash) with the same three counts.
  select count(*) filter (where s.target), count(*) filter (where s.kept_key), count(*) filter (where s.kept_sample), count(*) filter (where s.kept_unread),
         md5(coalesce(string_agg(s.txt, '|' order by s.id) filter (where s.id <> all (v_ids)), '')),
         count(*) filter (where s.id = any (v_ids) and (s.leaked))
    into v_left, v_keys1, v_sample1, v_unread1, v_hash1, v_plain
  from (
    select e.id, e::text as txt,
           e.processing_status = 'processed' and e.body_state = 'plain' and coalesce(e.provider_email_id, '') not like 'demo:%'
             and not exists (select 1 from public.user_keys k where k.user_id = e.user_id and k.activated_at is not null and k.retired_at is null) as target,
           e.processing_status = 'processed' and e.body_state = 'plain' and coalesce(e.provider_email_id, '') not like 'demo:%'
             and exists (select 1 from public.user_keys k where k.user_id = e.user_id and k.activated_at is not null and k.retired_at is null) as kept_key,
           e.processing_status = 'processed' and e.body_state = 'plain' and coalesce(e.provider_email_id, '') like 'demo:%' as kept_sample,
           e.processing_status <> 'processed' and e.body_state = 'plain' as kept_unread,
           e.body_state <> 'dropped' or e.subject is not null or e.from_name is not null or e.from_address is not null
             or e.text_body is not null or e.html_body is not null or e.body_envelope is not null as leaked
    from public.emails e
  ) s;
  if v_left <> 0 or v_plain <> 0 then
    raise exception 'drop_unsealed: % targets left, % changed rows not dropped or still holding plaintext; rolled back', v_left, v_plain using errcode = '55000';
  end if;
  if v_keys1 <> v_keys0 or v_sample1 <> v_sample0 or v_unread1 <> v_unread0 or v_hash1 is distinct from v_hash0 then
    raise exception 'drop_unsealed: a row that was not to change differs (key in use % -> %, sample % -> %, unread % -> %, whole-row hash %); rolled back',
      v_keys0, v_keys1, v_sample0, v_sample1, v_unread0, v_unread1, case when v_hash1 is not distinct from v_hash0 then 'same' else 'differs' end using errcode = '55000';
  end if;

  perform set_config('otodoke.drop_result', v_run || '|' || v_users_done || '|' || cardinality(v_ids), false);
end $$;

select
  case when current_setting('otodoke.drop_result', true) like current_setting('otodoke.drop_run') || '|%' then 'DROPPED' else 'NOT_RUN' end as verdict,
  case when current_setting('otodoke.drop_result', true) like current_setting('otodoke.drop_run') || '|%'
       then split_part(current_setting('otodoke.drop_result'), '|', 2) end as users_dropped,
  case when current_setting('otodoke.drop_result', true) like current_setting('otodoke.drop_run') || '|%'
       then split_part(current_setting('otodoke.drop_result'), '|', 3) end as mails_dropped;
