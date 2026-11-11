-- Run the file in one go with automatic reads stopped. Existing consent choices are retained.
-- Removes the journal/claim and restores the preceding RPC exactly (including its old timestamp
-- behaviour). The new application must never treat a missing claim function as permission to
-- bypass claiming. Reapplying this migration creates an empty journal and permits a new claim.
begin;
set local lock_timeout = '5s';
drop function if exists public.claim_ai_reading_backlog(uuid, timestamptz);
drop table if exists public.ai_consent_read_runs;

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
