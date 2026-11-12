-- Read only. Counts, never a subject, an address or a body. Returns ONE row.
-- Run right after supabase/pending/20261114090000_drop_unsealed_plaintext.sql (decision 7).
-- Go on only if verdict is 'OK'. No row (an error) counts as FAILED: `supabase db query --linked -f`
-- returns only the last result and exits 0 even on an error.
--
-- WHAT THE VERDICT SAYS, AND ONLY THIS (the column verdict_covers repeats it on the row): no read
-- plain mail of a user without a key is left (to_drop_left = 0), and no dropped row keeps a
-- plaintext column (dropped_with_plaintext = 0). It does NOT say nothing was removed too much: it
-- is a state check with no before to compare with, so a wrongly dropped row looks the same as a
-- right one. "Did not drop too much" is checked INSIDE the pending SQL's own transaction (the rows
-- it did not change are hashed whole before and after, and it refuses to commit if they differ).
-- Here you can only compare the three kept_* counts with the before row, by hand; that is a
-- count, not proof that the same rows are there. Never write "the after file confirmed nothing was
-- lost".
--
--   to_drop_left              must be 0: no read plain mail of a user without a key
--   dropped_with_plaintext    must be 0: a dropped row keeps none of the five
--   confirm_links_kept        Gmail confirmations that are dropped and keep their approval link: at
--                             least the before file's confirm_links_moved
--   confirm_without_link      dropped Gmail confirmations with no link (for the record: the body is
--                             gone, so a lost link cannot be seen here; the before file checks that)
--   kept_user_has_key / kept_sample / kept_unread
--                             compare with the before file's row: the same, unless a user pressed
--                             「暗号化する」, loaded the sample or read waiting mail in between
with rows as (
  select e.*,
         k.user_id is not null as has_key,
         coalesce(e.provider_email_id, '') like 'demo:%' as sample
  from public.emails e
  left join public.user_keys k on k.user_id = e.user_id and k.activated_at is not null and k.retired_at is null
),
checks as (
  select
    count(*) filter (where processing_status = 'processed' and body_state = 'plain' and not sample and not has_key) as to_drop_left,
    count(*) filter (where body_state = 'dropped'
                       and (subject is not null or from_name is not null or from_address is not null
                            or text_body is not null or html_body is not null)) as dropped_with_plaintext,
    count(*) filter (where body_state = 'dropped' and classification = 'forwarding_confirmation' and forwarding_confirm_url is not null) as confirm_links_kept,
    count(*) filter (where body_state = 'dropped' and classification = 'forwarding_confirmation' and forwarding_confirm_url is null) as confirm_without_link,
    count(*) filter (where processing_status = 'processed' and body_state = 'plain' and not sample and has_key) as kept_user_has_key,
    count(*) filter (where processing_status = 'processed' and body_state = 'plain' and sample) as kept_sample,
    count(*) filter (where processing_status <> 'processed' and body_state = 'plain') as kept_unread
  from rows
)
select
  case when to_drop_left = 0 and dropped_with_plaintext = 0 then 'OK' else 'FAILED' end as verdict,
  'nothing left to drop and no plaintext on dropped rows, NOT: nothing dropped too much' as verdict_covers,
  checks.*
from checks;
