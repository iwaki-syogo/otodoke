import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The SQL for received_at (supabase/migrations/20261112100000_parcel_received_at.sql). What it does
 * was run on a local Postgres 17 on 2026-11-11 (the migration, the verify file, its negative
 * controls, the rollback, and a second run of the migration); this test only keeps its shape, as
 * the other SQL tests do. A static test says what the file contains, not that it works.
 */

const root = path.resolve(__dirname, "../../..");
const NAME = "20261112100000_parcel_received_at";
const read = (file: string) => readFileSync(path.join(root, file), "utf8");
const withoutComments = (sql: string) => sql.replace(/--.*$/gm, "");
const MIGRATION = withoutComments(read(`supabase/migrations/${NAME}.sql`));
const FUNCTION = MIGRATION.match(/create or replace function public\.parcels_received_at\(\)[\s\S]*?\$\$;?[\s\S]*?end \$\$;/)?.[0] ?? "";

/** The last statement of a file: what `supabase db query` shows. */
function lastStatement(sql: string): string {
  const code = withoutComments(sql).replace(/\$\$[\s\S]*?\$\$/g, "$$…$$").trim();
  const parts = code.split(";").map((s) => s.trim()).filter(Boolean);
  return parts[parts.length - 1];
}

describe("the migration", () => {
  it("comes after the 2:00 migration, and its three companion files exist", () => {
    const names = readdirSync(path.join(root, "supabase/migrations")).sort();
    expect(names.at(-1)).toBe(`${NAME}.sql`);
    expect(names.indexOf(`${NAME}.sql`)).toBeGreaterThan(names.indexOf("20261112020000_claude_call_release.sql"));
    for (const f of [`supabase/verify/${NAME}.sql`, `supabase/verify/${NAME}.before.sql`, `supabase/rollback/${NAME}.down.sql`]) expect(existsSync(path.join(root, f)), f).toBe(true);
  });

  it("runs in one transaction with a lock_timeout", () => {
    expect(MIGRATION).toMatch(/^\s*begin;\s*set local lock_timeout = '5s';/);
    expect(MIGRATION.trim()).toMatch(/commit;$/);
  });

  it("adds a nullable timestamptz column, and only on the run that adds it moves delivered parcels to received", () => {
    expect(MIGRATION).toMatch(/add column received_at timestamptz;/);
    expect(MIGRATION).not.toMatch(/received_at timestamptz not null/);
    const block = MIGRATION.match(/do \$\$[\s\S]*?end \$\$;/)![0];
    expect(block).toMatch(/if not exists \(select 1 from information_schema\.columns[^)]*received_at/);
    expect(block).toContain("update public.parcels set received_at = updated_at where status = 'delivered';");
    // updated_at is not moved by the backfill: the trigger is off for it and on again.
    const order = [block.indexOf("disable trigger parcels_set_updated_at"), block.indexOf("update public.parcels set received_at"), block.indexOf("enable trigger parcels_set_updated_at")];
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("tells the roles apart by current_user, in a SECURITY INVOKER function with a fixed search_path", () => {
    expect(FUNCTION).not.toBe("");
    expect(FUNCTION).toContain("current_user = 'authenticated'");
    expect(FUNCTION).not.toMatch(/security definer/i);
    expect(FUNCTION).not.toMatch(/request\.jwt|auth\.role|auth\.jwt/);
    expect(FUNCTION).toMatch(/set search_path = ''/);
  });

  it("returns NEW on every path and never OLD (a BEFORE UPDATE trigger that returns OLD throws the write away without an error)", () => {
    expect(FUNCTION).not.toMatch(/return\s+old\b/i);
    expect(FUNCTION).not.toMatch(/return\s+null\b/i);
    const returns = [...FUNCTION.matchAll(/\breturn\s+(\w+)/gi)].map((m) => m[1].toLowerCase());
    expect(returns.length).toBeGreaterThanOrEqual(2);
    expect(returns.every((r) => r === "new")).toBe(true);
  });

  it("is a BEFORE INSERT OR UPDATE row trigger on parcels, dropped first so the file can run again", () => {
    expect(MIGRATION).toMatch(/drop trigger if exists parcels_received_at on public\.parcels;\s*create trigger parcels_received_at before insert or update on public\.parcels\s*for each row execute function public\.parcels_received_at\(\);/);
  });

  it("clears received_at when the status leaves delivered, for any role, and sets it for the signed-in user only", () => {
    expect(FUNCTION).toMatch(/old\.status = 'delivered' and new\.status is distinct from 'delivered'\s*then\s*new\.received_at := null;/);
    // The only place now() is written is behind the authenticated check.
    const sets = [...FUNCTION.matchAll(/new\.received_at := now\(\)/g)];
    expect(sets).toHaveLength(2);
    for (const m of sets) expect(FUNCTION.slice(Math.max(0, m.index! - 300), m.index!)).toContain("current_user = 'authenticated'");
  });

  it("negative control: a trigger that returns OLD, or tells roles by the JWT setting, is caught", () => {
    const bad = "create or replace function public.parcels_received_at() returns trigger as $$ begin if x then return old; end if; return new; end $$;";
    expect(bad).toMatch(/return\s+old\b/i);
    expect("select current_setting('request.jwt.claims')").toMatch(/request\.jwt/);
  });
});

describe("its verify files and rollback", () => {
  it("each verify file ends in one SELECT with a verdict, and no OK by NOTICE", () => {
    for (const f of [`supabase/verify/${NAME}.sql`, `supabase/verify/${NAME}.before.sql`]) {
      const sql = read(f);
      expect(lastStatement(sql), f).toMatch(/^(with|select)\b/i);
      expect(lastStatement(sql), f).toMatch(/\bas verdict\b/);
      expect(withoutComments(sql), f).not.toMatch(/raise\s+notice/i);
    }
  });

  it("the verify file checks the behaviour by role, in a block it rolls back", () => {
    const sql = withoutComments(read(`supabase/verify/${NAME}.sql`));
    for (const role of ["authenticated", "service_role"]) expect(sql).toContain(`set local role ${role};`);
    expect(sql).toContain("errcode = 'OTRBK'");
    expect(sql).toMatch(/behaviour = 'OK'/);
    expect(sql).toMatch(/unmoved_delivered = 0/);
    expect(sql).toMatch(/!~\* 'return\\s\+old'/);
  });

  it("the rollback drops the trigger, the function and the column, each only if it is there", () => {
    const sql = withoutComments(read(`supabase/rollback/${NAME}.down.sql`));
    expect(sql).toContain("drop trigger if exists parcels_received_at on public.parcels;");
    expect(sql).toContain("drop function if exists public.parcels_received_at();");
    expect(sql).toContain("alter table public.parcels drop column if exists received_at;");
    expect(sql).toMatch(/set local lock_timeout = '5s';/);
  });
});
