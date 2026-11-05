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
  sender and body that users without a key left behind (one data change, no schema). Run its verify
  file's part "before" first and only with the owner's YES on the day; nothing it removes comes back.
