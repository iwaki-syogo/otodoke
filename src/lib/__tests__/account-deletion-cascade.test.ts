import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Deleting an account deletes the auth user only (src/lib/account-deletion.ts); every row of the
 * user's goes with it because each table that names a user references auth.users with
 * `on delete cascade`. This reads every migration to keep it so: a new column that names a user
 * without the cascade would make deletion fail (or leave the rows behind), and a new table must say
 * here whether it holds anything of a user's.
 *
 * Exercised on Postgres 17 on 2026-11-06 (the commit that added this file): GoTrue's role, without
 * any grant on the public tables, deleted a user; all eight tables lost that user's rows and only
 * theirs.
 *
 * The registry that keeps a deleted account's receiving address from being given out again has
 * its own test: inbox-local-part-registry.test.ts.
 */

const root = path.resolve(__dirname, "../../..");
const migrationsDir = path.join(root, "supabase/migrations");
const migrationFiles = () => readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();
const readMigration = (f: string) => readFileSync(path.join(migrationsDir, f), "utf8");

/** SQL with `--` and block comments removed and whitespace collapsed, lowercased. */
function normalize(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

/** Split at commas that are not inside parentheses. */
function topLevelParts(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  for (const c of body) {
    if (c === "(") depth++;
    if (c === ")") depth--;
    if (c === "," && depth === 0) {
      parts.push(cur.trim());
      cur = "";
      continue;
    }
    cur += c;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

interface UserColumn {
  table: string;
  column: string;
  definition: string;
}

/** Tables created, and every column that names a user (user_id, or anything referencing auth.users). */
function scan(sqls: string[]): { tables: string[]; userColumns: UserColumn[] } {
  const tables: string[] = [];
  const userColumns: UserColumn[] = [];
  for (const sql of sqls.map(normalize)) {
    for (const m of sql.matchAll(/create table (?:if not exists )?([\w.]+) \(/g)) {
      const table = m[1].replace(/^public\./, "");
      tables.push(table);
      let depth = 1;
      let i = m.index + m[0].length;
      const start = i;
      while (i < sql.length && depth > 0) {
        if (sql[i] === "(") depth++;
        if (sql[i] === ")") depth--;
        i++;
      }
      const parts = topLevelParts(sql.slice(start, i - 1));
      for (const part of parts) {
        // Table constraints are read through the column they name, below.
        if (/^(?:constraint \w+ )?(?:foreign key|primary key|unique|check)\b/.test(part)) continue;
        const column = part.split(" ")[0];
        const tableFk = parts.find((p) => new RegExp(`^(?:constraint \\w+ )?foreign key \\(${column}\\) references auth\\.users`).test(p));
        if (column === "user_id" || part.includes("references auth.users") || tableFk) {
          const definition = part.includes("references auth.users") || !tableFk ? part : tableFk.replace(/^.*?(references .+)$/, "$1");
          userColumns.push({ table, column, definition });
        }
      }
    }
    for (const m of sql.matchAll(/alter table (?:only )?([\w.]+) ([^;]+);/g)) {
      const table = m[1].replace(/^public\./, "");
      for (const add of m[2].matchAll(/add column (?:if not exists )?(\w+) ([^,]+)/g)) {
        if (add[1] === "user_id" || add[2].includes("references auth.users")) userColumns.push({ table, column: add[1], definition: add[2].trim() });
      }
      // A reference added later (a migration that replaces one): it is the column's definition from then on.
      for (const fk of m[2].matchAll(/add constraint \w+ foreign key \((\w+)\) (references auth\.users[^,]*)/g)) {
        const known = userColumns.find((c) => c.table === table && c.column === fk[1]);
        if (known) known.definition = fk[2].trim();
        else userColumns.push({ table, column: fk[1], definition: fk[2].trim() });
      }
    }
  }
  return { tables, userColumns };
}

const cascades = (c: UserColumn) => /references auth\.users ?\(id\) on delete cascade/.test(c.definition);

/**
 * Columns that name a user but do not cascade, and why. Each must say exactly what it does instead.
 * claude_usage_daily: the app-wide daily limit is the sum of the day's rows, so a deleted account's
 * calls must stay in it, with no user (20261106190000, review R3-1). Told in /privacy.
 */
const NOT_CASCADING: Record<string, { action: RegExp; why: string }> = {
  "claude_usage_daily.user_id": { action: /references auth\.users ?\(id\) on delete set null$/, why: "a deleted account's calls still count towards the day's global limit, with no user on them" },
};

/** Tables that hold nothing that names a user, and why. */
const NO_USER_DATA: Record<string, string> = {
  login_mail_sends: "SHA-256 of the address and of the IP only, deleted after an hour (20261106100000)",
  issued_inbox_local_parts: "the random local parts only, kept so none is given out twice (20261106170000)",
};

describe("every row of a user's goes with the auth user", () => {
  const { tables, userColumns } = scan(migrationFiles().map(readMigration));

  it("finds the migrations and the columns it is about (the scan is not empty)", () => {
    expect(migrationFiles().length).toBeGreaterThanOrEqual(12);
    expect(userColumns.length).toBeGreaterThanOrEqual(8);
  });

  it("each column that names a user references auth.users with on delete cascade, or is a listed exception doing what it says", () => {
    expect(userColumns.filter((c) => !cascades(c) && !Object.hasOwn(NOT_CASCADING, `${c.table}.${c.column}`))).toEqual([]);
    for (const [name, { action }] of Object.entries(NOT_CASCADING)) {
      const column = userColumns.find((c) => `${c.table}.${c.column}` === name);
      expect(column?.definition, name).toMatch(action);
    }
  });

  it("claude_usage_daily: on delete set null, and the column may be null (review R3-1)", () => {
    const usage = userColumns.find((c) => c.table === "claude_usage_daily" && c.column === "user_id");
    expect(usage?.definition).toBe("references auth.users(id) on delete set null");
    const all = migrationFiles().map(readMigration).map(normalize).join(" ");
    expect(all).toContain("alter table public.claude_usage_daily alter column user_id drop not null;");
  });

  it("these are the tables that hold a user's rows (the list in the deletion's notes)", () => {
    expect([...new Set(userColumns.map((c) => c.table))].sort()).toEqual([
      "ai_consent_read_runs",
      "ai_reading_consents",
      "claude_call_claims",
      "claude_usage_daily",
      "emails",
      "extractions",
      "inbox_addresses",
      "mail_intake_notices",
      "parcel_items",
      "parcels",
      "sample_generations",
      "screen_events",
      "user_keys",
    ]);
  });

  it("the AI reading choice goes with the hard deletion requested by the shared account helper", () => {
    const choice = userColumns.find((c) => c.table === "ai_reading_consents" && c.column === "user_id");
    expect(choice).toBeDefined();
    expect(cascades(choice!)).toBe(true);
    const helper = readFileSync(path.join(root, "src/lib/account-deletion.ts"), "utf8");
    expect(helper).toContain("admin.auth.admin.deleteUser(userId, false)");
  });

  it("the last automatic-reading claim goes with the account too", () => {
    const run = userColumns.find((c) => c.table === "ai_consent_read_runs" && c.column === "user_id");
    expect(run).toBeDefined();
    expect(cascades(run!)).toBe(true);
  });

  it("every other table is one that holds nothing of a user's", () => {
    const withUser = new Set(userColumns.map((c) => c.table));
    expect(tables.filter((t) => !withUser.has(t) && !Object.hasOwn(NO_USER_DATA, t))).toEqual([]);
    expect(Object.keys(NO_USER_DATA).every((t) => tables.includes(t))).toBe(true);
  });

  it("negative controls: a missing cascade, a user column without a reference, an added column, an unlisted table", () => {
    const planted = scan([
      "create table public.x (id uuid primary key, user_id uuid not null references auth.users(id));",
      "create table public.y (\n  user_id uuid not null -- the owner\n);",
      "create table public.w (user_id uuid, constraint w_user_fk foreign key (user_id) references auth.users(id) on delete cascade);",
      "create table public.u (owner uuid, primary key (owner), foreign key (owner) references auth.users(id));",
      "alter table public.z add column owner uuid references auth.users(id) on delete set null, add column note text;",
      "create table public.v (a int);",
      // A later migration that turns w's cascade into set null is seen as w's definition.
      "alter table public.w add constraint w_user_fk2 foreign key (user_id) references auth.users(id) on delete set null;",
    ]);
    expect(planted.userColumns.filter((c) => !cascades(c)).map((c) => `${c.table}.${c.column}`)).toEqual(["x.user_id", "y.user_id", "w.user_id", "u.owner", "z.owner"]);
    expect(planted.userColumns.filter(cascades).map((c) => `${c.table}.${c.column}`)).toEqual([]);
    expect(planted.tables).toEqual(["x", "y", "w", "u", "v"]);
  });
});
