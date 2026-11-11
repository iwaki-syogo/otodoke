import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Source contracts only. The SQL behaviour/race probes still need a temporary Postgres run.
const root = path.resolve(__dirname, "../../..");
const name = "20261112181000_ai_consent_auto_read";
const base = "20261112180000_ai_reading_consent";
const read = (file: string) => readFileSync(path.join(root, "supabase", file), "utf8");
const code = (sql: string) => sql.replace(/--[^\n]*/g, "").trim();
const migration = code(read(`migrations/${name}.sql`));
const verify = code(read(`verify/${name}.sql`));

function setter(sql: string): string {
  return sql.match(/create (?:or replace )?function public\.set_ai_reading\([\s\S]*?\$\$;/)?.[0] ?? "";
}

function claim(sql: string): string {
  return sql.match(/create function public\.claim_ai_reading_backlog\([\s\S]*?\$\$;/)?.[0] ?? "";
}

function setterProblems(sql: string): string[] {
  const fn = setter(sql);
  const out: string[] = [];
  if (!/when c\.decision = excluded\.decision and c\.text_version = excluded\.text_version then c\.decided_at/.test(fn)) out.push("same choice must preserve timestamp");
  if (!fn.includes("values (v_user, p_decision, clock_timestamp(), p_text_version)")) out.push("first timestamp must come from the server clock");
  if (!fn.includes("greatest(clock_timestamp(), c.decided_at + interval '1 microsecond')")) out.push("changed timestamp must advance");
  if (!fn.includes("v_decision is distinct from p_decision or v_text_version is distinct from p_text_version or v_decided_at is null")) out.push("written decision and version must be checked");
  return out;
}

function claimProblems(sql: string): string[] {
  const fn = claim(sql);
  const out: string[] = [];
  if (!/from public\.ai_reading_consents c where c\.user_id = p_user_id for update;/.test(fn)) out.push("must lock the current consent");
  if (!fn.includes("if not found or v_decision <> 'granted' or v_decided_at is distinct from p_decided_at then return false; end if;")) out.push("must require this current grant");
  if (!fn.includes("where r.consent_decided_at is distinct from excluded.consent_decided_at")) out.push("must refuse a repeated claim");
  if (!fn.includes("returning r.user_id into v_claimed_user") || !fn.includes("return v_claimed_user is not null")) out.push("must return only a successful claim");
  return out;
}

function lastStatement(sql: string): string {
  return code(sql).replace(/\$\$[\s\S]*?\$\$/g, "$$body$$").split(";").map((s) => s.trim()).filter(Boolean).at(-1)!;
}

describe("automatic consent reading: database contract", () => {
  it("follows the base consent migration without rewriting it", () => {
    const names = readdirSync(path.join(root, "supabase/migrations")).sort();
    expect(names).toContain(`${base}.sql`);
    expect(names).toContain(`${name}.sql`);
    expect(names.indexOf(`${name}.sql`)).toBeGreaterThan(names.indexOf(`${base}.sql`));
    expect(migration).toContain("create or replace function public.set_ai_reading");
  });

  it("keeps only one user's last claimed consent timestamp, private and cascading", () => {
    expect(migration).toMatch(/create table public\.ai_consent_read_runs \(\s*user_id uuid primary key references auth\.users\(id\) on delete cascade,\s*consent_decided_at timestamptz not null\s*\)/);
    expect(migration).not.toContain("started_at");
    expect(migration).toContain("alter table public.ai_consent_read_runs enable row level security");
    expect(migration).toContain("revoke all on public.ai_consent_read_runs from public, anon, authenticated, service_role");
    expect(migration).not.toMatch(/grant .* on public\.ai_consent_read_runs/);
    expect(migration).not.toMatch(/\bdelete\s+from\b|\btruncate\b/);
  });

  it("preserves timestamps on duplicate decisions and advances on changes while verifying the stored values", () => {
    expect(setter(migration)).not.toBe("");
    expect(setterProblems(migration)).toEqual([]);
    expect(setter(migration)).toContain("returns table (decision text, decided_at timestamptz)");
    expect(setter(migration)).toContain("v_user uuid := auth.uid()");
    expect(setter(migration)).toContain("p_text_version is null or btrim(p_text_version) = ''");
    expect(setter(migration)).not.toMatch(/p_text_version\s*(?:<>|!=|not in|=\s*'v1')/);
  });

  it("serializes claims with consent changes and grants once for this current timestamp", () => {
    expect(claim(migration)).not.toBe("");
    expect(claimProblems(migration)).toEqual([]);
    expect(claim(migration)).toContain("if p_user_id is null or p_decided_at is null then return false; end if;");
    expect(claim(migration)).toMatch(/on conflict \(user_id\) do update\s+set consent_decided_at = excluded\.consent_decided_at/);
  });

  it("exposes the setter only to authenticated and the claim only to service_role", () => {
    for (const fn of [setter(migration), claim(migration)]) expect(fn).toMatch(/security definer\s+set search_path = ''/);
    expect(migration).toContain("revoke all on function public.set_ai_reading(text, text) from public, anon, authenticated, service_role");
    expect(migration).toContain("grant execute on function public.set_ai_reading(text, text) to authenticated");
    expect(migration).toContain("revoke all on function public.claim_ai_reading_backlog(uuid, timestamptz) from public, anon, authenticated, service_role");
    expect(migration).toContain("grant execute on function public.claim_ai_reading_backlog(uuid, timestamptz) to service_role");
  });

  it("negative controls: repeated-grant timestamps, a missing row lock, stale grants, and duplicate claims are detected", () => {
    expect(setterProblems(migration.replace("then c.decided_at", "then clock_timestamp()"))).toContain("same choice must preserve timestamp");
    expect(setterProblems(migration.replace("c.text_version = excluded.text_version", "true"))).toContain("same choice must preserve timestamp");
    expect(setterProblems(migration.replace("greatest(clock_timestamp(), c.decided_at + interval '1 microsecond')", "clock_timestamp()"))).toContain("changed timestamp must advance");
    expect(claimProblems(migration.replace("for update;", ";"))).toContain("must lock the current consent");
    expect(claimProblems(migration.replace("or v_decided_at is distinct from p_decided_at", ""))).toContain("must require this current grant");
    expect(claimProblems(migration.replace("where r.consent_decided_at is distinct from excluded.consent_decided_at", ""))).toContain("must refuse a repeated claim");
  });
});

describe("automatic consent reading: verify and rollback", () => {
  it.each([`verify/${name}.before.sql`, `verify/${name}.sql`])("%s has a final verdict result", (file) => {
    const sql = read(file);
    expect(lastStatement(sql)).toMatch(/^(with|select)\b/);
    expect(lastStatement(sql)).toMatch(/then 'OK' else 'FAILED' end as verdict/);
    expect(code(sql)).not.toMatch(/raise\s+notice/i);
  });

  it("the verify tests lifecycle, role denials, bounded journal and cascade, undoing every write", () => {
    for (const check of ["missing_or_undecided_claim_false", "grant_server_time", "same_grant_time_preserved", "first_claim_true", "second_claim_false", "old_timestamp_claim_false", "repeated_grant_after_claim_time_preserved", "repeated_grant_after_claim_false", "cancel_advances_timestamp", "same_decline_time_preserved", "cancelled_claim_false", "regrant_advances_timestamp", "old_grant_after_regrant_false", "regrant_claim_true", "regrant_second_claim_false", "version_change_advances_timestamp", "old_version_claim_false", "future_version_claim_true", "one_latest_claim_per_user", "other_user_unchanged", "account_deletion_cascade_only_owner"]) {
      expect(verify).toContain(`'${check}'`);
    }
    for (const op of ["select", "insert", "update", "delete"]) expect(verify).toContain(`'_journal_${op}_refused'`);
    expect(verify).toContain("array['anon', 'authenticated', 'service_role']");
    expect(verify).toContain("'_claim_refused'");
    expect(verify).toContain("'FAILED: behaviour did not finish'");
    expect(verify).toContain("raise exception using errcode = 'OTRBK'");
    expect(verify).toContain("when sqlstate 'OTRBK' then null");
    expect(verify).toContain("when others then v_fail := array_append(v_fail, 'sqlstate_' || sqlstate)");
  });

  it("the original verify accepts the server timestamp range for both old and updated setters", () => {
    const originalVerify = code(read(`verify/${base}.sql`));
    expect(originalVerify.match(/v_decided_at < now\(\) or v_decided_at > clock_timestamp\(\)/g)).toHaveLength(2);
  });

  it("the rollback restores the exact original setter and preserves existing choices", () => {
    const down = code(read(`rollback/${name}.down.sql`));
    const baseSetter = setter(code(read(`migrations/${base}.sql`))).replace("create function", "create or replace function");
    expect(setter(down)).toBe(baseSetter);
    expect(down).toContain("drop function if exists public.claim_ai_reading_backlog(uuid, timestamptz)");
    expect(down).toContain("drop table if exists public.ai_consent_read_runs");
    expect(down).not.toMatch(/(?:drop|delete|truncate)[^;]*public\.ai_reading_consents/);
    for (const sql of [migration, down]) {
      expect(sql.startsWith("begin;\nset local lock_timeout = '5s';")).toBe(true);
      expect(sql.endsWith("commit;")).toBe(true);
    }
  });
});
