-- WARNING (2026-11-08, restated 2026-11-10): password-v1 is in production, and its key rows look
-- the same as passphrase rows. The paired script supabase/pending/20261107090000_retire_passphrase_keys.sql,
-- as written, retires EVERY key in use, so every user who signed in with a password (the judge
-- account's too) would lose theirs. Do NOT run it, and do not run this file as a step toward it, even
-- after judging. It may be run only after it has been rewritten to target the passphrase key ids
-- only AND that rewrite has passed review by someone other than its author. Passing a date is not a condition.

-- Read only. Counts and one time, never a key, a user id or an address. Returns ONE row.
-- Run right before supabase/pending/20261107090000_retire_passphrase_keys.sql (decision 8), on the
-- day, and keep the row. Go on only if verdict is 'OK', in_use is the number of passphrase keys you
-- expect (1 on 2026-11-06), and newest_in_use_at is before the password-v1 deploy: a key put in
-- use after it may be a password key, which the retire would take too. No row (an error) means
-- nothing was counted: `supabase db query --linked -f` returns only the last result and exits 0
-- even on an error.
--
--   in_use             keys in use (activated, not retired): the retire retires these
--   in_use_users       users they belong to (one key in use per user at most)
--   pending            keys never put in use (activated_at null): the retire deletes these
--   retired            keys retired already (left as they are)
--   newest_in_use_at   when the newest key in use was put in use
with counts as (
  select
    count(*) filter (where activated_at is not null and retired_at is null) as in_use,
    count(distinct user_id) filter (where activated_at is not null and retired_at is null) as in_use_users,
    count(*) filter (where activated_at is null) as pending,
    count(*) filter (where retired_at is not null) as retired,
    max(activated_at) filter (where activated_at is not null and retired_at is null) as newest_in_use_at
  from public.user_keys
)
select
  case
    when in_use = 0 then 'FAILED: no key is in use, so there is nothing to retire (retired already?)'
    when in_use <> in_use_users then 'FAILED: a user has more than one key in use'
    else 'OK'
  end as verdict,
  counts.*
from counts;
