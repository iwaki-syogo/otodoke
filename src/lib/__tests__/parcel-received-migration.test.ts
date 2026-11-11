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

/** What is wrong with a trigger function's SQL, by the rules this migration is written to. Empty = fine. */
function problemsOf(fn: string): string[] {
  const out: string[] = [];
  const returns = [...fn.matchAll(/\breturn\s+(\w+)/gi)].map((m) => m[1].toLowerCase());
  if (returns.length < 2 || !returns.every((r) => r === "new")) out.push("returns something other than NEW");
  if (/security definer/i.test(fn)) out.push("security definer");
  if (!/set search_path = ''/.test(fn)) out.push("no fixed search_path");
  if (/request\.jwt|auth\.role|auth\.jwt/.test(fn) || !fn.includes("current_user")) out.push("does not use current_user");
  if (!/old\.status = 'delivered' and new\.status is distinct from 'delivered'\s*then\s*new\.received_at := null;/.test(fn)) out.push("does not clear received_at on leaving delivered");
  if (!/new\.received_at := null;\s*new\.check_dismissed_at := null;/.test(fn)) out.push("does not clear check_dismissed_at on leaving delivered");
  // Every place now() is written must have the authenticated check in front of it.
  const sets = [...fn.matchAll(/new\.received_at := now\(\)/g)];
  if (sets.length === 0 || sets.some((m) => !fn.slice(Math.max(0, m.index! - 300), m.index!).includes("current_user = 'authenticated'"))) out.push("now() is not behind the authenticated check");
  return out;
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
    expect(MIGRATION).toMatch(/add column if not exists check_dismissed_at timestamptz;/);
    expect(MIGRATION).not.toMatch(/received_at timestamptz not null/);
    const block = MIGRATION.match(/do \$\$[\s\S]*?end \$\$;/)![0];
    expect(block).toMatch(/if not exists \(select 1 from information_schema\.columns[^)]*received_at/);
    expect(block).toContain("update public.parcels set received_at = updated_at where status = 'delivered';");
    // updated_at is not moved by the backfill: the trigger is off for it and on again.
    const order = [block.indexOf("disable trigger parcels_set_updated_at"), block.indexOf("update public.parcels set received_at"), block.indexOf("enable trigger parcels_set_updated_at")];
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("passes the checks on its trigger function", () => {
    expect(FUNCTION).not.toBe("");
    expect(problemsOf(FUNCTION)).toEqual([]);
  });

  it("is a BEFORE INSERT OR UPDATE row trigger on parcels, dropped first so the file can run again", () => {
    expect(MIGRATION).toMatch(/drop trigger if exists parcels_received_at on public\.parcels;\s*create trigger parcels_received_at before insert or update on public\.parcels\s*for each row execute function public\.parcels_received_at\(\);/);
  });

  it("keeps the time it added the column in the column's comment, for the verify file", () => {
    expect(MIGRATION).toMatch(/comment on column public\.parcels\.received_at is %L/);
    expect(withoutComments(read(`supabase/verify/${NAME}.sql`))).toContain("'added (\\S+)'");
  });

  describe("negative controls: the checks fail on a broken function", () => {
    const broken = (edit: (fn: string) => string) => problemsOf(edit(FUNCTION));
    it("returns OLD", () => {
      expect(broken((f) => f.replace(/return new;(?![\s\S]*return new;)/, "return old;"))).toContain("returns something other than NEW");
      expect(broken((f) => f.replace("return new;", "return old;"))).toContain("returns something other than NEW");
    });
    it("is SECURITY DEFINER", () => {
      expect(broken((f) => f.replace("set search_path = ''", "security definer\nset search_path = ''"))).toContain("security definer");
    });
    it("lets every role set received_at (no role check in front of now())", () => {
      expect(broken((f) => f.replaceAll(" and current_user = 'authenticated'", ""))).toContain("now() is not behind the authenticated check");
    });
    it("tells roles by the JWT setting", () => {
      expect(broken((f) => f.replaceAll("current_user = 'authenticated'", "current_setting('request.jwt.claims', true) is not null"))).toContain("does not use current_user");
    });
    it("does not clear received_at when the status leaves delivered", () => {
      expect(broken((f) => f.replace("new.received_at := null;", "null;"))).toContain("does not clear received_at on leaving delivered");
    });
    it("leaves check_dismissed_at behind when the status leaves delivered", () => {
      expect(broken((f) => f.replace("new.check_dismissed_at := null;", ""))).toContain("does not clear check_dismissed_at on leaving delivered");
    });
    it("has no fixed search_path", () => {
      expect(broken((f) => f.replace("set search_path = ''", ""))).toContain("no fixed search_path");
    });
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
    expect(sql).toContain("alter table public.parcels drop column if exists check_dismissed_at;");
    expect(sql).toMatch(/set local lock_timeout = '5s';/);
  });
});
