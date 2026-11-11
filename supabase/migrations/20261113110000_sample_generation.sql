-- Fence sample writes across requests, runtimes and devices. No long-lived lease is held:
-- every sample request locks this user's generation only for its write transaction.
begin;

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
  insert into public.sample_generations(user_id) values (p_user_id) on conflict (user_id) do nothing;
  select generation into v_generation from public.sample_generations where user_id = p_user_id for share;
  return v_generation;
end $$;

create or replace function public.lock_sample_owner(p_user_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if p_user_id is null then return; end if;
  insert into public.sample_generations(user_id) values (p_user_id) on conflict (user_id) do nothing;
  perform generation from public.sample_generations where user_id = p_user_id for update;
end $$;

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
  if p_user_id is null then raise exception 'missing clear owner' using errcode = '22023'; end if;
  insert into public.sample_generations(user_id) values (p_user_id) on conflict (user_id) do nothing;
  select generation into v_generation from public.sample_generations where user_id = p_user_id for update;
  update public.sample_generations set generation = gen_random_uuid() where user_id = p_user_id returning generation into v_generation;
  delete from public.parcels where user_id = p_user_id;
  delete from public.emails where user_id = p_user_id;
  return v_generation;
end $$;

revoke all on function public.begin_sample_load(uuid), public.clear_all_parcels(uuid), public.lock_sample_owner(uuid), public.assert_sample_generation(uuid,boolean), public.fence_sample_write(),
  public.receive_sample_parcels(uuid,uuid[],timestamptz),
  public.store_mail_run(uuid,uuid,uuid,jsonb,timestamptz,jsonb), public.mail_run_write(uuid,uuid,text,text,jsonb,jsonb),
  public.store_mail_run_without_sample_fence(uuid,uuid,uuid,jsonb,timestamptz,jsonb), public.mail_run_write_without_sample_fence(uuid,uuid,text,text,jsonb,jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.begin_sample_load(uuid), public.clear_all_parcels(uuid),
  public.receive_sample_parcels(uuid,uuid[],timestamptz),
  public.store_mail_run(uuid,uuid,uuid,jsonb,timestamptz,jsonb), public.mail_run_write(uuid,uuid,text,text,jsonb,jsonb) to service_role;
commit;
