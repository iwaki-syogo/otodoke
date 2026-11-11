-- Run right after applying supabase/migrations/20261112100000_parcel_received_at.sql, in the same
-- sitting and BEFORE the app that writes received_at is deployed.
--
-- How to apply it, in this order:
--   1. supabase/verify/20261112100000_parcel_received_at.before.sql: verdict 'OK'.
--   2. `supabase db push --dry-run`: this one file must be the only one it lists.
--   3. `supabase db push`. Not `supabase db query`: migrations and production's schema would differ.
--   4. This file: verdict 'OK'.
--   Rollback: supabase/rollback/20261112100000_parcel_received_at.down.sql
--
-- Returns ONE row; go only if its verdict is 'OK'. No row (an error) counts as FAILED:
-- `supabase db query --linked -f` returns only the last result, and exits 0 even on an error.
-- Prints settings and counts only.
--
--   column_ok          parcels.received_at and parcels.check_dismissed_at exist: timestamptz, nullable
--   trigger_ok         parcels_received_at: BEFORE, FOR EACH ROW, INSERT and UPDATE, enabled; its
--                      function is SECURITY INVOKER with a fixed search_path and never says
--                      "return old"; parcels_set_updated_at is still on
--   unmoved_delivered  delivered parcels with no received_at that were last updated BEFORE the migration
--                      added the column (the time is in the column's comment). Must be 0: the backfill
--                      moved them all. A parcel the mail processing delivered after that has no
--                      received_at by design (配達済み) and is not counted, so it does not matter how
--                      long it was between applying and this file
--   delivered_since    delivered parcels with no received_at updated since then (information only)
--   comment_ok         the column's comment is exactly 'added <time>' and the time reads (no other word)
--                      The line is drawn 5 minutes before that time, for a write that began before the
--                      migration and landed after the lock was let go.
--   stray_received     parcels with received_at that are not delivered. Must be 0, always
--   behaviour          'OK' when, in order (each on a parcel of its own):
--                        as authenticated: shipped -> delivered gives received_at = now
--                        as authenticated: an insert with status delivered gives received_at = now
--                        as service_role: shipped -> delivered leaves received_at null
--                        as service_role: an insert with status delivered leaves it null
--                        as service_role: delivered again on a received parcel keeps received_at
--                        as authenticated: delivered -> shipped gives null
--                        as service_role: delivered -> cancelled gives null
--                        as authenticated: clearing received_at on a delivered parcel stays null
--                        as authenticated: shipped -> delivered with a received_at given keeps that value
--                        as authenticated: delivered -> shipped, and the status really is shipped
--                          (an update that came back as the old row would show here)
--                        received_at = '-infinity' with the status, as authenticated, on an insert and on an
--                          update: stored as null (and not filled); the status alone still fills it
--                        check_dismissed_at: set on a delivered parcel it stays through updates that
--                          keep delivered (and through receiving); it is emptied when the status
--                          leaves delivered, as authenticated (-> shipped) and as service_role (-> cancelled)
--
-- Leaves nothing behind: the block makes its rows on one account (an existing one, or one it
-- makes), switches the role the way PostgREST does, then undoes all of it by raising the private
-- code 'OTRBK'. Only its result survives, in a setting of this session
-- (otodoke.verify_received) that the last statement reads. It sends nothing.
do $$
declare
  v_user uuid;
  v_made boolean := false;
  v_p uuid;
  v_fail text := '';
  v_at timestamptz;
  v_status text;
  v_given timestamptz := timestamptz '2026-01-02 03:04:05+09';
begin
  select u.id into v_user from auth.users u limit 1;
  begin
    if v_user is null then
      v_user := gen_random_uuid();
      insert into auth.users (id) values (v_user);
      v_made := true;
    end if;
    -- What PostgREST gives a request: the claims, so that auth.uid() is this account.
    perform set_config('request.jwt.claim.sub', v_user::text, true);
    perform set_config('request.jwt.claims', json_build_object('sub', v_user, 'role', 'authenticated')::text, true);

    -- authenticated: shipped -> delivered
    insert into public.parcels (user_id, shop, status) values (v_user, 'verify', 'shipped') returning id into v_p;
    set local role authenticated;
    update public.parcels set status = 'delivered' where id = v_p;
    reset role;
    select received_at into v_at from public.parcels where id = v_p;
    if v_at is distinct from now() then v_fail := v_fail || format(' auth_update(%s)', v_at); end if;

    -- authenticated: insert as delivered
    set local role authenticated;
    insert into public.parcels (user_id, shop, status) values (v_user, 'verify', 'delivered') returning id into v_p;
    reset role;
    select received_at into v_at from public.parcels where id = v_p;
    if v_at is distinct from now() then v_fail := v_fail || format(' auth_insert(%s)', v_at); end if;

    -- service_role: shipped -> delivered, and an insert as delivered
    insert into public.parcels (user_id, shop, status) values (v_user, 'verify', 'shipped') returning id into v_p;
    set local role service_role;
    update public.parcels set status = 'delivered' where id = v_p;
    reset role;
    select received_at into v_at from public.parcels where id = v_p;
    if v_at is not null then v_fail := v_fail || format(' service_update(%s)', v_at); end if;

    set local role service_role;
    insert into public.parcels (user_id, shop, status) values (v_user, 'verify', 'delivered') returning id into v_p;
    reset role;
    select received_at into v_at from public.parcels where id = v_p;
    if v_at is not null then v_fail := v_fail || format(' service_insert(%s)', v_at); end if;

    -- service_role: delivered again on a received parcel keeps received_at
    insert into public.parcels (user_id, shop, status, received_at) values (v_user, 'verify', 'delivered', v_given) returning id into v_p;
    set local role service_role;
    update public.parcels set status = 'delivered', title = 'again' where id = v_p;
    reset role;
    select received_at into v_at from public.parcels where id = v_p;
    if v_at is distinct from v_given then v_fail := v_fail || format(' service_again(%s)', v_at); end if;

    -- authenticated: delivered -> shipped gives null, and the status really changed
    set local role authenticated;
    update public.parcels set status = 'shipped' where id = v_p;
    reset role;
    select received_at, status into v_at, v_status from public.parcels where id = v_p;
    if v_at is not null or v_status is distinct from 'shipped' then v_fail := v_fail || format(' auth_back(%s,%s)', v_at, v_status); end if;

    -- service_role: delivered -> cancelled gives null
    insert into public.parcels (user_id, shop, status, received_at) values (v_user, 'verify', 'delivered', v_given) returning id into v_p;
    set local role service_role;
    update public.parcels set status = 'cancelled' where id = v_p;
    reset role;
    select received_at, status into v_at, v_status from public.parcels where id = v_p;
    if v_at is not null or v_status is distinct from 'cancelled' then v_fail := v_fail || format(' service_cancel(%s,%s)', v_at, v_status); end if;

    -- authenticated: clearing received_at on a delivered parcel stays cleared
    insert into public.parcels (user_id, shop, status, received_at) values (v_user, 'verify', 'delivered', v_given) returning id into v_p;
    set local role authenticated;
    update public.parcels set received_at = null where id = v_p;
    reset role;
    select received_at into v_at from public.parcels where id = v_p;
    if v_at is not null then v_fail := v_fail || format(' auth_clear(%s)', v_at); end if;

    -- authenticated: shipped -> delivered with a received_at given keeps that value
    insert into public.parcels (user_id, shop, status) values (v_user, 'verify', 'shipped') returning id into v_p;
    set local role authenticated;
    update public.parcels set status = 'delivered', received_at = v_given where id = v_p;
    reset role;
    select received_at into v_at from public.parcels where id = v_p;
    if v_at is distinct from v_given then v_fail := v_fail || format(' auth_given(%s)', v_at); end if;

    -- '-infinity' says "delivered, not received" in one write: stored as null, nothing filled
    set local role authenticated;
    insert into public.parcels (user_id, shop, status, received_at) values (v_user, 'verify', 'delivered', '-infinity') returning id into v_p;
    reset role;
    select received_at into v_at from public.parcels where id = v_p;
    if v_at is not null then v_fail := v_fail || format(' infinity_insert(%s)', v_at); end if;
    insert into public.parcels (user_id, shop, status) values (v_user, 'verify', 'shipped') returning id into v_p;
    set local role authenticated;
    update public.parcels set status = 'delivered', received_at = '-infinity', title = 'x' where id = v_p;
    reset role;
    select received_at, status into v_at, v_status from public.parcels where id = v_p;
    if v_at is not null or v_status is distinct from 'delivered' then v_fail := v_fail || format(' infinity_update(%s,%s)', v_at, v_status); end if;
    -- only the status (a build that does not know the column): filled
    insert into public.parcels (user_id, shop, status) values (v_user, 'verify', 'shipped') returning id into v_p;
    set local role authenticated;
    update public.parcels set status = 'delivered' where id = v_p;
    reset role;
    select received_at into v_at from public.parcels where id = v_p;
    if v_at is distinct from now() then v_fail := v_fail || format(' status_only(%s)', v_at); end if;

    -- check_dismissed_at: kept while delivered, emptied when the status leaves delivered (any role)
    insert into public.parcels (user_id, shop, status, check_dismissed_at) values (v_user, 'verify', 'delivered', v_given) returning id into v_p;
    set local role service_role;
    update public.parcels set title = 'again' where id = v_p;
    reset role;
    select check_dismissed_at into v_at from public.parcels where id = v_p;
    if v_at is distinct from v_given then v_fail := v_fail || format(' dismissed_kept(%s)', v_at); end if;
    set local role authenticated;
    update public.parcels set received_at = v_given where id = v_p;
    reset role;
    select check_dismissed_at into v_at from public.parcels where id = v_p;
    if v_at is distinct from v_given then v_fail := v_fail || format(' dismissed_kept_on_receive(%s)', v_at); end if;
    set local role authenticated;
    update public.parcels set status = 'shipped' where id = v_p;
    reset role;
    select check_dismissed_at into v_at from public.parcels where id = v_p;
    if v_at is not null then v_fail := v_fail || format(' dismissed_auth_back(%s)', v_at); end if;
    insert into public.parcels (user_id, shop, status, check_dismissed_at) values (v_user, 'verify', 'delivered', v_given) returning id into v_p;
    set local role service_role;
    update public.parcels set status = 'cancelled' where id = v_p;
    reset role;
    select check_dismissed_at into v_at from public.parcels where id = v_p;
    if v_at is not null then v_fail := v_fail || format(' dismissed_service_cancel(%s)', v_at); end if;

    raise exception using errcode = 'OTRBK', message = 'undo the verify writes';
  exception when sqlstate 'OTRBK' then
    null; -- rolled back
  end;
  perform set_config('otodoke.verify_received', case when v_fail = '' then 'OK' else 'FAILED:' || v_fail end, false);
end $$;

with added as (
  -- The comment the migration left on the column: 'added <time>'. Only that exact shape is read.
  select c as raw, case when c ~ '^added \d{4}-\d{2}-\d{2}T\S+$' then substring(c from 'added (\S+)')::timestamptz end as at
  from (select col_description('public.parcels'::regclass, (select attnum from pg_attribute where attrelid = 'public.parcels'::regclass and attname = 'received_at')) as c) x
), checks as (
  select
    (select count(*) = 2 from information_schema.columns where table_schema = 'public' and table_name = 'parcels' and column_name in ('received_at', 'check_dismissed_at') and data_type = 'timestamp with time zone' and is_nullable = 'YES') as column_ok,
    (select at is not null from added) as comment_ok,
    coalesce((
      select count(*) = 1 and bool_and(
               t.tgenabled = 'O'
               and (t.tgtype & 1) = 1      -- FOR EACH ROW
               and (t.tgtype & 2) = 2      -- BEFORE
               and (t.tgtype & 4) = 4      -- INSERT
               and (t.tgtype & 16) = 16    -- UPDATE
               and not p.prosecdef
               and p.proconfig = array['search_path=""']
               and pg_get_functiondef(p.oid) !~* 'return\s+old')
      from pg_trigger t join pg_proc p on p.oid = t.tgfoid
      where t.tgrelid = 'public.parcels'::regclass and t.tgname = 'parcels_received_at' and not t.tgisinternal
    ), false)
    and exists (select 1 from pg_trigger t where t.tgrelid = 'public.parcels'::regclass and t.tgname = 'parcels_set_updated_at' and t.tgenabled = 'O') as trigger_ok,
    -- 5 minutes of room: a write that started before the migration may land just after it, once the lock is let go.
    (select count(*) from public.parcels where status = 'delivered' and received_at is null and updated_at < coalesce((select at from added) - interval '5 minutes', 'infinity')) as unmoved_delivered,
    (select count(*) from public.parcels where status = 'delivered' and received_at is null and updated_at >= coalesce((select at from added) - interval '5 minutes', 'infinity')) as delivered_since,
    (select count(*) from public.parcels where received_at is not null and status <> 'delivered') as stray_received,
    coalesce(current_setting('otodoke.verify_received', true), 'FAILED: the behaviour block did not run') as behaviour
)
select
  case when column_ok and comment_ok and trigger_ok and unmoved_delivered = 0 and stray_received = 0 and behaviour = 'OK' then 'OK' else 'FAILED' end as verdict,
  checks.*
from checks;
