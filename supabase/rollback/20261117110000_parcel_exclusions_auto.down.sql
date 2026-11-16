-- Rollback of 20261117110000_parcel_exclusions_auto.sql.
-- ORDER: put the Web (and any iOS build) back to the stage-1 build FIRST. A stage-2 Web calls the functions dropped here
-- (has_open_auto_exclusion, mark_auto_excluded_seen, auto_exclusion_would_start, excluded_parcels_unseen); every such call fails once they are gone.
-- Ingestion that calls mark_rule_exclusion must be back to the stage-1 build too.
-- The seen times are lost. The automatic ("rule") marks are REMOVED (their number is printed as a NOTICE): stage-1 clients have no list-bottom
-- row for them, so they would stay hidden without any notice. The marks the people pressed (kind='user') stay.
-- restore_parcel goes back to its stage-1 body (an unmarked parcel is 'gone' again).
begin;
set local lock_timeout='5s';

do $down_gate$
declare v_owner oid := (select relowner from pg_class where oid=to_regclass('public.emails'));
begin
  if v_owner is null or (select oid from pg_roles where rolname=current_user) is distinct from v_owner then
    raise exception 'parcel exclusions auto rollback must run as the existing application owner' using errcode='55000';
  end if;
  if to_regclass('public.excluded_seen') is null
    or to_regprocedure('public.mark_rule_exclusion(uuid,uuid,text,text)') is null
    or to_regprocedure('public.exclude_parcel(uuid)') is null then
    raise exception 'parcel exclusions auto are not applied; nothing to roll back' using errcode='55000';
  end if;
end $down_gate$;

do $down_rule$
declare v_rule bigint;
begin
  select count(*) into v_rule from public.parcel_exclusions where kind='rule';
  delete from public.parcel_exclusions where kind='rule';
  raise notice 'removed % automatic marks (kind=rule); the pressed marks (kind=user) stay', v_rule;
end $down_rule$;

create or replace function public.restore_parcel(p_parcel_id uuid) returns text
language plpgsql security definer set search_path='' as $$
declare v_user uuid; v_id uuid;
begin
  v_user := auth.uid();
  if v_user is null then raise exception 'signed in owner required' using errcode='42501'; end if;
  if p_parcel_id is null then return 'gone'; end if;
  perform public.lock_sample_owner(v_user);
  perform public.lock_parcel_owner(v_user);
  perform p.id from public.parcels p where p.id=p_parcel_id and p.user_id=v_user for update;
  if not found then return 'gone'; end if;
  delete from public.parcel_exclusions x where x.parcel_id=p_parcel_id and x.user_id=v_user returning x.parcel_id into v_id;
  if v_id is null then return 'gone'; end if;
  return 'ok';
end $$;
revoke all on function public.restore_parcel(uuid) from public, anon, authenticated, service_role;
grant execute on function public.restore_parcel(uuid) to authenticated;

drop function if exists public.has_open_auto_exclusion();
drop function if exists public.mark_auto_excluded_seen(timestamptz);
drop function if exists public.excluded_parcels_unseen();
drop function if exists public.auto_exclusion_would_start(uuid);
drop function if exists public.mark_rule_exclusion(uuid,uuid,text,text);
drop table if exists public.excluded_seen;

commit;
