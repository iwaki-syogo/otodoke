-- Depends on 20261113090000 cost guards and 20261113100000 parcel conflicts.
-- Uses the six-argument store_mail_run(uuid,uuid,uuid,jsonb,timestamptz,jsonb).
-- Rollback order: 110000 -> 100000 -> 090000 -> 181000 -> 180000 (full versions in down).
-- Fence sample writes across requests, runtimes and devices. No long-lived lease is held:
-- every sample request locks this user's generation only for its write transaction.
begin;
set local lock_timeout='5s';

do $$ begin
  if not coalesce(has_table_privilege(current_user,to_regclass('auth.users'),'TRIGGER'),false) then
    raise exception 'sample_generation requires TRIGGER privilege on auth.users' using errcode='55000';
  end if;
  if to_regprocedure('public.store_mail_run(uuid,uuid,uuid,jsonb,timestamptz,jsonb)') is null
    or to_regprocedure('public.mail_run_write(uuid,uuid,text,text,jsonb,jsonb)') is null
    or to_regprocedure('public.create_mail_parcel(jsonb,jsonb,jsonb,uuid,uuid)') is null
    or to_regprocedure('public.update_mail_parcel(jsonb,uuid,timestamptz,jsonb,jsonb,jsonb,uuid,uuid)') is null
    or to_regprocedure('public.ensure_mail_parcel_items(uuid,timestamptz,jsonb,uuid,uuid)') is null
    or to_regprocedure('public.mail_parcel_snapshot(uuid)') is null
    or to_regprocedure('public.claim_ai_reading_backlog(uuid,timestamptz)') is null
    or to_regprocedure('public.release_claude_call(bigint,uuid)') is null
    or to_regprocedure('public.claim_claude_call_v2(uuid,integer,integer)') is null
    or to_regprocedure('public.lock_parcel_candidates()') is null then
    raise exception 'sample_generation requires 20261113090000 six-argument store_mail_run and 20261113100000 parcel gateways' using errcode='55000';
  end if;
  -- Support only the measured baseline ACL: owner grants EXECUTE without delegation,
  -- plus service_role on public gateways (authenticated on the consent setter). A custom
  -- ACL needs a reviewed gate update; never preserve a hidden direct-core permission.
  if exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname in ('store_mail_run','mail_run_write','create_mail_parcel','update_mail_parcel','ensure_mail_parcel_items','claim_ai_reading_backlog','release_claude_call','claim_claude_call_v2','store_mail_run_without_sample_fence','mail_run_write_without_sample_fence','create_mail_parcel_without_sample_fence','update_mail_parcel_without_sample_fence','ensure_mail_parcel_items_without_sample_fence','claim_ai_reading_backlog_without_sample_fence','release_claude_call_without_sample_fence','claim_claude_call_v2_without_sample_fence','lock_sample_owner','assert_sample_generation','fence_sample_write','prelock_sample_request','prelock_sample_statement','prelock_sample_owner_delete','begin_sample_load','clear_all_parcels','receive_sample_parcels','lock_parcel_candidates','mail_parcel_snapshot','claim_claude_call','set_ai_reading') and not (select count(*)=case when p.proname in ('store_mail_run_without_sample_fence','mail_run_write_without_sample_fence','create_mail_parcel_without_sample_fence','update_mail_parcel_without_sample_fence','ensure_mail_parcel_items_without_sample_fence','claim_ai_reading_backlog_without_sample_fence','release_claude_call_without_sample_fence','claim_claude_call_v2_without_sample_fence','lock_sample_owner','assert_sample_generation','fence_sample_write','prelock_sample_request','prelock_sample_statement','prelock_sample_owner_delete') then 1 else 2 end
      and bool_and(a.grantor=p.proowner and a.privilege_type='EXECUTE' and not a.is_grantable
        and (a.grantee=p.proowner or coalesce(a.grantee=case when p.proname in ('store_mail_run_without_sample_fence','mail_run_write_without_sample_fence','create_mail_parcel_without_sample_fence','update_mail_parcel_without_sample_fence','ensure_mail_parcel_items_without_sample_fence','claim_ai_reading_backlog_without_sample_fence','release_claude_call_without_sample_fence','claim_claude_call_v2_without_sample_fence','lock_sample_owner','assert_sample_generation','fence_sample_write','prelock_sample_request','prelock_sample_statement','prelock_sample_owner_delete') then null::oid
          when p.proname='set_ai_reading' then 'authenticated'::regrole::oid else 'service_role'::regrole::oid end,false)))
    from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a)) then
    raise exception 'sample_generation: nonstandard function ACL; review its migration gate' using errcode='55000';
  end if;
end $$;

create table if not exists public.sample_generations (
  user_id uuid primary key references auth.users(id) on delete cascade,
  generation uuid not null default gen_random_uuid()
);
alter table public.sample_generations enable row level security;
revoke all on public.sample_generations from public, anon, authenticated, service_role;
alter table public.emails add column if not exists sample_generation uuid;

-- Existing unread samples can still be resumed, using the generation of their stored row.
insert into public.sample_generations(user_id)
  select distinct user_id from public.emails where provider_email_id like 'demo:%'
  on conflict (user_id) do nothing;
update public.emails e set sample_generation = g.generation
  from public.sample_generations g
  where e.user_id = g.user_id and e.provider_email_id like 'demo:%' and e.sample_generation is null;

create or replace function public.begin_sample_load(p_user_id uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_generation uuid;
begin
  if p_user_id is null then raise exception 'missing sample owner' using errcode = '22023'; end if;
  perform id from auth.users where id=p_user_id for key share;
  if not found then raise exception 'sample owner no longer exists' using errcode='23503'; end if;
  insert into public.sample_generations(user_id) values (p_user_id) on conflict (user_id) do nothing;
  select generation into v_generation from public.sample_generations where user_id = p_user_id for share;
  return v_generation;
end $$;

create or replace function public.lock_sample_owner(p_user_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if p_user_id is null then return; end if;
  -- Auth deletion holds this row before its cascades. Acquire the same parent first so a
  -- generation owner cannot later wait for its own parent FK behind a deleting transaction.
  perform id from auth.users where id=p_user_id for key share;
  if not found then raise exception 'sample owner no longer exists' using errcode='23503'; end if;
  insert into public.sample_generations(user_id) values (p_user_id) on conflict (user_id) do nothing;
  perform generation from public.sample_generations where user_id = p_user_id for update;
end $$;

-- A deleting parent already owns auth.users; take an existing generation before any FK
-- cascade reaches email/parcel rows. Never create generation state during deletion.
create or replace function public.prelock_sample_owner_delete() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  perform generation from public.sample_generations where user_id=old.id for update;
  perform id from public.emails where user_id=old.id order by id for update;
  return old;
end $$;
drop trigger if exists sample_generation_owner_delete on auth.users;
create trigger sample_generation_owner_delete before delete on auth.users
  for each row execute function public.prelock_sample_owner_delete();

create or replace function public.assert_sample_generation(p_user_id uuid, p_required boolean default false) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_headers jsonb := coalesce(nullif(current_setting('request.headers', true), ''), '{}')::jsonb;
  v_stated text; v_owner text; v_generation uuid;
begin
  v_stated := v_headers->>'x-otodoke-sample-generation';
  v_owner := v_headers->>'x-otodoke-sample-user';
  if v_stated is null and v_owner is null and not p_required then return null; end if;
  if v_stated is null or v_owner is null or v_owner is distinct from p_user_id::text then
    raise exception 'sample generation or owner is missing' using errcode = '55000';
  end if;
  -- Same lock as clear, acquired BEFORE any mail row lock by both service RPC wrappers.
  select generation into v_generation from public.sample_generations where user_id = p_user_id for update;
  if not found or v_stated is distinct from v_generation::text then
    raise exception 'sample load was cleared; load it again' using errcode = '55000';
  end if;
  return v_generation;
end $$;

-- Statement boundaries run before any parcel row lock and before the global candidate lock.
-- Direct authenticated writes know their owner through auth.uid(); sample requests carry it.
create or replace function public.prelock_sample_request() returns void
language plpgsql security definer set search_path='' as $$
declare
  v_headers jsonb := coalesce(nullif(current_setting('request.headers',true),''),'{}')::jsonb;
  v_owner uuid;
begin
  if v_headers ? 'x-otodoke-sample-generation' or v_headers ? 'x-otodoke-sample-user' then
    if coalesce(v_headers->>'x-otodoke-sample-user','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception 'sample generation or owner is missing' using errcode='55000';
    end if;
    v_owner := (v_headers->>'x-otodoke-sample-user')::uuid;
    if current_setting('role',true) = 'authenticated' and v_owner is distinct from auth.uid() then
      raise exception 'sample owner must match authenticated user' using errcode='42501';
    end if;
    perform public.lock_sample_owner(v_owner);
    perform public.assert_sample_generation(v_owner,true);
  elsif current_setting('role',true) = 'authenticated' then
    v_owner := auth.uid();
    if v_owner is not null then perform public.lock_sample_owner(v_owner); end if;
  end if;
end $$;

create or replace function public.prelock_sample_statement() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  perform public.prelock_sample_request();
  return null;
end $$;

create or replace function public.lock_parcel_candidates() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  perform public.prelock_sample_request();
  perform pg_catalog.pg_advisory_xact_lock(62803,0);
  return null;
end $$;

drop trigger if exists sample_generation_statement_fence on public.emails;
create trigger sample_generation_statement_fence before insert or update or delete on public.emails
  for each statement execute function public.prelock_sample_statement();
drop trigger if exists sample_generation_statement_fence on public.extractions;
create trigger sample_generation_statement_fence before insert or update or delete on public.extractions
  for each statement execute function public.prelock_sample_statement();

create or replace function public.fence_sample_write() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_owner uuid; v_generation uuid; v_required boolean := false;
begin
  if tg_op = 'DELETE' then v_owner := old.user_id; else v_owner := new.user_id; end if;
  if tg_table_name = 'emails' and tg_op = 'INSERT' then
    v_required := new.provider_email_id like 'demo:%';
  end if;
  v_generation := public.assert_sample_generation(v_owner, coalesce(v_required, false));
  if tg_op = 'UPDATE' then
    if v_generation is not null and old.user_id is distinct from new.user_id then
      raise exception 'sample owner cannot change' using errcode = '42501';
    end if;
    if tg_table_name = 'emails' then
      if old.sample_generation is distinct from new.sample_generation then
        raise exception 'stored sample generation cannot change' using errcode = '42501';
      end if;
    end if;
  end if;
  if tg_table_name = 'emails' and tg_op = 'INSERT' and v_required then new.sample_generation := v_generation; end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;

drop trigger if exists sample_generation_fence on public.emails;
create trigger sample_generation_fence before insert or update or delete on public.emails
  for each row execute function public.fence_sample_write();
drop trigger if exists sample_generation_fence on public.parcels;
create trigger sample_generation_fence before insert or update or delete on public.parcels
  for each row execute function public.fence_sample_write();
drop trigger if exists sample_generation_fence on public.extractions;
create trigger sample_generation_fence before insert or update or delete on public.extractions
  for each row execute function public.fence_sample_write();
drop trigger if exists sample_generation_fence on public.parcel_items;
create trigger sample_generation_fence before insert or update or delete on public.parcel_items
  for each row execute function public.fence_sample_write();

-- Preserve the established ABI and implementation, putting the generation lock before its
-- global-intake/mail-row locks. The core RPCs are no longer directly executable by any API role.
do $$ begin
  if to_regprocedure('public.store_mail_run_without_sample_fence(uuid,uuid,uuid,jsonb,timestamptz,jsonb)') is null then
    alter function public.store_mail_run(uuid,uuid,uuid,jsonb,timestamptz,jsonb) rename to store_mail_run_without_sample_fence;
  end if;
  if to_regprocedure('public.mail_run_write_without_sample_fence(uuid,uuid,text,text,jsonb,jsonb)') is null then
    alter function public.mail_run_write(uuid,uuid,text,text,jsonb,jsonb) rename to mail_run_write_without_sample_fence;
  end if;
  if to_regprocedure('public.create_mail_parcel_without_sample_fence(jsonb,jsonb,jsonb,uuid,uuid)') is null then
    alter function public.create_mail_parcel(jsonb,jsonb,jsonb,uuid,uuid) rename to create_mail_parcel_without_sample_fence;
  end if;
  if to_regprocedure('public.update_mail_parcel_without_sample_fence(jsonb,uuid,timestamptz,jsonb,jsonb,jsonb,uuid,uuid)') is null then
    alter function public.update_mail_parcel(jsonb,uuid,timestamptz,jsonb,jsonb,jsonb,uuid,uuid) rename to update_mail_parcel_without_sample_fence;
  end if;
  if to_regprocedure('public.ensure_mail_parcel_items_without_sample_fence(uuid,timestamptz,jsonb,uuid,uuid)') is null then
    alter function public.ensure_mail_parcel_items(uuid,timestamptz,jsonb,uuid,uuid) rename to ensure_mail_parcel_items_without_sample_fence;
  end if;
  if to_regprocedure('public.claim_ai_reading_backlog_without_sample_fence(uuid,timestamptz)') is null then
    alter function public.claim_ai_reading_backlog(uuid,timestamptz) rename to claim_ai_reading_backlog_without_sample_fence;
  end if;
  if to_regprocedure('public.release_claude_call_without_sample_fence(bigint,uuid)') is null then
    alter function public.release_claude_call(bigint,uuid) rename to release_claude_call_without_sample_fence;
  end if;
  if to_regprocedure('public.claim_claude_call_v2_without_sample_fence(uuid,integer,integer)') is null then
    alter function public.claim_claude_call_v2(uuid,integer,integer) rename to claim_claude_call_v2_without_sample_fence;
  end if;
end $$;

-- Standalone v2 updates usage before inserting its auth-owned ledger. The pipeline already
-- owns this prefix; direct service calls need it too. All argument/limit verdicts stay in core.
create or replace function public.claim_claude_call_v2(p_user_id uuid,p_user_limit integer,p_global_limit integer)
returns table(verdict text,claim_id bigint)
language plpgsql security definer set search_path='' as $$
begin
  perform id from auth.users where id=p_user_id for key share;
  return query select * from public.claim_claude_call_v2_without_sample_fence(p_user_id,p_user_limit,p_global_limit);
end $$;

-- A release updates claim -> usage while deletion cascades usage -> claim. Lock their parent
-- first; the core still distinguishes invalid arguments, a missing claim and a real release.
create or replace function public.release_claude_call(p_claim_id bigint,p_user_id uuid) returns integer
language plpgsql security definer set search_path='' as $$
begin
  if p_claim_id is null or p_user_id is null then
    return public.release_claude_call_without_sample_fence(p_claim_id,p_user_id);
  end if;
  perform id from auth.users where id=p_user_id for key share;
  if not found then return 0; end if;
  return public.release_claude_call_without_sample_fence(p_claim_id,p_user_id);
end $$;

-- Claiming the initial journal used to hold consent while awaiting the auth-parent FK.
-- The parent prefix excludes deletion first. The explicit consent lock keeps the established
-- verification contract and is re-entrant when the preserved core validates the same row.
create or replace function public.claim_ai_reading_backlog(p_user_id uuid,p_decided_at timestamptz) returns boolean
language plpgsql security definer set search_path='' as $$
begin
  if p_user_id is null or p_decided_at is null then return false; end if;
  perform id from auth.users where id=p_user_id for key share;
  if not found then return false; end if;
  perform user_id from public.ai_reading_consents where user_id=p_user_id for update;
  return public.claim_ai_reading_backlog_without_sample_fence(p_user_id,p_decided_at);
end $$;

create or replace function public.store_mail_run(
  p_user_id uuid, p_email_id uuid, p_run_id uuid, p_columns jsonb,
  p_expected_created_at timestamptz, p_limits jsonb
) returns table (verdict text, email_id uuid)
language plpgsql security definer set search_path = '' as $$
begin
  perform public.lock_sample_owner(p_user_id);
  perform public.assert_sample_generation(p_user_id, coalesce(p_columns->>'provider_email_id' like 'demo:%', false));
  return query select * from public.store_mail_run_without_sample_fence(p_user_id,p_email_id,p_run_id,p_columns,p_expected_created_at,p_limits);
end $$;

create or replace function public.mail_run_write(
  p_email_id uuid, p_run_id uuid, p_table text, p_operation text, p_values jsonb, p_filters jsonb
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_user_id uuid; v_sample boolean;
begin
  -- Read to learn the owner, then generation -> mail. A clear between this read and the lock
  -- invalidates the generation; a deleted mail is rejected again by the existing core RPC.
  select user_id, coalesce(provider_email_id like 'demo:%', false) into v_user_id, v_sample
    from public.emails where id = p_email_id;
  perform public.lock_sample_owner(v_user_id);
  perform public.assert_sample_generation(v_user_id, coalesce(v_sample, false));
  return public.mail_run_write_without_sample_fence(p_email_id,p_run_id,p_table,p_operation,p_values,p_filters);
end $$;

create or replace function public.create_mail_parcel(
  p_snapshot jsonb, p_values jsonb, p_items jsonb, p_email_id uuid default null, p_run_id uuid default null
) returns table(verdict text,parcel_id uuid)
language plpgsql security definer set search_path='' as $$
declare v_user_id uuid; v_sample boolean;
begin
  select user_id,coalesce(provider_email_id like 'demo:%',false) into v_user_id,v_sample from public.emails where id=p_email_id;
  perform public.lock_sample_owner(v_user_id);
  perform public.assert_sample_generation(v_user_id,coalesce(v_sample,false));
  return query select * from public.create_mail_parcel_without_sample_fence(p_snapshot,p_values,p_items,p_email_id,p_run_id);
end $$;

create or replace function public.update_mail_parcel(
  p_snapshot jsonb, p_parcel_id uuid, p_expected_updated_at timestamptz, p_values jsonb, p_category jsonb, p_items jsonb,
  p_email_id uuid default null, p_run_id uuid default null
) returns table(verdict text,parcel_id uuid,parcel_row jsonb)
language plpgsql security definer set search_path='' as $$
declare v_user_id uuid; v_sample boolean;
begin
  select user_id,coalesce(provider_email_id like 'demo:%',false) into v_user_id,v_sample from public.emails where id=p_email_id;
  perform public.lock_sample_owner(v_user_id);
  perform public.assert_sample_generation(v_user_id,coalesce(v_sample,false));
  return query select * from public.update_mail_parcel_without_sample_fence(p_snapshot,p_parcel_id,p_expected_updated_at,p_values,p_category,p_items,p_email_id,p_run_id);
end $$;

create or replace function public.ensure_mail_parcel_items(
  p_parcel_id uuid, p_expected_updated_at timestamptz, p_items jsonb, p_email_id uuid default null, p_run_id uuid default null
) returns table(verdict text)
language plpgsql security definer set search_path='' as $$
declare v_user_id uuid; v_sample boolean;
begin
  select user_id,coalesce(provider_email_id like 'demo:%',false) into v_user_id,v_sample from public.emails where id=p_email_id;
  perform public.lock_sample_owner(v_user_id);
  perform public.assert_sample_generation(v_user_id,coalesce(v_sample,false));
  return query select * from public.ensure_mail_parcel_items_without_sample_fence(p_parcel_id,p_expected_updated_at,p_items,p_email_id,p_run_id);
end $$;

create or replace function public.receive_sample_parcels(p_user_id uuid, p_parcel_ids uuid[], p_received_at timestamptz) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform public.lock_sample_owner(p_user_id);
  perform public.assert_sample_generation(p_user_id, true);
  update public.parcels p set received_at = p_received_at
    where p.user_id = p_user_id and p.id = any(p_parcel_ids) and p.status = 'delivered' and p.received_at is null
    and exists(select 1 from public.extractions x join public.emails e on e.id = x.email_id
      where x.parcel_id = p.id and x.user_id = p_user_id and e.user_id = p_user_id and e.provider_email_id like 'demo:%');
end $$;

create or replace function public.clear_all_parcels(p_user_id uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_generation uuid;
begin
  perform public.lock_sample_owner(p_user_id);
  if p_user_id is null then raise exception 'missing clear owner' using errcode = '22023'; end if;
  insert into public.sample_generations(user_id) values (p_user_id) on conflict (user_id) do nothing;
  select generation into v_generation from public.sample_generations where user_id = p_user_id for update;
  update public.sample_generations set generation = gen_random_uuid() where user_id = p_user_id returning generation into v_generation;
  perform id from public.emails where user_id=p_user_id order by id for update;
  delete from public.parcels where user_id = p_user_id;
  delete from public.emails where user_id = p_user_id;
  return v_generation;
end $$;

revoke all on function public.begin_sample_load(uuid), public.clear_all_parcels(uuid), public.lock_sample_owner(uuid), public.assert_sample_generation(uuid,boolean), public.fence_sample_write(),
  public.receive_sample_parcels(uuid,uuid[],timestamptz),
  public.store_mail_run(uuid,uuid,uuid,jsonb,timestamptz,jsonb), public.mail_run_write(uuid,uuid,text,text,jsonb,jsonb),
  public.store_mail_run_without_sample_fence(uuid,uuid,uuid,jsonb,timestamptz,jsonb), public.mail_run_write_without_sample_fence(uuid,uuid,text,text,jsonb,jsonb)
  from public, anon, authenticated, service_role;
revoke all on function public.prelock_sample_request(), public.prelock_sample_statement(), public.prelock_sample_owner_delete(),
  public.claim_ai_reading_backlog(uuid,timestamptz), public.claim_ai_reading_backlog_without_sample_fence(uuid,timestamptz),
  public.release_claude_call(bigint,uuid), public.release_claude_call_without_sample_fence(bigint,uuid),
  public.claim_claude_call_v2(uuid,integer,integer), public.claim_claude_call_v2_without_sample_fence(uuid,integer,integer),
  public.create_mail_parcel(jsonb,jsonb,jsonb,uuid,uuid), public.update_mail_parcel(jsonb,uuid,timestamptz,jsonb,jsonb,jsonb,uuid,uuid), public.ensure_mail_parcel_items(uuid,timestamptz,jsonb,uuid,uuid),
  public.create_mail_parcel_without_sample_fence(jsonb,jsonb,jsonb,uuid,uuid), public.update_mail_parcel_without_sample_fence(jsonb,uuid,timestamptz,jsonb,jsonb,jsonb,uuid,uuid), public.ensure_mail_parcel_items_without_sample_fence(uuid,timestamptz,jsonb,uuid,uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.begin_sample_load(uuid), public.clear_all_parcels(uuid),
  public.claim_ai_reading_backlog(uuid,timestamptz),
  public.release_claude_call(bigint,uuid),
  public.claim_claude_call_v2(uuid,integer,integer),
  public.receive_sample_parcels(uuid,uuid[],timestamptz),
  public.store_mail_run(uuid,uuid,uuid,jsonb,timestamptz,jsonb), public.mail_run_write(uuid,uuid,text,text,jsonb,jsonb) to service_role;
grant execute on function public.create_mail_parcel(jsonb,jsonb,jsonb,uuid,uuid), public.update_mail_parcel(jsonb,uuid,timestamptz,jsonb,jsonb,jsonb,uuid,uuid), public.ensure_mail_parcel_items(uuid,timestamptz,jsonb,uuid,uuid) to service_role;
commit;
