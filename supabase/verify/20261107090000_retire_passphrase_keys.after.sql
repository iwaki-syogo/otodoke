-- WARNING (2026-11-08, restated 2026-11-10): password-v1 is in production, and its key rows look
-- the same as passphrase rows. The paired script supabase/pending/20261107090000_retire_passphrase_keys.sql,
-- as written, retires EVERY key in use, so every user who signed in with a password (the judge
-- account's too) would lose theirs. Do NOT run it, and do not run this file as a step toward it, even
-- after judging. It may be run only after it has been rewritten to target the passphrase key ids
-- only AND that rewrite has passed review by someone other than its author. Passing a date is not a condition.

-- Read only. Counts, never a key, a user id or an address. Returns ONE row.
-- Run right after supabase/pending/20261107090000_retire_passphrase_keys.sql (decision 8). Go on
-- only if verdict is 'OK'. No row (an error) counts as FAILED: `supabase db query --linked -f`
-- returns only the last result and exits 0 even on an error.
--
--   in_use     must be 0: no key in use. Run this right after the retire: a key the browser makes
--              at a password sign-in afterwards shows here too.
--   pending    must be 0: no key left that was never put in use. The same goes for a sign-in
--              that registers a key afterwards.
--   retired    every retired key: the before file's retired plus its in_use
with counts as (
  select
    count(*) filter (where activated_at is not null and retired_at is null) as in_use,
    count(*) filter (where activated_at is null) as pending,
    count(*) filter (where retired_at is not null) as retired
  from public.user_keys
)
select
  case
    when in_use <> 0 then format('FAILED: %s key(s) still in use', in_use)
    when pending <> 0 then format('FAILED: %s key(s) never put in use are left', pending)
    else 'OK'
  end as verdict,
  counts.*
from counts;
