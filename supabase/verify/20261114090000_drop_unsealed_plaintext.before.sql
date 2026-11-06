-- Read only. Counts, never a subject, an address or a body. Returns ONE row.
-- For supabase/pending/20261114090000_drop_unsealed_plaintext.sql (decision 7). Run first, on the
-- day, and keep the row: the after file is compared with it. verdict 'OK': nothing the settings
-- page could show is lost (confirm_without_link is 0); 'LOOK' otherwise: look before running.
-- No row (an error) means nothing was counted: `supabase db query --linked -f` returns only the
-- last result and exits 0 even on an error.
--
--   to_drop                   read, plain, not a sample, the user has no key in use  -> dropped
--   users_to_drop             how many users lose plaintext
--   kept_user_has_key         read, plain, the user has a key in use (「暗号化する」 seals these)
--   kept_sample               read, plain, a public sample mail
--   kept_unread               unread, plain (sealed or dropped when read)
--   confirm_links_moved       Gmail forwarding confirmations among to_drop whose approval link is
--                             only in the body: the update moves it into forwarding_confirm_url
--   confirm_without_link      the same, but no link to Google's page is found in the body: they lose
--                             nothing the settings page could show. If this is not 0, look before
--                             running (a link the pattern misses would be lost with the body).
with rows as (
  select e.*,
         k.user_id is not null as has_key,
         coalesce(e.provider_email_id, '') like 'demo:%' as sample,
         case when e.classification = 'forwarding_confirmation' and e.forwarding_confirm_url is null then
           coalesce(
             substring(e.text_body from '(?i)https://mail-settings\.google\.com/mail/[^[:space:]<>"'')]*'),
             substring(e.html_body from '(?i)https://mail-settings\.google\.com/mail/[^[:space:]<>"'')]*')
           )
         end as body_link
  from public.emails e
  left join public.user_keys k on k.user_id = e.user_id and k.activated_at is not null and k.retired_at is null
)
, counts as (
select
  count(*) filter (where processing_status = 'processed' and body_state = 'plain' and not sample and not has_key) as to_drop,
  count(distinct user_id) filter (where processing_status = 'processed' and body_state = 'plain' and not sample and not has_key) as users_to_drop,
  count(*) filter (where processing_status = 'processed' and body_state = 'plain' and not sample and has_key) as kept_user_has_key,
  count(*) filter (where processing_status = 'processed' and body_state = 'plain' and sample) as kept_sample,
  count(*) filter (where processing_status <> 'processed' and body_state = 'plain') as kept_unread,
  count(*) filter (where processing_status = 'processed' and body_state = 'plain' and not sample and not has_key
                     and classification = 'forwarding_confirmation' and forwarding_confirm_url is null and body_link is not null) as confirm_links_moved,
  count(*) filter (where processing_status = 'processed' and body_state = 'plain' and not sample and not has_key
                     and classification = 'forwarding_confirmation' and forwarding_confirm_url is null and body_link is null) as confirm_without_link
from rows
)
select case when confirm_without_link = 0 then 'OK' else 'LOOK' end as verdict, counts.*
from counts;
