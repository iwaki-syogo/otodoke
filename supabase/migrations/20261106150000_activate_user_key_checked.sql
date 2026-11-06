-- Put a registered key in use only if the key in use is still the one the browser expected.
--
-- Why: the screen that makes a key (設定「合言葉を決める」 / 「作り直す」) was drawn at some moment.
-- A tab left open from before another tab or device made a key still shows 「決める」; pressing it
-- used to retire the key in use without the user ever seeing 「前のメールが開けなくなる」, and the
-- mail sealed to that key no longer opened in the app. The browser now sends the key id it was
-- drawn with (null: no key yet) and this function refuses when the key in use is another one.
-- The check is made under the same lock as the retire + activate, so two tabs racing cannot both
-- pass it.
--
-- Additive only: activate_user_key (migration 20261106120000) stays for the code in production
-- until this code replaces it; it can be dropped afterwards.
--
-- Apply BEFORE the code that calls it (src/lib/mail-keys.ts activateKey): with the new code and
-- without this function, nobody can set a passphrase (activation fails; the key in use stays).
--
-- After applying: supabase/verify/20261106150000_activate_user_key_checked.sql
-- Rollback:       supabase/rollback/20261106150000_activate_user_key_checked.down.sql
--
-- Returns the activated key_id. Raises 'P0002' when no such pending key matches, and 'P0001'
-- with the message 'activate_user_key: the key in use changed' when the expected key is not the
-- one in use (src/lib/crypto/key-messages.ts KEY_IN_USE_CHANGED matches that message).

create function public.activate_user_key_checked(
  p_user_id uuid,
  p_key_id text,
  p_challenge_hash text,
  p_expected_current_key_id text
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := now();
  v_count integer;
  v_current text;
begin
  if p_user_id is null or p_key_id is null or p_key_id !~ '^[0-9a-f]{32}$'
     or p_challenge_hash is null or p_challenge_hash !~ '^[0-9a-f]{64}$'
     or (p_expected_current_key_id is not null and p_expected_current_key_id !~ '^[0-9a-f]{32}$') then
    raise exception 'activate_user_key: expected a user id, a key id, a SHA-256 hex hash and a key id or null' using errcode = '22023';
  end if;

  -- One activation at a time per user: lock this user's key rows until the end of this call.
  perform 1 from public.user_keys where user_id = p_user_id for update;

  perform 1 from public.user_keys
  where user_id = p_user_id and key_id = p_key_id and activated_at is null and challenge_hash = p_challenge_hash;
  if not found then
    raise exception 'activate_user_key: no matching key is waiting to be activated' using errcode = 'P0002';
  end if;

  -- The key in use now (read after taking the lock), against what the browser's screen showed.
  select key_id into v_current from public.user_keys
  where user_id = p_user_id and activated_at is not null and retired_at is null;
  if v_current is distinct from p_expected_current_key_id then
    raise exception 'activate_user_key: the key in use changed' using errcode = 'P0001';
  end if;

  update public.user_keys set retired_at = v_now
  where user_id = p_user_id and activated_at is not null and retired_at is null;

  update public.user_keys set activated_at = v_now
  where user_id = p_user_id and key_id = p_key_id and activated_at is null;
  get diagnostics v_count = row_count;
  if v_count <> 1 then
    raise exception 'activate_user_key: the key was not activated' using errcode = 'P0002';
  end if;
  return p_key_id;
end;
$$;

revoke all on function public.activate_user_key_checked(uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.activate_user_key_checked(uuid, text, text, text) to service_role;
