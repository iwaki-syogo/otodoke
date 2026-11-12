import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Real two-connection behaviour is exercised by run-parcel-user-locks.mjs. These checks
// prevent a later SQL edit from silently restoring a global or row-before-owner boundary.
const read = (path: string) => readFileSync(new URL(`../../../supabase/${path}`, import.meta.url), "utf8");
const parcel = read("migrations/20261113100000_parcel_write_conflicts.sql");
const sample = read("migrations/20261113110000_sample_generation.sql");
const down = read("rollback/20261113110000_sample_generation.down.sql");
const before = read("verify/20261113110000_sample_generation.before.sql");
function body(sql: string, name: string): string {
  const found = sql.match(new RegExp(`create or replace function public\\.${name}\\([\\s\\S]*?\\bas \\$\\$([\\s\\S]*?)\\$\\$;`, "i"));
  if (!found) throw new Error(`missing ${name}`);
  return found[1];
}
function candidateProblems(value: string): string[] {
  const problems: string[] = [];
  if (/pg_advisory_xact_lock\(62803,\s*0\)/.test(value)) problems.push("global key");
  if (!value.includes("perform public.lock_parcel_owner(v_owner);")) problems.push("shared owner helper");
  if (!/current_setting\('role',true\)='authenticated'[\s\S]*?v_owner := auth\.uid\(\)/.test(value)) problems.push("authenticated owner");
  if (!value.includes("parcel header and transaction owner differ")) problems.push("header consistency");
  const row = value.match(/if tg_level='ROW' then([\s\S]*?)if tg_op='TRUNCATE'/)?.[1];
  if (!row || /pg_advisory|lock_parcel_owner|lock_sample_owner|prelock_sample_request/.test(row)) problems.push("row relocking");
  if (!row?.includes("old.user_id::text is distinct from v_context") || !row.includes("new.user_id::text is distinct from v_context")) problems.push("row owner");
  if (!row?.includes("return old;") || !row.includes("return new;")) problems.push("row result");
  return problems;
}

describe("parcel candidate locks stay within one user", () => {
  it("defines one private helper for the shared owner-key contract", () => {
    const definition = body(parcel, "lock_parcel_owner");
    expect(definition).toMatch(/if p_user is null[\s\S]*?errcode='22023'/);
    expect(definition).toMatch(/parcel transaction owner cannot change[\s\S]*?errcode='42501'/);
    expect(definition).toMatch(/set_config\('otodoke.parcel_owner',p_user::text,true\)[\s\S]*?pg_advisory_xact_lock\(62803,pg_catalog.hashtext\(p_user::text\)\)/);
    expect(parcel).toMatch(/revoke all on function public\.lock_parcel_owner\(uuid\) from public,anon,authenticated,service_role/);
  });
  it.each([parcel, sample])("keeps statement ownership and row validation in both migration stages", (sql) => {
    expect(candidateProblems(body(sql, "lock_parcel_candidates"))).toEqual([]);
  });
  it("negative control: a global candidate key is rejected", () => {
    const changed = body(sample, "lock_parcel_candidates").replace("public.lock_parcel_owner(v_owner)", "pg_catalog.pg_advisory_xact_lock(62803,0)");
    expect(candidateProblems(changed)).toContain("global key");
  });
  it("negative control: moving the first lock to the row guard is rejected", () => {
    const changed = body(sample, "lock_parcel_candidates").replace("if tg_level='ROW' then", "if tg_level='ROW' then perform public.lock_parcel_owner(v_owner);");
    expect(candidateProblems(changed)).toContain("row relocking");
  });
  it("positive control: formatting preserves the guarded definition", () => {
    expect(candidateProblems(`\n${body(sample, "lock_parcel_candidates")}\n`)).toEqual([]);
  });
  it.each(["mail_run_write", "create_mail_parcel", "update_mail_parcel", "ensure_mail_parcel_items"])("%s locks the checked email owner's key", (name) => {
    const definition = body(parcel, name);
    expect(definition).toMatch(/for update;[\s\S]*?mail run no longer owns the lease[\s\S]*?perform public\.lock_parcel_owner\(v_mail.user_id\)/);
    expect(definition).not.toMatch(/pg_advisory_xact_lock\(62803,\s*0\)/);
  });
  it("stacked Auth deletion owns generation, emails and the user candidate key before cascades", () => {
    expect(body(sample, "prelock_sample_owner_delete")).toMatch(/set_config\('otodoke.parcel_delete_owner',old.id::text,true\)[\s\S]*?sample_generations[\s\S]*?for update;[\s\S]*?public.emails[\s\S]*?order by id for update;[\s\S]*?perform public\.lock_parcel_owner\(old.id\)/);
  });
  it("rollback restores the exact standalone candidate function", () => {
    expect(body(down, "lock_parcel_candidates")).toBe(body(parcel, "lock_parcel_candidates"));
  });
  it.each(["lock_parcel_candidates", "mail_run_write", "create_mail_parcel", "update_mail_parcel", "ensure_mail_parcel_items"])("before/down pin the current %s core", (name) => {
    const hash = createHash("md5").update(body(parcel, name)).digest("hex");
    expect(before).toContain(hash);
    expect(down).toContain(hash);
  });
});
