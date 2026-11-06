# supabase/pending

Migrations that are written but must not be applied yet. `supabase db push` applies every file in
`supabase/migrations/`, so a migration that has to wait (for code to reach production first) waits here.

**When moving a file to `supabase/migrations/`, rename it with a fresh timestamp** (the time you move it).
`db push` refuses, or applies out of order, a migration whose timestamp sorts before one already
applied to production. A name written days ago will very likely sort before migrations added since.

Rename its companions to the same new timestamp too: `supabase/rollback/<timestamp>_<name>.down.sql`,
`supabase/verify/<timestamp>_<name>.sql`, and every comment and test that names the file.

Now waiting:

- `20261106130000_mail_sealed_after_processing.sql` — refuses a read mail left in plaintext. Apply only
  after the sealing code is in production and its verify file says so (see the file's header).
- `20261114090000_drop_unsealed_plaintext.sql` — decision 7: on 2026-11-14, drop the plaintext subject,
  sender and body that users without a key left behind (one data change, no schema). Only with the
  owner's YES on the day; nothing it removes comes back. Its verify files each return one verdict
  row: `supabase/verify/20261114090000_drop_unsealed_plaintext.before.sql` and `.count-control.sql`
  first, `.after.sql` right after.
- `20261107090000_retire_passphrase_keys.sql` — decision 8: once, right after the password sign-in
  (password-v1) reaches production and before anyone signs in with a password there, retire every
  mail key in use (they were made with a passphrase, which no screen asks for any more) and delete
  the keys never put in use (one data change, no schema). Only with the owner's YES on the day. A
  key made by password-v1 looks the same as a passphrase key, so a later run would retire it too.
  **Not a migration: it never goes to `supabase/migrations/` or through `db push`.** Run it once
  with `supabase db query --linked -f supabase/pending/20261107090000_retire_passphrase_keys.sql`,
  after `supabase/verify/20261107090000_retire_passphrase_keys.before.sql` (verdict 'OK', and in_use
  and newest_in_use_at as expected; see its header), then
  `supabase/verify/20261107090000_retire_passphrase_keys.after.sql` (verdict 'OK'). It gives up after
  5 s on a held row and changes nothing; run it again then.
