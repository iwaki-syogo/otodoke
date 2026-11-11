-- Give back the allowance of a Claude call that was refused, so a stop at Claude does not use up the day.
--
-- Why: claim_claude_call takes one call from today's allowance (300 for the app, 30 for a person)
-- BEFORE Claude is asked, and keeps it when the call fails. When Claude stops (no credit, a spend
-- limit, a key that is refused), every mail that arrives meanwhile spends one, and once Claude is
-- back the day's allowance is gone for everybody (over_limit).
--
-- How: claim_claude_call_v2 counts exactly as claim_claude_call does (the same day in Asia/Tokyo,
-- the app-wide sum first, then the person's row, the same upsert), and also writes a row to
-- claude_call_claims and returns its id. release_claude_call(id, user) marks that row released and
-- takes ONE off the count of the day the claim was made on. The app calls it only when Claude is
-- stopped (claude_unavailable: no credit, a spend limit, a refused key), which is never billed:
-- see src/lib/claude-usage.ts.
--
-- claim_claude_call is NOT changed and stays in place: code that does not know the new functions
-- keeps working, and so does the new code before this file is applied (it falls back to it).
--
-- What release_claude_call does with a release that is legitimate but has nothing to give back
-- (all of these return 0, change nothing more and do not raise):
--   - the same claim released twice, also two calls at once: the second finds released_at set
--   - a claim of somebody else, an id that never existed, or a row already pruned (older than 2 days)
--   - an account deleted meanwhile: its ledger rows go with it (on delete cascade), its calls stay in
--     the day's count as claude_usage_keeps_deleted_calls intends
--   - the day's count was set to 0 by hand (or the row is gone): the claim is marked released, and
--     the count is never taken below 0
-- A release after midnight (Asia/Tokyo) gives back to the day the claim was made on.
--
-- claude_usage_daily gets calls >= 0. Check first that no row is negative (supabase/verify/
-- 20261112020000_claude_call_release.before.sql); otherwise this file fails and changes nothing.
--
-- One transaction of its own. Locks: the new table's reference to auth.users takes a
-- ShareRowExclusiveLock on auth.users (measured on Postgres 17 when written; re-measured in
-- the local run of 2026-11-11), so sign-ups and the updates that sign-ins make to auth.users wait
-- while this transaction holds it; adding the check constraint also needs a short lock on
-- claude_usage_daily. lock_timeout is 5 s: if a lock cannot be had, this fails, changes nothing,
-- and is run again later.
-- Re-runnable.
-- After applying: supabase/verify/20261112020000_claude_call_release.sql
-- Rollback:       supabase/rollback/20261112020000_claude_call_release.down.sql

begin;
set local lock_timeout = '5s';

create table if not exists public.claude_call_claims (
  id          bigint generated always as identity primary key,
  user_id     uuid not null references auth.users(id) on delete cascade,
  day         date not null,
  claimed_at  timestamptz not null default now(),
  released_at timestamptz
);
create index if not exists claude_call_claims_day_idx on public.claude_call_claims(day);
create index if not exists claude_call_claims_user_idx on public.claude_call_claims(user_id);

alter table public.claude_call_claims enable row level security;
revoke all on public.claude_call_claims from public, anon, authenticated;
grant select, insert, update, delete on public.claude_call_claims to service_role;
-- The id sequence: no use for anon or authenticated (the table's revoke does not cover it).
revoke all on sequence public.claude_call_claims_id_seq from public, anon, authenticated;

do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.claude_usage_daily'::regclass and conname = 'claude_usage_daily_calls_nonneg') then
    alter table public.claude_usage_daily add constraint claude_usage_daily_calls_nonneg check (calls >= 0);
  end if;
end $$;

-- Take one call from today's allowance, as claim_claude_call does. One row back: verdict 'ok' with
-- claim_id = the id of the recorded claim, or 'user_limit' / 'global_limit' with claim_id null.
-- Nothing is recorded unless the verdict is 'ok'.
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
