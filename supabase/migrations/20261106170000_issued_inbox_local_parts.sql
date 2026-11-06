-- A receiving address is given out once: never again, not even after its account is deleted.
--
-- Why: deleting an account (設定「アカウントを削除」, src/app/app/settings/account-actions.ts)
-- deletes the auth user, and its inbox_addresses row goes with it (on delete cascade). Its local
-- part would then be free for somebody else. If the deleted user forgot to remove the automatic
-- forwarding in Gmail (or iCloud, Outlook ...), their order mail would reach that somebody.
--   - By chance this practically never happens: 10 characters from 31 (src/lib/inbox.ts), about
--     8 * 10^14 values; with the generator's modulo bias any one value comes up with a chance of
--     at most about 2.9 * 10^-15. A million deleted and a million new addresses: about 0.3%.
--   - On purpose it can: a signed-in user inserts their own row (20261103140000 grants insert;
--     the Web and the iOS app both do it through PostgREST), and the only check on the value is
--     its shape (20261106110000). Anybody who knows a deleted address (a screenshot, a demo video,
--     a shared Gmail account) could make a new account and claim it.
--
-- How: every local part ever stored in inbox_addresses is kept in public.issued_inbox_local_parts,
-- whose primary key refuses it a second time. Its rows are never deleted: deleting an account (or
-- a later "change my address") leaves the local part there. An insert, or a change of local_part,
-- to a value given out before fails with 23505 (unique_violation), the code the unique index on
-- local_part raises already: src/lib/inbox.ts ensureInboxAddress and the iOS app's
-- InboxAddressService take 23505 as "taken" and draw another value.
--   - The registry row is written in the same statement as the inbox_addresses row: an insert
--     refused for another reason (the shape, a second address for one user) leaves nothing behind.
--   - Two users racing for one value meet at the registry's primary key, which waits for the other
--     transaction and refuses the second: only one of them gets it. A value deleted with its
--     account is still in the registry, so there is no moment at which it is free.
--
-- What it keeps: the 10 random characters and when they were given out. No user id and no mail
-- address: once the account is deleted, nothing in it leads back to a person.
--
-- The function is security definer: a user's own insert runs as `authenticated`, which has no
-- access to the registry (only the server can read it).
--
-- Additive. The code that deletes accounts works without this migration, but until it is applied
-- a deleted address can be claimed again: apply it before, or together with, that code.
-- To give a deleted address back on purpose (restoring an account from a backup), an operator
-- deletes its row from the registry first.
--
-- After applying (read only):
--   select count(*) from public.inbox_addresses a
--   where not exists (select 1 from public.issued_inbox_local_parts r where r.local_part = a.local_part);
--     -- 0: every address in use is registered
--   select tgname, tgenabled from pg_trigger
--   where tgrelid = 'public.inbox_addresses'::regclass and not tgisinternal;
--     -- inbox_addresses_issue_local_part | O
--
-- Rollback: supabase/rollback/20261106170000_issued_inbox_local_parts.down.sql

create table public.issued_inbox_local_parts (
  local_part  text primary key,
  issued_at   timestamptz not null default now()
);

alter table public.issued_inbox_local_parts enable row level security;
revoke all on public.issued_inbox_local_parts from public, anon, authenticated, service_role;
grant select on public.issued_inbox_local_parts to service_role;

create function public.inbox_addresses_issue_local_part() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' or new.local_part is distinct from old.local_part then
    -- Raises 23505 when this local part was given out before, to anybody.
    insert into public.issued_inbox_local_parts (local_part) values (new.local_part);
  end if;
  -- Always the new row: returning old or null here would silently throw the write away.
  return new;
end
$$;

revoke all on function public.inbox_addresses_issue_local_part() from public, anon, authenticated;

create trigger inbox_addresses_issue_local_part
  before insert or update of local_part on public.inbox_addresses
  for each row execute function public.inbox_addresses_issue_local_part();

-- The addresses given out before this migration. After the trigger, so an address stored meanwhile
-- is registered by one or the other; on conflict skips the overlap.
insert into public.issued_inbox_local_parts (local_part, issued_at)
select local_part, created_at from public.inbox_addresses
on conflict (local_part) do nothing;
