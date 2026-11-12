-- Negative control for the counting of supabase/pending/20261114090000_drop_unsealed_plaintext.sql
-- (decision 7). Returns ONE row; go only if its verdict is 'OK' (or 'skipped', with the reason).
-- No row (an error) counts as FAILED: `supabase db query --linked -f` returns only the last
-- result and exits 0 even on an error.
--
-- 🚨 This is NOT read only. It WRITES to the production emails table (and, for the sample
-- generation fence, to public.sample_generations), then ALWAYS rolls those writes back by
-- raising the private code 'OTRBK' inside the block; a normal run never commits them. While it
-- runs, it takes the locks of those writes (the account's row, its sample generation), so that
-- account's own writes wait for it. Run it only in the window where the entrance is closed and
-- drained (the apply procedure), never while the app is taking mail.
--
-- On one account without a key in use, the block adds a throwaway read plain mail with no
-- provider id (it must be counted as to drop) and a throwaway sample (it must be counted as a
-- sample, and not as to drop: to drop goes up by one, not two), counts, and undoes all of it.
-- The counts are of THAT account's rows only (user_id = the account), so another account's
-- mail arriving or being sealed meanwhile cannot make a wrong count look right.
--
-- Time limits, set before the first write, and set from inside the block with set_config(..., true)
-- so they end with the statement (success or failure) and nothing is left on the session:
--   - lock_timeout 3 s: every wait for a lock (the first insert, the foreign key to auth.users,
--     the sample generation row) gives up after 3 s. The block then fails and changes nothing.
--   - statement_timeout: a limit set from inside a running statement does not bound that
--     statement, so it is READ, not set. If it is 0 (no limit) or above 2 min, the block stops
--     before any write with a FAILED verdict.
--
-- Only its result survives, in settings of this session. The result carries a run mark made at
-- the top of THIS run (otodoke.verify_d7_run), and the last statement accepts a result only if it
-- carries that mark: an 'OK' left by an earlier run on the same connection is never read.
--
-- The sample insert needs the sample generation fence of 20261113110000 satisfied (see below).
-- With the trigger of supabase/pending/20261106130000 on, nothing new can be stored read and
-- plain, so the control cannot be built: verdict 'skipped' says so.

select set_config('otodoke.verify_d7_run', gen_random_uuid()::text, false),
       set_config('otodoke.verify_d7', '', false);

do $$
declare
  v_user uuid;
  v_before bigint;
  v_after bigint;
  v_sample_before bigint;
  v_sample_after bigint;
  v_trigger_on boolean := false;
  v_generation uuid;
  v_run text := current_setting('otodoke.verify_d7_run');
  v_statement_timeout bigint;
begin
  -- Before any write. lock_timeout is read at every lock wait, so setting it here binds the
  -- waits below; the setting ends with this statement, whether it succeeds or fails.
  perform set_config('lock_timeout', '3s', true);
  select s.setting::bigint into v_statement_timeout from pg_settings s where s.name = 'statement_timeout';
  if v_statement_timeout = 0 or v_statement_timeout > 120000 then
    perform set_config('otodoke.verify_d7', v_run || '|' || format('FAILED: statement_timeout is %s ms; it must be 1 ms to 2 min', v_statement_timeout), false);
    return;
  end if;
  select u.id into v_user from auth.users u
  where not exists (select 1 from public.user_keys k where k.user_id = u.id and k.activated_at is not null and k.retired_at is null)
  limit 1;
  if v_user is null then
    perform set_config('otodoke.verify_d7', v_run || '|skipped: every account has a key, or there is none', false);
    return;
  end if;
  begin
    select count(*) into v_before from public.emails e
    where e.user_id = v_user and e.processing_status = 'processed' and e.body_state = 'plain' and coalesce(e.provider_email_id, '') not like 'demo:%'
      and not exists (select 1 from public.user_keys k where k.user_id = e.user_id and k.activated_at is not null and k.retired_at is null);
    select count(*) into v_sample_before from public.emails e
    where e.user_id = v_user and e.processing_status = 'processed' and e.body_state = 'plain' and coalesce(e.provider_email_id, '') like 'demo:%';
    begin
      insert into public.emails (id, user_id, provider_email_id, message_id, processing_status, body_state, subject)
      values (gen_random_uuid(), v_user, null, '<verify-d7-real@otodoke.invalid>', 'processed', 'plain', 'verify');
    exception when check_violation then
      v_trigger_on := true;
      raise exception using errcode = 'OTRBK', message = 'trigger on: nothing new can be plain';
    end;
    -- 20261113110000 refuses a demo: insert that does not carry the user's sample generation.
    -- begin_sample_load(user) returns the generation (it adds the user's row only inside this
    -- rolled back block, and takes FOR SHARE on it); the headers below are what the fence reads.
    -- Both the settings and any new generation row go away with the OTRBK rollback.
    v_generation := public.begin_sample_load(v_user);
    perform set_config('request.headers',
      jsonb_build_object('x-otodoke-sample-generation', v_generation::text, 'x-otodoke-sample-user', v_user::text)::text, true);
    insert into public.emails (id, user_id, provider_email_id, message_id, processing_status, body_state, subject)
    values (gen_random_uuid(), v_user, 'demo:verify.eml', 'demo:verify.eml', 'processed', 'plain', 'verify');
    select count(*) into v_after from public.emails e
    where e.user_id = v_user and e.processing_status = 'processed' and e.body_state = 'plain' and coalesce(e.provider_email_id, '') not like 'demo:%'
      and not exists (select 1 from public.user_keys k where k.user_id = e.user_id and k.activated_at is not null and k.retired_at is null);
    select count(*) into v_sample_after from public.emails e
    where e.user_id = v_user and e.processing_status = 'processed' and e.body_state = 'plain' and coalesce(e.provider_email_id, '') like 'demo:%';
    raise exception using errcode = 'OTRBK', message = 'undo the verify writes';
  exception when sqlstate 'OTRBK' then
    null; -- rolled back: the throwaway rows are gone
  end;
  perform set_config('otodoke.verify_d7',
    v_run || '|' || case
      when v_trigger_on then 'skipped: the trigger already refuses plain read mail'
      when v_after = v_before + 1 and v_sample_after = v_sample_before + 1 then 'OK'
      else format('FAILED: real %s->%s, sample %s->%s', v_before, v_after, v_sample_before, v_sample_after)
    end,
    false);
end $$;

with result as (
  select
    current_setting('otodoke.verify_d7_run') as run,
    coalesce(current_setting('otodoke.verify_d7', true), '') as raw,
    (select count(*) from public.emails where message_id in ('<verify-d7-real@otodoke.invalid>', 'demo:verify.eml')) as throwaway_rows_left
), judged as (
  select
    case when raw like run || '|%' then substr(raw, length(run) + 2)
         else 'FAILED: the block did not run (no result carrying this run''s mark)' end as detail,
    throwaway_rows_left
  from result
)
select
  case
    when throwaway_rows_left <> 0 then 'FAILED'
    when detail = 'OK' then 'OK'
    when detail like 'skipped:%' then 'skipped'
    else 'FAILED'
  end as verdict,
  judged.*
from judged;
