# supabase/pending

Migrations that are written but must not be applied yet. `supabase db push` applies every file in
`supabase/migrations/`, so a migration that has to wait (for code to reach production first) waits here.

**When moving a file to `supabase/migrations/`, rename it with a fresh timestamp** (the time you move it).
`db push` refuses, or applies out of order, a migration whose timestamp sorts before one already
applied to production. A name written days ago will very likely sort before migrations added since.

Rename its companions to the same new timestamp too: `supabase/rollback/<timestamp>_<name>.down.sql`,
`supabase/verify/<timestamp>_<name>.sql`, and every comment and test that names the file.

The timestamp in each name here is the planned date to apply or run it (`20261114090000` = 2026-11-14), not the date it was written: all three files were written on 2026-11-06, during the event.

Now waiting:

- `20261111100000_claude_call_release.sql` — gives back the allowance of a Claude call that Claude
  refused (claim_claude_call_v2 / release_claude_call, a new table claude_call_claims, and calls >= 0
  on claude_usage_daily). Safe to apply any time: the code in production keeps using
  claim_claude_call, and the code that knows the new functions falls back to it while they are
  missing. Run `supabase/verify/20261111100000_claude_call_release.before.sql` first (verdict 'OK'),
  then the file, then `supabase/verify/20261111100000_claude_call_release.sql` (verdict 'OK').
  Rollback: `supabase/rollback/20261111100000_claude_call_release.down.sql`.
  **How to apply:** move all four files to `supabase/migrations/` (the SQL), `supabase/verify/` and
  `supabase/rollback/` with a fresh timestamp (also in every comment and test that names them), then
  `supabase db push`. Do not run it with `supabase db query`: migrations and production's schema would
  differ. Order: the `.before.sql` verify, push, the verify. **Fix when moving:** add
  `claude_call_claims` to the table list in `account-deletion-cascade.test.ts` ("these are the tables that
  hold a user's rows"), and change the pending-only tests in `verify-sql-shape.test.ts`
  (the 20261111100000 block that reads `supabase/pending/…` and expects no file in `migrations/`).
  **Check after applying:** with the new code on dev, read one mail, then today's
  `claude_call_claims` must have 1 or more rows; 0 rows means the code fell back to the old function
  (it logs a warning "claim_claude_call_v2 is missing"). The locks it takes on `auth.users` are in
  the file's header.
- `20261106130000_mail_sealed_after_processing.sql` — refuses a read mail left in plaintext. Apply only
  after the sealing code is in production and its verify file says so (see the file's header).
- `20261114090000_drop_unsealed_plaintext.sql` — decision 7: on 2026-11-14, drop the plaintext subject,
  sender and body that users without a key left behind (one data change, no schema). Only with the
  owner's YES on the day; nothing it removes comes back. Its verify files each return one verdict
  row: `supabase/verify/20261114090000_drop_unsealed_plaintext.before.sql` and `.count-control.sql`
  first, `.after.sql` right after.
- `20261107090000_retire_passphrase_keys.sql` — **WARNING (2026-11-08, restated 2026-11-10): do NOT
  run this.** password-v1 is already in production, and its key rows look the same as passphrase
  rows, so running it as written retires EVERY key in use and every user who signed in with a
  password (the judge account's too) loses theirs. It may be run only after it has been rewritten
  to target the passphrase key ids only AND that rewrite has passed review by someone other than
  its author; a date passing is not a condition. The steps below are the original plan, kept for
  reference only. Decision 8: once, right after the password sign-in
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
