-- A person's explicit choice before any real mail is sent to Anthropic.
-- No backfill: an absent row means undecided, including for existing accounts.
-- Deploy the server consent guard and this migration together. The table alone cannot stop
-- an older server which does not read it; a guard deployed first treats a missing table as unknown.
-- Verify: supabase/verify/20261112180000_ai_reading_consent.sql
-- Rollback removes recorded choices; see the private application runbook before using it.

begin;
set local lock_timeout = '5s';

create table public.ai_reading_consents (
  user_id uuid primary key references auth.users(id) on delete cascade,
  decision text not null check (decision in ('granted', 'declined')),
  decided_at timestamptz not null default now(),
  text_version text not null
);

alter table public.ai_reading_consents enable row level security;
revoke all on public.ai_reading_consents from public, anon, authenticated, service_role;
grant select on public.ai_reading_consents to authenticated, service_role;

create policy ai_reading_consents_read_own on public.ai_reading_consents
  for select to authenticated using ((select auth.uid()) = user_id);

-- SECURITY DEFINER is required: authenticated has no direct write privilege. The only row
-- named comes from the verified JWT (auth.uid), never a caller-supplied user id. The empty
-- search_path and qualified names keep caller-controlled objects out of the write.
-- Any nonblank version can be recorded; a future version does not itself revoke a choice.
create function public.set_ai_reading(p_decision text, p_text_version text)
returns table (decision text, decided_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_decision text;
  v_decided_at timestamptz;
begin
  if v_user is null then
    raise exception 'set_ai_reading: a signed-in user is required' using errcode = '42501';
  end if;
  if p_decision is null or p_decision not in ('granted', 'declined') then
    raise exception 'set_ai_reading: invalid decision' using errcode = '22023';
  end if;
  if p_text_version is null or btrim(p_text_version) = '' then
    raise exception 'set_ai_reading: a text version is required' using errcode = '22023';
  end if;

  insert into public.ai_reading_consents as c (user_id, decision, decided_at, text_version)
  values (v_user, p_decision, now(), p_text_version)
  on conflict (user_id) do update
    set decision = excluded.decision, decided_at = now(), text_version = excluded.text_version
  returning c.decision, c.decided_at into v_decision, v_decided_at;

  if v_decision is distinct from p_decision or v_decided_at is distinct from now() then
    raise exception 'set_ai_reading: the choice was not recorded as asked' using errcode = '42501';
  end if;
  return query select v_decision, v_decided_at;
end;
$$;

revoke all on function public.set_ai_reading(text, text) from public, anon, authenticated, service_role;
grant execute on function public.set_ai_reading(text, text) to authenticated;

commit;
