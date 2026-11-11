-- Roll back only with intake/re-reads stopped, the matching old application ready,
-- and every request drained for 300 seconds. This restores the former race-prone
-- paid allowance: do not reopen publicly until a corrected release is applied.
-- Notice metadata and lease tokens are removed. No email body is removed.
-- Re-runnable. Run as a single file; lock timeout leaves the transaction unchanged.
begin;
set local lock_timeout='5s';
drop function if exists public.mail_run_write(uuid,uuid,text,text,jsonb,jsonb);
drop function if exists public.store_mail_run(uuid,uuid,uuid,jsonb,timestamptz,jsonb);
drop table if exists public.mail_intake_notices;
drop index if exists public.emails_unread_storage_idx;
alter table public.emails drop column if exists processing_run_id;
alter table public.emails drop column if exists processing_lease_until;
create or replace function public.claim_claude_call(p_user_id uuid, p_user_limit integer, p_global_limit integer)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_day date := (now() at time zone 'Asia/Tokyo')::date;
  v_calls integer;
begin
  if (select coalesce(sum(calls), 0) from public.claude_usage_daily where day = v_day) >= p_global_limit then
    return 'global_limit';
  end if;

  insert into public.claude_usage_daily as u (user_id, day, calls)
  values (p_user_id, v_day, 1)
  on conflict (user_id, day) do update
    set calls = u.calls + 1
    where u.calls < p_user_limit
  returning calls into v_calls;

  if v_calls is null then
    return 'user_limit';
  end if;
  return 'ok';
end;
$$;

revoke all on function public.claim_claude_call(uuid, integer, integer) from public, anon, authenticated;
grant execute on function public.claim_claude_call(uuid, integer, integer) to service_role;

create or replace function public.claim_claude_call_v2(p_user_id uuid, p_user_limit integer, p_global_limit integer)
returns table (verdict text, claim_id bigint)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_day date := (now() at time zone 'Asia/Tokyo')::date;
  v_calls integer;
  v_id bigint;
  v_id_day date;
begin
  if p_user_id is null then
    raise exception 'claim_claude_call_v2: a user is required' using errcode = '22023';
  end if;

  -- Prune what no release looks at any more (older than yesterday). SKIP LOCKED: never wait on
  -- another call's prune.
  delete from public.claude_call_claims
  where id in (
    select id from public.claude_call_claims
    where day < v_day - 1
    order by id
    limit 500
    for update skip locked
  );

  if (select coalesce(sum(calls), 0) from public.claude_usage_daily where day = v_day) >= p_global_limit then
    return query select 'global_limit'::text, null::bigint;
    return;
  end if;

  insert into public.claude_usage_daily as u (user_id, day, calls)
  values (p_user_id, v_day, 1)
  on conflict (user_id, day) do update
    set calls = u.calls + 1
    where u.calls < p_user_limit
  returning calls into v_calls;

  if v_calls is null then
    return query select 'user_limit'::text, null::bigint;
    return;
  end if;

  insert into public.claude_call_claims (user_id, day) values (p_user_id, v_day)
  returning id, day into v_id, v_id_day;
  -- Read back what was written: the ledger row must exist, on the day the count was taken from.
  if v_id is null or v_id_day is distinct from v_day then
    raise exception 'claim_claude_call_v2: the claim was not recorded as asked' using errcode = 'XX000';
  end if;
  return query select 'ok'::text, v_id;
end;
$$;

revoke all on function public.claim_claude_call_v2(uuid, integer, integer) from public, anon, authenticated;
grant execute on function public.claim_claude_call_v2(uuid, integer, integer) to service_role;

-- Give back one claim. Returns 1 when one call was taken off the count of the day the claim was made
-- on, 0 when there was nothing to give back (see the list above). Only the row with this id and this
-- user is touched, and only once.
create or replace function public.release_claude_call(p_claim_id bigint, p_user_id uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_day date;
  v_released timestamptz;
  v_before integer;
  v_after integer;
begin
  if p_claim_id is null or p_user_id is null then
    raise exception 'release_claude_call: expected a claim id and a user' using errcode = '22023';
  end if;

  -- The one place that decides "once": a second call, also one running at the same time, waits for
  -- this row and then finds released_at set.
  update public.claude_call_claims
  set released_at = now()
  where id = p_claim_id and user_id = p_user_id and released_at is null
  returning day, released_at into v_day, v_released;
  if not found then
    return 0;
  end if;
  if v_released is null then
    raise exception 'release_claude_call: the claim was not marked released' using errcode = 'XX000';
  end if;

  select calls into v_before from public.claude_usage_daily
  where user_id = p_user_id and day = v_day
  for update;
  if v_before is null or v_before <= 0 then
    return 0; -- the count is gone or was set to 0 by hand: never below 0
  end if;

  update public.claude_usage_daily set calls = calls - 1
  where user_id = p_user_id and day = v_day
  returning calls into v_after;
  if v_after is distinct from v_before - 1 then
    raise exception 'release_claude_call: the count did not go from % to %', v_before, v_before - 1 using errcode = 'XX000';
  end if;
  return 1;
end;
$$;

revoke all on function public.release_claude_call(bigint, uuid) from public, anon, authenticated;
grant execute on function public.release_claude_call(bigint, uuid) to service_role;


commit;
