-- Undo supabase/migrations/20261106150000_activate_user_key_checked.sql.
-- Kept outside supabase/migrations/ so `supabase db push` never picks it up. Run by hand only.
--
-- Put the code before it back first: the code that calls activate_user_key_checked cannot put a
-- new key in use without it (setting a passphrase fails; the key in use stays, no mail is lost).
-- Nothing stored is changed.

drop function public.activate_user_key_checked(uuid, text, text, text);
