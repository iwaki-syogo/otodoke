-- Undo supabase/migrations/20261106100000_login_mail_limit.sql.
-- Kept outside supabase/migrations/ so `supabase db push` never picks it up. Run by hand only.
-- Without the functions the app logs a warning and still sends the login link (no limit).

drop function public.release_login_mail(bigint, text);
drop function public.claim_login_mail(text, text, integer, integer, integer);
drop table public.login_mail_sends;
