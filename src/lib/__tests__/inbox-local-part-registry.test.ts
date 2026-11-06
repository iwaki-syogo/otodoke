import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/env", () => ({ env: () => ({}) }));

/**
 * A receiving address is given out once (migration 20261106170000): every local part ever stored
 * stays in public.issued_inbox_local_parts, whose primary key refuses it again. So the address of
 * a deleted account cannot be claimed by somebody else, who would get the mail the deleted user's
 * Gmail still forwards there.
 *
 * Exercised on Postgres 17 on 2026-11-06 (the commit that added this file), as the roles Supabase
 * uses: backfill of the addresses in use; a user's own insert through RLS with the function's
 * EXECUTE revoked; 23505 for a value in use, for a deleted account's value, and for a change of
 * local_part to either; nothing left behind by an insert refused for its shape, a second address or
 * RLS; no read for anon or authenticated; a claim during the deletion refused at once; two users
 * racing for one value: one gets it, the other waits and gets 23505; rollback and re-apply.
 */

const root = path.resolve(__dirname, "../../..");

/** SQL with `--` and block comments removed and whitespace collapsed, lowercased. */
function normalize(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

describe("migration 20261106170000: a receiving address is given out once", () => {
  const sql = normalize(readFileSync(path.join(root, "supabase/migrations/20261106170000_issued_inbox_local_parts.sql"), "utf8"));
  const fn = sql.slice(sql.indexOf("create function public.inbox_addresses_issue_local_part"), sql.indexOf("$$;") + 3);
  const rollback = normalize(readFileSync(path.join(root, "supabase/rollback/20261106170000_issued_inbox_local_parts.down.sql"), "utf8"));

  it("keeps every local part in a table whose primary key refuses it a second time", () => {
    expect(sql).toContain("create table public.issued_inbox_local_parts ( local_part text primary key, issued_at timestamptz not null default now() );");
    expect(sql).toContain("create trigger inbox_addresses_issue_local_part before insert or update of local_part on public.inbox_addresses for each row execute function public.inbox_addresses_issue_local_part();");
    expect(fn).toContain("if tg_op = 'insert' or new.local_part is distinct from old.local_part then insert into public.issued_inbox_local_parts (local_part) values (new.local_part);");
    // Never on delete: a deleted account's local part stays.
    expect(sql).not.toMatch(/(after|before) delete|on delete/);
    expect(sql).not.toMatch(/delete from public\.issued_inbox_local_parts/);
  });

  it("the trigger always returns the new row", () => {
    const returns = [...fn.matchAll(/return (\w+);/g)].map((m) => m[1]);
    expect(returns).toEqual(["new"]);
    // Negative control: the same reading sees a `return old` or `return null`.
    expect([..."begin if x then return old; end if; return null; end".matchAll(/return (\w+);/g)].map((m) => m[1])).toEqual(["old", "null"]);
  });

  it("runs as its owner with an empty search_path, and only the server can read the registry", () => {
    expect(fn).toMatch(/language plpgsql security definer set search_path = '' as \$\$/);
    expect(sql).toContain("alter table public.issued_inbox_local_parts enable row level security;");
    expect(sql).toContain("revoke all on public.issued_inbox_local_parts from public, anon, authenticated, service_role;");
    const grants = [...sql.matchAll(/grant ([^;]+) on public\.issued_inbox_local_parts to ([^;]+);/g)].map((m) => `${m[1]} -> ${m[2]}`);
    expect(grants).toEqual(["select -> service_role"]);
    expect(sql).toContain("revoke all on function public.inbox_addresses_issue_local_part() from public, anon, authenticated;");
  });

  it("registers the addresses already in use, after the trigger exists", () => {
    const backfill = sql.indexOf("insert into public.issued_inbox_local_parts (local_part, issued_at) select local_part, created_at from public.inbox_addresses on conflict (local_part) do nothing;");
    expect(backfill).toBeGreaterThan(sql.indexOf("create trigger inbox_addresses_issue_local_part"));
  });

  it("the rollback drops the trigger, the function and the table", () => {
    expect(rollback).toContain("drop trigger inbox_addresses_issue_local_part on public.inbox_addresses;");
    expect(rollback).toContain("drop function public.inbox_addresses_issue_local_part();");
    expect(rollback).toContain("drop table public.issued_inbox_local_parts;");
  });
});

describe("the registry's refusal is the code both address makers take as 'taken'", () => {
  it("ensureInboxAddress draws another local part after a 23505 from the registry", async () => {
    const { ensureInboxAddress } = await import("../inbox");
    const tried: string[] = [];
    const client = {
      from: () => ({
        select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
        insert: async (row: { local_part: string }) => {
          tried.push(row.local_part);
          return tried.length === 1 ? { error: { code: "23505", message: 'duplicate key value violates unique constraint "issued_inbox_local_parts_pkey"' } } : { error: null };
        },
      }),
    };
    const got = await ensureInboxAddress(client as never, "00000000-0000-4000-8000-00000000000a");
    expect(tried).toHaveLength(2);
    expect(got).toBe(tried[1]);
  });

  it("the iOS app's InboxAddressService does the same on 23505", () => {
    const swift = readFileSync(path.join(root, "ios/Otodoke/Data/InboxAddress.swift"), "utf8");
    const ensure = swift.slice(swift.indexOf("func ensure()"), swift.indexOf("static func email("));
    expect(ensure).toMatch(/catch let error as PostgrestError where error\.code == "23505" \{[\s\S]*?continue\s*\}/);
  });
});
