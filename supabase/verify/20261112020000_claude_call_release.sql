-- Run right after applying supabase/migrations/20261112020000_claude_call_release.sql.
--
-- How to apply it, in this order:
--   1. supabase/verify/20261112020000_claude_call_release.before.sql: verdict 'OK' (no negative count).
--   2. `supabase db push --dry-run`: this one file must be the only one it lists.
--   3. `supabase db push`. Not `supabase db query`: migrations and production's schema would differ.
--   4. This file: verdict 'OK'.
--   5. With the new code on dev, have Claude read one REAL mail. A sample mail, an ad, or a Gmail
--      forwarding confirmation makes no claim, so it proves nothing. Then count today's rows
--      (Japan time):
--        select count(*) from public.claude_call_claims where day = (now() at time zone 'Asia/Tokyo')::date;
--      It must be 1 or more. With 0 rows, look in the Vercel Preview logs for
--      "claim_claude_call_v2 is missing": the code fell back to the old function.
--   Locks it takes on auth.users: see the header of the migration. Rollback:
--   supabase/rollback/20261112020000_claude_call_release.down.sql (the code then falls back to the old function by itself).
--
-- Returns ONE row; go only if its verdict is 'OK'. No row (an error) counts as FAILED:
-- `supabase db query --linked -f` returns only the last result, and exits 0 even on an error.
-- Prints settings and counts only.
--
-- Leaves nothing behind: the block claims and releases on one account (an existing one, or one it
-- makes), changes day rows by hand, then undoes all of it by raising the private code 'OTRBK'.
-- Only its result survives, in a setting of this session (otodoke.verify_release) that the last
-- statement reads. It does not call Claude and sends nothing.
--
--   table_ok          claude_call_claims exists, row level security on, no privilege for anon /
--                     authenticated, service_role may read and write
--   sequence_ok       anon and authenticated may not use the claim table's id sequence
--   functions_ok      claim_claude_call_v2 and release_claude_call: security definer, search_path '',
--                     execute for service_role only; claim_claude_call is still there
--   constraint_ok     claude_usage_daily has calls >= 0, and no row is negative
--   behaviour         'OK' when, in order:
--                       claim -> ok, count +1, one ledger row
--                       release -> 1, count back to what it was
--                       release again -> 0, count unchanged
--                       release for another user -> 0, count unchanged
--                       claim at 23:59 and release at 0:01 (the claim moved to yesterday) -> 1, yesterday -1, today unchanged
--                       release when the day's count was set to 0 -> 0, count stays 0 (not negative)
--                       a negative count is refused by the table
--                       the old claim_claude_call still counts and writes no ledger row
do $$
declare
  v_user uuid;
  v_made boolean := false;
  v_day date := (now() at time zone 'Asia/Tokyo')::date;
  c0 integer; c1 integer; c2 integer; c3 integer;
  v_verdict text; v_id bigint; v_ledger integer;
  r1 integer; r2 integer; r3 integer; r4 integer; r5 integer; r6 integer;
  y0 integer; y1 integer; t0 integer; t1 integer;
  v_old text; v_ledger_after_old integer;
  v_neg_refused boolean := false;
  v_fail text := '';
begin
  select u.id into v_user from auth.users u limit 1;
  begin
    if v_user is null then
      v_user := gen_random_uuid();
      insert into auth.users (id) values (v_user);
      v_made := true;
    end if;
    select coalesce(sum(calls), 0) into c0 from public.claude_usage_daily where user_id = v_user and day = v_day;

    -- claim, release, release again, release for another user
    select * into v_verdict, v_id from public.claim_claude_call_v2(v_user, 1000000, 1000000);
    select coalesce(sum(calls), 0) into c1 from public.claude_usage_daily where user_id = v_user and day = v_day;
    select count(*) into v_ledger from public.claude_call_claims where id = v_id and user_id = v_user and day = v_day and released_at is null;
    if v_verdict is distinct from 'ok' or v_id is null or c1 <> c0 + 1 or v_ledger <> 1 then
      v_fail := v_fail || format(' claim(verdict=%s id=%s count %s->%s ledger=%s)', v_verdict, v_id, c0, c1, v_ledger);
    end if;

    r1 := public.release_claude_call(v_id, gen_random_uuid());
    select coalesce(sum(calls), 0) into c2 from public.claude_usage_daily where user_id = v_user and day = v_day;
    if r1 <> 0 or c2 <> c1 then v_fail := v_fail || format(' other_user(%s count %s->%s)', r1, c1, c2); end if;

    r2 := public.release_claude_call(v_id, v_user);
    select coalesce(sum(calls), 0) into c2 from public.claude_usage_daily where user_id = v_user and day = v_day;
    if r2 <> 1 or c2 <> c0 then v_fail := v_fail || format(' release(%s count %s->%s)', r2, c1, c2); end if;

    r3 := public.release_claude_call(v_id, v_user);
    select coalesce(sum(calls), 0) into c3 from public.claude_usage_daily where user_id = v_user and day = v_day;
    if r3 <> 0 or c3 <> c0 then v_fail := v_fail || format(' release_again(%s count %s)', r3, c3); end if;

    r4 := public.release_claude_call(-1, v_user);
    if r4 <> 0 then v_fail := v_fail || format(' unknown_id(%s)', r4); end if;

    -- a claim made before midnight, released after it: yesterday gives back, today does not
    select * into v_verdict, v_id from public.claim_claude_call_v2(v_user, 1000000, 1000000);
    select coalesce(sum(calls), 0) into t0 from public.claude_usage_daily where user_id = v_user and day = v_day;
    update public.claude_call_claims set day = v_day - 1 where id = v_id;
    insert into public.claude_usage_daily (user_id, day, calls) values (v_user, v_day - 1, 5)
      on conflict (user_id, day) do update set calls = 5;
    y0 := 5;
    r5 := public.release_claude_call(v_id, v_user);
    select calls into y1 from public.claude_usage_daily where user_id = v_user and day = v_day - 1;
    select coalesce(sum(calls), 0) into t1 from public.claude_usage_daily where user_id = v_user and day = v_day;
    if r5 <> 1 or y1 <> y0 - 1 or t1 <> t0 then v_fail := v_fail || format(' midnight(%s yesterday %s->%s today %s->%s)', r5, y0, y1, t0, t1); end if;

    -- the day's count set to 0 by hand: nothing to give back, and never negative
    select * into v_verdict, v_id from public.claim_claude_call_v2(v_user, 1000000, 1000000);
    update public.claude_usage_daily set calls = 0 where user_id = v_user and day = v_day;
    r6 := public.release_claude_call(v_id, v_user);
    select calls into t1 from public.claude_usage_daily where user_id = v_user and day = v_day;
    if r6 <> 0 or t1 <> 0 then v_fail := v_fail || format(' zero(%s count %s)', r6, t1); end if;

    -- the table refuses a negative count
    begin
      update public.claude_usage_daily set calls = -1 where user_id = v_user and day = v_day;
    exception when check_violation then
      v_neg_refused := true;
    end;
    if not v_neg_refused then v_fail := v_fail || ' negative_count_accepted'; end if;

    -- the old function counts as before and writes no ledger row
    select count(*) into v_ledger from public.claude_call_claims;
    v_old := public.claim_claude_call(v_user, 1000000, 1000000);
    select count(*) into v_ledger_after_old from public.claude_call_claims;
    if v_old is distinct from 'ok' or v_ledger_after_old <> v_ledger then v_fail := v_fail || format(' old_claim(%s ledger %s->%s)', v_old, v_ledger, v_ledger_after_old); end if;

    raise exception using errcode = 'OTRBK', message = 'undo the verify writes';
  exception when sqlstate 'OTRBK' then
    null; -- rolled back
  end;
  perform set_config('otodoke.verify_release', case when v_fail = '' then 'OK' else 'FAILED:' || v_fail end, false);
end $$;

with checks as (
  select
    (select c.relrowsecurity from pg_class c where c.oid = to_regclass('public.claude_call_claims')) is true
      and not has_table_privilege('anon', 'public.claude_call_claims', 'select,insert,update,delete')
      and not has_table_privilege('authenticated', 'public.claude_call_claims', 'select,insert,update,delete')
      and has_table_privilege('service_role', 'public.claude_call_claims', 'select')
      and has_table_privilege('service_role', 'public.claude_call_claims', 'insert')
      and has_table_privilege('service_role', 'public.claude_call_claims', 'update') as table_ok,
    not has_sequence_privilege('anon', 'public.claude_call_claims_id_seq', 'usage,select,update')
      and not has_sequence_privilege('authenticated', 'public.claude_call_claims_id_seq', 'usage,select,update') as sequence_ok,
    (select count(*) = 3 and bool_and(p.prosecdef and p.proconfig = array['search_path=""']
              and not has_function_privilege('anon', p.oid, 'execute')
              and not has_function_privilege('authenticated', p.oid, 'execute')
              and has_function_privilege('service_role', p.oid, 'execute'))
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname in ('claim_claude_call', 'claim_claude_call_v2', 'release_claude_call')) as functions_ok,
    exists (select 1 from pg_constraint where conrelid = 'public.claude_usage_daily'::regclass and conname = 'claude_usage_daily_calls_nonneg' and contype = 'c' and convalidated)
      and not exists (select 1 from public.claude_usage_daily where calls < 0) as constraint_ok,
    coalesce(current_setting('otodoke.verify_release', true), 'FAILED: the behaviour block did not run') as behaviour
)
select
  case when table_ok and sequence_ok and functions_ok and constraint_ok and behaviour = 'OK' then 'OK' else 'FAILED' end as verdict,
  checks.*
from checks;
