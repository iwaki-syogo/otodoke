-- Step 1 of the steps in supabase/verify/20261112020000_claude_call_release.sql. Run BEFORE applying supabase/migrations/20261112020000_claude_call_release.sql.
-- That file adds a check (calls >= 0) to claude_usage_daily; it fails, and changes nothing, if a row
-- is negative. Returns ONE row; go only if its verdict is 'OK'. No row (an error) counts as FAILED.
-- Reads only; prints counts only.
select
  case when count(*) filter (where calls < 0) = 0 then 'OK' else 'FAILED' end as verdict,
  count(*) filter (where calls < 0) as negative_rows,
  count(*) as total_rows
from public.claude_usage_daily;
