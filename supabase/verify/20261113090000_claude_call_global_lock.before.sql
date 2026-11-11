-- Read-only inventory. Stop intake/re-reads and drain all old 300-second requests first.
-- A missing row, SQL error, or verdict other than OK means STOP. No identities/bodies are printed.
with unread as (
  select user_id, count(*) as mails,
    coalesce(sum(octet_length(coalesce(subject,'')) + octet_length(coalesce(from_address,''))
      + octet_length(coalesce(from_name,'')) + octet_length(coalesce(text_body,'')) + octet_length(coalesce(html_body,''))),0) as bytes
  from public.emails where body_state = 'plain' and processing_status <> 'processed' group by user_id
), checks as (
  select
    to_regprocedure('public.claim_claude_call(uuid,integer,integer)') is not null
      and to_regprocedure('public.claim_claude_call_v2(uuid,integer,integer)') is not null
      and to_regprocedure('public.release_claude_call(bigint,uuid)') is not null as functions_ok,
    (select count(*) from public.claude_usage_daily where calls < 0) as negative_usage_rows,
    (select count(*) from public.emails e where processing_status = 'pending' and
      (created_at > clock_timestamp() - interval '300 seconds'
        or (to_jsonb(e)->>'processing_lease_until')::timestamptz > clock_timestamp())) as possibly_active_rows,
    (select coalesce(sum(mails),0) from unread) as unread_mails,
    (select coalesce(sum(bytes),0) from unread) as unread_bytes,
    (select coalesce(max(mails),0) from unread) as largest_user_unread_mails,
    (select coalesce(max(bytes),0) from unread) as largest_user_unread_bytes
)
select case when functions_ok and negative_usage_rows = 0 and possibly_active_rows = 0 then 'OK' else 'FAILED' end as verdict, checks.* from checks;
