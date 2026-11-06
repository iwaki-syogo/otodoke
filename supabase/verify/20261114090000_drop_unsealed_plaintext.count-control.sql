-- Negative control for the counting of supabase/pending/20261114090000_drop_unsealed_plaintext.sql
-- (decision 7). Run before it (or after; it changes nothing). Returns ONE row; go only if its
-- verdict is 'OK' (or 'skipped', with the reason). No row (an error) counts as FAILED:
-- `supabase db query --linked -f` returns only the last result and exits 0 even on an error.
--
-- On one account without a key in use, the block adds a throwaway read plain mail with no
-- provider id (it must be counted as to drop) and a throwaway sample (it must be counted as a
-- sample, and not as to drop: to drop goes up by one, not two), counts, and
-- undoes all of it by raising the private code 'OTRBK'. Only its result survives, in a setting of
-- this session (otodoke.verify_d7) that the last statement reads. Prints counts only.
--
-- With the trigger of supabase/pending/20261106130000 on, nothing new can be stored read and
-- plain, so the control cannot be built: verdict 'skipped' says so.

do $$
declare
  v_user uuid;
  v_before bigint;
  v_after bigint;
  v_sample_before bigint;
  v_sample_after bigint;
  v_trigger_on boolean := false;
begin
  select u.id into v_user from auth.users u
  where not exists (select 1 from public.user_keys k where k.user_id = u.id and k.activated_at is not null and k.retired_at is null)
  limit 1;
  if v_user is null then
    perform set_config('otodoke.verify_d7', 'skipped: every account has a key, or there is none', false);
    return;
  end if;
  begin
    select count(*) into v_before from public.emails e
    where e.processing_status = 'processed' and e.body_state = 'plain' and coalesce(e.provider_email_id, '') not like 'demo:%'
      and not exists (select 1 from public.user_keys k where k.user_id = e.user_id and k.activated_at is not null and k.retired_at is null);
    select count(*) into v_sample_before from public.emails e
    where e.processing_status = 'processed' and e.body_state = 'plain' and coalesce(e.provider_email_id, '') like 'demo:%';
    begin
      insert into public.emails (id, user_id, provider_email_id, message_id, processing_status, body_state, subject)
      values (gen_random_uuid(), v_user, null, '<verify-d7-real@otodoke.invalid>', 'processed', 'plain', 'verify');
    exception when check_violation then
      v_trigger_on := true;
      raise exception using errcode = 'OTRBK', message = 'trigger on: nothing new can be plain';
    end;
    insert into public.emails (id, user_id, provider_email_id, message_id, processing_status, body_state, subject)
    values (gen_random_uuid(), v_user, 'demo:verify.eml', 'demo:verify.eml', 'processed', 'plain', 'verify');
    select count(*) into v_after from public.emails e
    where e.processing_status = 'processed' and e.body_state = 'plain' and coalesce(e.provider_email_id, '') not like 'demo:%'
      and not exists (select 1 from public.user_keys k where k.user_id = e.user_id and k.activated_at is not null and k.retired_at is null);
    select count(*) into v_sample_after from public.emails e
    where e.processing_status = 'processed' and e.body_state = 'plain' and coalesce(e.provider_email_id, '') like 'demo:%';
    raise exception using errcode = 'OTRBK', message = 'undo the verify writes';
  exception when sqlstate 'OTRBK' then
    null; -- rolled back: the throwaway rows are gone
  end;
  perform set_config('otodoke.verify_d7',
    case
      when v_trigger_on then 'skipped: the trigger already refuses plain read mail'
      when v_after = v_before + 1 and v_sample_after = v_sample_before + 1 then 'OK'
      else format('FAILED: real %s->%s, sample %s->%s', v_before, v_after, v_sample_before, v_sample_after)
    end,
    false);
end $$;

with result as (
  select
    coalesce(current_setting('otodoke.verify_d7', true), 'FAILED: the block did not run') as detail,
    (select count(*) from public.emails where message_id in ('<verify-d7-real@otodoke.invalid>', 'demo:verify.eml')) as throwaway_rows_left
)
select
  case
    when throwaway_rows_left <> 0 then 'FAILED'
    when detail = 'OK' then 'OK'
    when detail like 'skipped:%' then 'skipped'
    else 'FAILED'
  end as verdict,
  result.*
from result;
