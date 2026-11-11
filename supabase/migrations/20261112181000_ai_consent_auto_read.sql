-- Start the waiting real mail once per recorded grant, even across server processes.
-- Depends on 20261112180000_ai_reading_consent.sql. Existing choices are not backfilled or run.
-- A failed automatic read keeps its claim: an explicit manual read is the retry path.
-- A stale grant response after withdrawal cannot claim; a later grant may claim again.
-- Same decision and same text version preserve the choice's timestamp. Any nonblank future
-- version remains valid and records a new choice, rather than being refused by a fixed allowlist.

begin;
set local lock_timeout = '5s';

create table public.ai_consent_read_runs (
  user_id uuid primary key references auth.users(id) on delete cascade,
  consent_decided_at timestamptz not null
);
alter table public.ai_consent_read_runs enable row level security;
revoke all on public.ai_consent_read_runs from public, anon, authenticated, service_role;

-- An UPSERT locks the same consent row as claim_ai_reading_backlog's FOR UPDATE. A duplicate
-- grant does not create a new automatic run; a changed choice/version does. The server clock
-- and a one-microsecond floor distinguish changes even in one transaction or after a clock jump.
create or replace function public.set_ai_reading(p_decision text, p_text_version text)
returns table (decision text, decided_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_decision text;
  v_decided_at timestamptz;
  v_text_version text;
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
  values (v_user, p_decision, clock_timestamp(), p_text_version)
  on conflict (user_id) do update
    set decision = excluded.decision,
        decided_at = case
          when c.decision = excluded.decision and c.text_version = excluded.text_version then c.decided_at
          else greatest(clock_timestamp(), c.decided_at + interval '1 microsecond')
        end,
        text_version = excluded.text_version
  returning c.decision, c.decided_at, c.text_version into v_decision, v_decided_at, v_text_version;

  if v_decision is distinct from p_decision or v_text_version is distinct from p_text_version or v_decided_at is null then
    raise exception 'set_ai_reading: the choice was not recorded as asked' using errcode = '42501';
  end if;
  return query select v_decision, v_decided_at;
end;
$$;
revoke all on function public.set_ai_reading(text, text) from public, anon, authenticated, service_role;
grant execute on function public.set_ai_reading(text, text) to authenticated;

-- service_role alone can claim a server-triggered read. Neither the user id nor the timestamp
-- authorizes a read: both must match the currently granted row while it is locked. The journal
-- keeps only the last claim per user, and an identical grant cannot replace that row again.
create function public.claim_ai_reading_backlog(p_user_id uuid, p_decided_at timestamptz)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_decision text;
  v_decided_at timestamptz;
  v_claimed_user uuid;
begin
  if p_user_id is null or p_decided_at is null then return false; end if;

  select c.decision, c.decided_at into v_decision, v_decided_at
  from public.ai_reading_consents c where c.user_id = p_user_id for update;
  if not found or v_decision <> 'granted' or v_decided_at is distinct from p_decided_at then return false; end if;

  insert into public.ai_consent_read_runs as r (user_id, consent_decided_at)
  values (p_user_id, p_decided_at)
  on conflict (user_id) do update
    set consent_decided_at = excluded.consent_decided_at
    where r.consent_decided_at is distinct from excluded.consent_decided_at
  returning r.user_id into v_claimed_user;
  return v_claimed_user is not null;
end;
$$;
revoke all on function public.claim_ai_reading_backlog(uuid, timestamptz) from public, anon, authenticated, service_role;
grant execute on function public.claim_ai_reading_backlog(uuid, timestamptz) to service_role;

commit;
