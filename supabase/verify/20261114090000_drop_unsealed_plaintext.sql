-- Read only. Counts, never a subject, an address or a body.
-- For supabase/pending/20261114090000_drop_unsealed_plaintext.sql (decision 7).

-- Part "before" (run first): what the update would remove, and what it would leave.
--   to_drop                   read, plain, not a sample, the user has no key in use  -> dropped
--   kept_user_has_key         read, plain, the user has a key in use (「暗号化する」 seals these)
--   kept_sample               read, plain, a public sample mail
--   kept_unread               unread, plain (sealed or dropped when read)
--   users_to_drop             how many users lose plaintext
select
  count(*) filter (where e.processing_status = 'processed' and e.body_state = 'plain'
                     and coalesce(e.provider_email_id, '') not like 'demo:%' and k.user_id is null) as to_drop,
  count(*) filter (where e.processing_status = 'processed' and e.body_state = 'plain'
                     and coalesce(e.provider_email_id, '') not like 'demo:%' and k.user_id is not null) as kept_user_has_key,
  count(*) filter (where e.processing_status = 'processed' and e.body_state = 'plain'
                     and coalesce(e.provider_email_id, '') like 'demo:%') as kept_sample,
  count(*) filter (where e.processing_status <> 'processed' and e.body_state = 'plain') as kept_unread,
  count(distinct e.user_id) filter (where e.processing_status = 'processed' and e.body_state = 'plain'
                     and coalesce(e.provider_email_id, '') not like 'demo:%' and k.user_id is null) as users_to_drop
from public.emails e
left join public.user_keys k on k.user_id = e.user_id and k.activated_at is not null and k.retired_at is null;

-- Part "after": go only if to_drop_left is 0 and the others match part "before".
--   to_drop_left              must be 0
--   dropped_with_plaintext    must be 0 (a dropped row keeps none of the five)
--   kept_sample / kept_user_has_key / kept_unread: the same as before
select
  count(*) filter (where e.processing_status = 'processed' and e.body_state = 'plain'
                     and coalesce(e.provider_email_id, '') not like 'demo:%' and k.user_id is null) as to_drop_left,
  count(*) filter (where e.body_state = 'dropped'
                     and (e.subject is not null or e.from_name is not null or e.from_address is not null
                          or e.text_body is not null or e.html_body is not null)) as dropped_with_plaintext,
  count(*) filter (where e.processing_status = 'processed' and e.body_state = 'plain'
                     and coalesce(e.provider_email_id, '') like 'demo:%') as kept_sample,
  count(*) filter (where e.processing_status = 'processed' and e.body_state = 'plain'
                     and coalesce(e.provider_email_id, '') not like 'demo:%' and k.user_id is not null) as kept_user_has_key,
  count(*) filter (where e.processing_status <> 'processed' and e.body_state = 'plain') as kept_unread
from public.emails e
left join public.user_keys k on k.user_id = e.user_id and k.activated_at is not null and k.retired_at is null;

-- Negative control for the count itself (run before or after; writes nothing): one throwaway row of
-- each kind, inside a block undone by raising 'OTRBK', must land in to_drop / kept_* as named.
-- Prints "drop_unsealed_plaintext count: OK" or raises "... FAILED".
do $$
declare
  v_user uuid;
  v_before bigint;
  v_after bigint;
  v_sample_before bigint;
  v_sample_after bigint;
begin
  select u.id into v_user from auth.users u
  where not exists (select 1 from public.user_keys k where k.user_id = u.id and k.activated_at is not null and k.retired_at is null)
  limit 1;
  if v_user is null then
    raise notice 'drop_unsealed_plaintext count: skipped (every account has a key, or there is none)';
    return;
  end if;
  begin
    select count(*) into v_before from public.emails e
    where e.processing_status = 'processed' and e.body_state = 'plain' and coalesce(e.provider_email_id, '') not like 'demo:%'
      and not exists (select 1 from public.user_keys k where k.user_id = e.user_id and k.activated_at is not null and k.retired_at is null);
    select count(*) into v_sample_before from public.emails e
    where e.processing_status = 'processed' and e.body_state = 'plain' and coalesce(e.provider_email_id, '') like 'demo:%';
    -- With the trigger of 20261106130000 on, the real one is refused: then this control is moot.
    begin
      insert into public.emails (id, user_id, provider_email_id, message_id, processing_status, body_state, subject)
      values (gen_random_uuid(), v_user, null, '<verify-d7-real@otodoke.invalid>', 'processed', 'plain', 'verify');
    exception when check_violation then
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
    null;
  end;
  if v_after is null then
    raise notice 'drop_unsealed_plaintext count: skipped (the trigger already refuses plain read mail)';
  elsif v_after = v_before + 1 and v_sample_after = v_sample_before + 1 then
    raise notice 'drop_unsealed_plaintext count: OK (a real plain mail with a null provider id is counted; a sample is not)';
  else
    raise exception 'drop_unsealed_plaintext count FAILED: real %->%, sample %->%', v_before, v_after, v_sample_before, v_sample_after;
  end if;
end $$;
