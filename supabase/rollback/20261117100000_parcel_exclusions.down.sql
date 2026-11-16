-- Rollback of 20261117100000_parcel_exclusions.sql.
-- Every mark is lost: parcels that were hidden become visible again. Run only when that is intended.
-- The two receipt functions are put back to their 130000 bodies by removing exactly the four added conditions.
begin;
set local lock_timeout='5s';

do $down_gate$
declare v_owner oid := (select relowner from pg_class where oid=to_regclass('public.emails'));
begin
  if v_owner is null or (select oid from pg_roles where rolname=current_user) is distinct from v_owner then
    raise exception 'parcel exclusions rollback must run as the existing application owner' using errcode='55000';
  end if;
  if to_regclass('public.parcel_exclusions') is null
    or to_regprocedure('public.exclude_parcel(uuid)') is null
    or to_regprocedure('public.mark_parcels_received(uuid[])') is null
    or to_regprocedure('public.restore_parcel_receipts(jsonb)') is null then
    raise exception 'parcel exclusions are not applied; nothing to roll back' using errcode='55000';
  end if;
end $down_gate$;

-- Un-hide first, then put the functions back, then drop the table (the policy reads it).
drop policy if exists "hide excluded parcels" on public.parcels;

do $down_functions$
declare
  v_added constant text := ' and not exists(select 1 from public.parcel_exclusions e where e.parcel_id=p.id)';
  v_def text;
begin
  foreach v_def in array array[pg_get_functiondef('public.mark_parcels_received(uuid[])'::regprocedure),
    pg_get_functiondef('public.restore_parcel_receipts(jsonb)'::regprocedure)] loop
    execute replace(v_def,v_added,'');
  end loop;
end $down_functions$;

revoke all on function public.mark_parcels_received(uuid[]),public.restore_parcel_receipts(jsonb) from public,anon,authenticated,service_role;
grant execute on function public.mark_parcels_received(uuid[]),public.restore_parcel_receipts(jsonb) to authenticated;

drop function if exists public.exclude_parcel(uuid);
drop function if exists public.restore_parcel(uuid);
drop function if exists public.excluded_parcels();
drop table if exists public.parcel_exclusions;
drop function if exists public.parcel_exclusion_owner_check();

commit;
