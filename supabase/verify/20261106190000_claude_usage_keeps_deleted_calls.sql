-- Run right after applying supabase/migrations/20261106190000_claude_usage_keeps_deleted_calls.sql.
-- Returns ONE row; go only if its verdict is 'OK'. No row (an error) counts as FAILED:
-- `supabase db query --linked -f` returns only the last result, and exits 0 even on an error.
-- Prints settings and counts only.
--
-- Leaves nothing behind: the block calls claim_claude_call on one account and adds a row with no
-- user, then undoes all of it by raising the private code 'OTRBK'. Only its result survives, in a
-- setting of this session (otodoke.verify_usage) that the last statement reads. It deletes no
-- account: what happens on a delete is read from the catalog (set_null), and was run on a local
-- Postgres 17 when the migration was written.
--
--   set_null              exactly one reference to auth.users, and it is on delete set null
--   user_id_nullable      user_id may be null
--   unique_user_day       a unique constraint on (user_id, day), and no primary key left
--   claim_unchanged       claim_claude_call: security definer, search_path '', execute for
--                         service_role only
--   behaviour             'OK': the claim still counts per user (ok, then user_limit at the limit)
--                         and a row with no user counts towards the global limit
--                         ('skipped: ...' when there is no account)
do $$
declare
  v_user uuid;
  v_day date := (now() at time zone 'Asia/Tokyo')::date;
  v_first text;
  v_at_limit text;
  v_global text;
  v_sum integer;
begin
  select u.id into v_user from auth.users u limit 1;
  if v_user is null then
    perform set_config('otodoke.verify_usage', 'skipped: no account yet', false);
    return;
  end if;
  begin
    v_first := public.claim_claude_call(v_user, 1000000, 1000000);
    v_at_limit := public.claim_claude_call(v_user, (select calls from public.claude_usage_daily where user_id = v_user and day = v_day), 1000000);
    begin
      insert into public.claude_usage_daily (user_id, day, calls) values (null, v_day, 7);
    exception when not_null_violation then
      v_global := 'a row with no user is refused';
      raise exception using errcode = 'OTRBK', message = 'the migration is not in place';
    end;
    select coalesce(sum(calls), 0) into v_sum from public.claude_usage_daily where day = v_day;
    -- The global limit at exactly today's sum, the row with no user in it: refused.
    v_global := public.claim_claude_call(v_user, 1000000, v_sum);
    raise exception using errcode = 'OTRBK', message = 'undo the verify writes';
  exception when sqlstate 'OTRBK' then
    null; -- rolled back
  end;
  perform set_config('otodoke.verify_usage',
    case when v_first = 'ok' and v_at_limit = 'user_limit' and v_global = 'global_limit' then 'OK'
         else format('FAILED: first=%s at_limit=%s global=%s', v_first, v_at_limit, v_global) end,
    false);
end $$;

with checks as (
  select
    (select count(*) from pg_constraint where conrelid = 'public.claude_usage_daily'::regclass and contype = 'f' and confrelid = 'auth.users'::regclass) = 1
      and (select bool_and(confdeltype = 'n') from pg_constraint where conrelid = 'public.claude_usage_daily'::regclass and contype = 'f' and confrelid = 'auth.users'::regclass) as set_null,
    not (select attnotnull from pg_attribute where attrelid = 'public.claude_usage_daily'::regclass and attname = 'user_id') as user_id_nullable,
    exists (select 1 from pg_constraint where conrelid = 'public.claude_usage_daily'::regclass and contype = 'u'
              and conkey = array[(select attnum from pg_attribute where attrelid = 'public.claude_usage_daily'::regclass and attname = 'user_id'),
                                 (select attnum from pg_attribute where attrelid = 'public.claude_usage_daily'::regclass and attname = 'day')]::smallint[])
      and not exists (select 1 from pg_constraint where conrelid = 'public.claude_usage_daily'::regclass and contype = 'p') as unique_user_day,
    (select p.prosecdef and p.proconfig = array['search_path=""']
              and not has_function_privilege('anon', p.oid, 'execute')
              and not has_function_privilege('authenticated', p.oid, 'execute')
              and has_function_privilege('service_role', p.oid, 'execute')
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'claim_claude_call') as claim_unchanged,
    coalesce(current_setting('otodoke.verify_usage', true), 'FAILED: the behaviour block did not run') as behaviour
)
select
  case when set_null and user_id_nullable and unique_user_day and claim_unchanged
            and (behaviour = 'OK' or behaviour like 'skipped:%') then 'OK' else 'FAILED' end as verdict,
  checks.*
from checks;
