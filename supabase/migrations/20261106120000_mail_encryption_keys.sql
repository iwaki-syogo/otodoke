-- Per-user keys for sealing stored mail, and the columns that hold the sealed copy.
--
-- Why: after a mail is read, its subject, sender (name and address) and body are kept only as
-- an envelope sealed to the user's public key (src/lib/crypto/envelope.ts). The private key is
-- stored wrapped with a key made from the user's passphrase, in the browser; the server never
-- sees the passphrase, so the operator cannot read the stored mail from the database.
--
-- Additive only. The production code before this change keeps working: it never writes the new
-- columns, every existing and new row it writes is body_state 'plain' with no envelope, and
-- the checks below hold for those rows. The trigger that refuses plaintext on processed mail is
-- a separate migration (supabase/pending/20261106130000), applied only after the new code is in
-- production.
--
-- Plaintext on purpose (disclosed in README「あなたのメールの扱い」):
--   from_domain             the sender's domain, for the list and the duplicate/sender checks
--   forwarding_confirm_url  the Gmail forwarding approval link (Google's page only)
--   message_id              unchanged; duplicate detection
--
-- After applying: supabase/verify/20261106120000_mail_encryption_keys.sql
-- Rollback:       supabase/rollback/20261106120000_mail_encryption_keys.down.sql

create table public.user_keys (
  user_id              uuid not null references auth.users(id) on delete cascade,
  key_id               text not null check (key_id ~ '^[0-9a-f]{32}$'),  -- first 16 bytes of SHA-256(public_key), hex
  public_key           text not null check (length(public_key) = 88),    -- base64 of the 65-byte uncompressed P-256 point
  wrapped_private_key  text not null,                                     -- base64, AES-256-GCM of the PKCS#8 private key
  wrap_iv              text not null check (length(wrap_iv) = 16),        -- base64 of 12 bytes
  kdf_salt             text not null check (length(kdf_salt) = 24),       -- base64 of 16 bytes
  kdf_iterations       integer not null check (kdf_iterations >= 600000), -- PBKDF2-SHA256 rounds
  challenge_hash       text not null check (challenge_hash ~ '^[0-9a-f]{64}$'), -- SHA-256 of the registration challenge
  created_at           timestamptz not null default now(),
  activated_at         timestamptz,  -- set once the browser proved the wrapped key opens and matches
  retired_at           timestamptz,  -- replaced by a new key (passphrase forgotten)
  primary key (user_id, key_id),
  constraint user_keys_retired_after_active check (retired_at is null or activated_at is not null)
);
-- At most one key in use per user; mail is sealed to that one.
create unique index user_keys_one_current_idx on public.user_keys(user_id) where activated_at is not null and retired_at is null;

-- The owner reads their own keys (the browser opens the wrapped key). Only the server writes.
alter table public.user_keys enable row level security;
create policy "own keys" on public.user_keys for select to authenticated using (user_id = auth.uid());
revoke all on public.user_keys from public, anon, authenticated;
grant select on public.user_keys to authenticated;
grant select, insert, update, delete on public.user_keys to service_role;

alter table public.emails
  add column body_envelope           jsonb,
  add column body_state              text not null default 'plain',
  add column from_domain             text,
  add column forwarding_confirm_url  text;

-- plain:   subject, sender and body as received (not read yet, a public sample, or from before this change)
-- sealed:  all five in body_envelope; the plaintext columns are empty
-- dropped: not kept (read before the user had a key); the plaintext columns are empty
alter table public.emails
  add constraint emails_body_state check (body_state in ('plain', 'sealed', 'dropped')),
  add constraint emails_body_sealed_has_envelope check ((body_state = 'sealed') = (body_envelope is not null)),
  add constraint emails_body_closed_has_no_plaintext check (
    body_state = 'plain'
    or (subject is null and from_name is null and from_address is null and text_body is null and html_body is null)
  );

-- For the "暗号化する" batches: a user's processed rows still in plaintext.
create index emails_user_plain_idx on public.emails(user_id) where body_state = 'plain';

-- Put a registered key in use: retire the key in use (if any) and activate the new one in one
-- call, so there is never a moment with no key in use (a mail read then would be dropped, not
-- sealed). Called only by the server (src/lib/mail-keys.ts activateKey) after it checked the
-- browser's answer; the answer's SHA-256 is checked again here against the stored challenge_hash.
-- Returns the activated key_id. Raises 'P0002' when no such pending key matches.
create function public.activate_user_key(
  p_user_id uuid,
  p_key_id text,
  p_challenge_hash text
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := now();
  v_count integer;
begin
  if p_user_id is null or p_key_id is null or p_key_id !~ '^[0-9a-f]{32}$'
     or p_challenge_hash is null or p_challenge_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'activate_user_key: expected a user id, a key id and a SHA-256 hex hash' using errcode = '22023';
  end if;

  -- One activation at a time per user: lock this user's key rows until the end of this call.
  perform 1 from public.user_keys where user_id = p_user_id for update;

  perform 1 from public.user_keys
  where user_id = p_user_id and key_id = p_key_id and activated_at is null and challenge_hash = p_challenge_hash;
  if not found then
    raise exception 'activate_user_key: no matching key is waiting to be activated' using errcode = 'P0002';
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

revoke all on function public.activate_user_key(uuid, text, text) from public, anon, authenticated;
grant execute on function public.activate_user_key(uuid, text, text) to service_role;
