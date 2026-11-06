-- Decision 8 (2026-11-06): retire the mail keys made with a passphrase, once, right after the
-- password sign-in (password-v1, docs/crypto/password-v1.md) reaches production. A one-off data
-- change, written ahead and NOT applied. On 2026-11-06 production had one such key in use.
--
-- Why: a passphrase key's private key is wrapped with a key made from the passphrase
-- (src/lib/crypto/key-wrap.ts). password-v1 makes that key from the login password, and no screen
-- asks for a passphrase any more. Left in use, mail read for its user would be sealed to a key
-- nothing opens, and their first sign-in with a password would find a key in use that the
-- password cannot open. Retired, it is like a reset (decision 3): that user's mail sealed before
-- stays sealed and does not open; their parcels stay.
--
-- 🚨 Not applied yet, and not to be applied without the owner's YES on the day. Run it right after
-- the password-v1 code is in production and before anyone signs in with a password there: a row
-- made by password-v1 looks the same as a passphrase row (password-v1.md, "The user_keys row"),
-- so a key put in use in between would be retired too.
--   1. supabase/verify/20261107090000_retire_passphrase_keys.before.sql: its verdict must be 'OK',
--      in_use must be the number of passphrase keys you expect, and newest_in_use_at must be
--      before the deploy. If not, stop and look.
--   2. Run this file once: `supabase db query --linked -f supabase/pending/20261107090000_retire_passphrase_keys.sql`.
--      Never through `supabase db push` (that would run it whenever migrations are pushed), and
--      never moved to supabase/migrations/.
--   3. supabase/verify/20261107090000_retire_passphrase_keys.after.sql: its verdict must be 'OK'.
--
-- What it does, in one transaction:
--   - every key in use (activated, not retired): retired_at = now(). The row stays: the mail
--     sealed to it still names it (body_envelope's kid).
--   - every key never put in use (activated_at null): deleted. Such a row is a registration that
--     never finished; one made with a passphrase can never be activated now.
-- What it leaves: retired keys, every mail, every parcel.
--
-- Afterwards, until that user signs in with a password (the browser then makes a new key), mail
-- read for them keeps no subject, sender or body (src/lib/mail-seal.ts: no key in use), as for
-- anyone without a key; decision 7 (supabase/pending/20261114090000) counts them as having no key.
--
-- The table is locked against writes first (reads go on), so the update and the delete see the
-- same rows and no registration slips in between. lock_timeout: a sign-in that is putting a key in
-- use holds that user's rows (activate_user_key_checked), and so does this table lock; after 5 s
-- this gives up and changes nothing, instead of making sign-ins queue behind it. Then run it
-- again. Run the file in one go (as above, or psql -f), never a statement at a time.
--
-- Checked on a local Postgres 17 on 2026-11-06 (the commit that added this file says how).

begin;
set local lock_timeout = '5s';

lock table public.user_keys in share row exclusive mode;

update public.user_keys
set retired_at = now()
where activated_at is not null
  and retired_at is null;

delete from public.user_keys
where activated_at is null;

commit;
