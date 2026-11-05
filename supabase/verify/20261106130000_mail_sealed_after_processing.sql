-- Read only. Run against production BEFORE applying
-- supabase/pending/20261106130000_mail_sealed_after_processing.sql (moved to supabase/migrations/ when applied), with the sealing code
-- already deployed. Prints counts only, never a subject, an address or a body.
--
-- Replace DEPLOYED_AT below with the time the sealing code went live (from Vercel), e.g.
-- '2026-11-07 12:00:00+09'. Then send a test mail (or load the sample) once and run this.
--
-- Go only if:
--   - written_plain_after_deploy is 0 (the new code seals or drops every mail it reads), and
--   - sealed_after_deploy + dropped_after_deploy > 0 (the new code has really read a mail).
-- Rows from before the deploy may still be 'plain'. The trigger does not rewrite them, but once it
-- is on, any UPDATE of such a row is refused unless it seals or drops it (see the migration's header).

with since as (select timestamptz 'DEPLOYED_AT' as t)
select
  count(*) filter (where e.processing_status = 'processed' and e.body_state = 'plain'
                     and coalesce(e.message_id, '') not like 'demo:%') as written_plain_after_deploy,
  count(*) filter (where e.processing_status = 'processed' and e.body_state = 'plain'
                     and coalesce(e.message_id, '') like 'demo:%'
                     and exists (select 1 from public.user_keys k where k.user_id = e.user_id and k.activated_at is not null and k.retired_at is null)) as sample_plain_with_key_after_deploy,
  count(*) filter (where e.body_state = 'sealed') as sealed_after_deploy,
  count(*) filter (where e.body_state = 'dropped') as dropped_after_deploy
from public.emails e, since
where e.created_at >= since.t;

-- After applying: the trigger is there and enabled ('O').
select tgname, tgenabled from pg_trigger
where tgrelid = 'public.emails'::regclass and tgname = 'emails_refuse_plaintext_after_reading';

-- After applying: it really refuses (negative controls), and lets the legitimate writes through.
-- Leaves nothing behind: everything in the block is undone by raising the private code 'OTRBK'.
-- Prints one NOTICE "mail_sealed_after_processing: OK (...)", or raises "... FAILED: ...".
do $$
declare
  v_user uuid;
  v_id uuid := gen_random_uuid();
  v_insert_refused boolean := false;
  v_read_unsealed_refused boolean := false;
  v_dropped_ok boolean := false;
  v_unread_ok boolean := false;
begin
  select u.id into v_user from auth.users u limit 1;
  if v_user is null then
    raise notice 'mail_sealed_after_processing: skipped (no account yet)';
    return;
  end if;
  begin
    -- Negative control 1: a real (non-sample) mail stored as read and plain is refused.
    begin
      insert into public.emails (id, user_id, message_id, processing_status, body_state, subject)
      values (gen_random_uuid(), v_user, '<verify-negative-1@otodoke.invalid>', 'processed', 'plain', 'verify');
    exception when check_violation then
      v_insert_refused := true;
    end;

    -- Positive control: an unread plain mail is stored (it is read later).
    insert into public.emails (id, user_id, message_id, processing_status, body_state, subject)
    values (v_id, v_user, '<verify-negative-2@otodoke.invalid>', 'over_limit', 'plain', 'verify');
    v_unread_ok := true;

    -- Negative control 2: marking it read while it is still plain is refused.
    begin
      update public.emails set processing_status = 'processed' where id = v_id;
    exception when check_violation then
      v_read_unsealed_refused := true;
    end;

    -- Positive control: marking it read and dropped (all five columns null) goes through.
    update public.emails set processing_status = 'processed', body_state = 'dropped',
      subject = null, from_name = null, from_address = null, text_body = null, html_body = null
    where id = v_id;
    v_dropped_ok := found;

    raise exception using errcode = 'OTRBK', message = 'undo the verify writes';
  exception when sqlstate 'OTRBK' then
    null; -- rolled back
  end;

  if exists (select 1 from public.emails where message_id like '<verify-negative-%@otodoke.invalid>') then
    raise exception 'mail_sealed_after_processing FAILED: the verify rows were not undone';
  end if;
  if not (v_insert_refused and v_unread_ok and v_read_unsealed_refused and v_dropped_ok) then
    raise exception 'mail_sealed_after_processing FAILED: insert_refused=% unread_ok=% read_unsealed_refused=% dropped_ok=%',
      v_insert_refused, v_unread_ok, v_read_unsealed_refused, v_dropped_ok;
  end if;
  raise notice 'mail_sealed_after_processing: OK (plain read mail refused on insert and update; unread and dropped allowed; all undone)';
end $$;
