import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// These checks keep the ownership and permission contract visible; they do not execute SQL.
// The private application runbook records whether the SQL has run on an actual database.
const root = path.resolve(__dirname, "../../..");
const name = "20261112180000_ai_reading_consent";
const read = (file: string) => readFileSync(path.join(root, "supabase", file), "utf8");
const code = (sql: string) => sql.replace(/--[^\n]*/g, "").trim();
const migration = code(read(`migrations/${name}.sql`));

function lastStatement(sql: string): string {
  return code(sql).replace(/\$\$[\s\S]*?\$\$/g, "$$body$$").split(";").map((s) => s.trim()).filter(Boolean).at(-1)!;
}

describe("AI reading choice: database ownership and permissions", () => {
  it("has no backfill: a new table, with an auth-owned row that cascades, before the only writer is declared", () => {
    const ddl = migration.split("create function public.set_ai_reading")[0];
    expect(ddl).toMatch(/user_id uuid primary key references auth\.users\(id\) on delete cascade/);
    expect(ddl).toMatch(/decision text not null check \(decision in \('granted', 'declined'\)\)/);
    expect(ddl).toMatch(/decided_at timestamptz not null default now\(\)/);
    expect(ddl).toContain("text_version text not null");
    expect(ddl).not.toMatch(/\b(insert|update|delete)\b(?! cascade)/);
  });

  it("allows the person to read only their own row; neither client role can directly write", () => {
    expect(migration).toContain("alter table public.ai_reading_consents enable row level security");
    expect(migration).toContain("revoke all on public.ai_reading_consents from public, anon, authenticated, service_role");
    expect(migration).toContain("grant select on public.ai_reading_consents to authenticated, service_role");
    expect(migration).toContain("for select to authenticated using ((select auth.uid()) = user_id)");
    expect(migration).not.toMatch(/grant\s+(?:insert|update|delete|all)\b/i);
  });

  it("has one RPC that takes no user or timestamp argument, uses auth.uid(), and checks its write", () => {
    expect(migration).toMatch(/create function public\.set_ai_reading\(p_decision text, p_text_version text\)\s*returns table \(decision text, decided_at timestamptz\)/);
    expect(migration).toMatch(/security definer\s+set search_path = ''/);
    expect(migration).toContain("v_user uuid := auth.uid()");
    expect(migration).toContain("values (v_user, p_decision, now(), p_text_version)");
    expect(migration).toContain("set decision = excluded.decision, decided_at = now(), text_version = excluded.text_version");
    expect(migration).toContain("returning c.decision, c.decided_at into v_decision, v_decided_at");
    expect(migration).toContain("v_decision is distinct from p_decision or v_decided_at is distinct from now()");
    expect(migration).toContain("revoke all on function public.set_ai_reading(text, text) from public, anon, authenticated, service_role");
    expect(migration).toContain("grant execute on function public.set_ai_reading(text, text) to authenticated");
  });

  it("refuses only a missing signed-in user, invalid decision, or missing version; a future version can be recorded", () => {
    expect(migration).toContain("if v_user is null then");
    expect(migration).toContain("p_decision is null or p_decision not in ('granted', 'declined')");
    expect(migration).toContain("p_text_version is null or btrim(p_text_version) = ''");
    expect(migration).not.toMatch(/p_text_version\s*(?:<>|!=|not in|=\s*'v1')/);
  });
});

describe("AI reading choice: validation and rollback artifacts", () => {
  it.each([`verify/${name}.before.sql`, `verify/${name}.sql`])("%s ends with the only verdict result, including failures", (file) => {
    const sql = read(file);
    const last = lastStatement(sql);
    expect(last).toMatch(/^(with|select)\b/);
    expect(last).toMatch(/then 'OK' else 'FAILED' end as verdict/);
    expect(code(sql)).not.toMatch(/raise\s+notice/i);
  });

  it("the behavioural verify undoes synthetic users and records unexpected SQL failures instead of reusing an OK", () => {
    const sql = code(read(`verify/${name}.sql`));
    expect(sql).toContain("'FAILED: behaviour did not finish'");
    expect(sql).toContain("raise exception using errcode = 'OTRBK'");
    expect(sql).toContain("when sqlstate 'OTRBK' then null");
    expect(sql).toContain("when others then v_fail := array_append(v_fail, 'sqlstate_' || sqlstate)");
    for (const check of ["rls_hides_other_user", "direct_insert_refused", "direct_update_refused", "direct_delete_refused", "invalid_decision_refused", "missing_version_refused", "withdrawal", "grant_again_and_future_version", "missing_user_refused", "anon_cannot_use_forged_subject", "service_role_cannot_decide", "other_user_unchanged", "upsert_uses_server_time", "account_deletion_cascade_only_owner"]) {
      expect(sql).toContain(`'${check}'`);
    }
  });

  it("the owner probes exercise the table CHECK and NOT NULL without the RPC, including a CHECK widened to allow unexpected", () => {
    const sql = code(read(`verify/${name}.sql`));
    const probes = sql.match(/foreach v_value in array array\[('unexpected'[^\]]*)\] loop([\s\S]*?)end loop;/);
    expect(probes).not.toBeNull();
    const invalidValues = [...probes![1].matchAll(/'([^']*)'/g)].map((m) => m[1]);
    const probeBlock = probes![2];
    expect(probeBlock).toContain("insert into public.ai_reading_consents(user_id, decision, text_version) values (v_user, v_value, 'v1')");
    expect(probeBlock).toContain("update public.ai_reading_consents set decision = v_value where user_id = v_other");
    expect(probeBlock.match(/when check_violation then v_refused := true/g)).toHaveLength(2);
    for (const operation of ["insert", "update"]) {
      expect(probeBlock).toContain(`if not v_refused then v_fail := array_append(v_fail, 'table_invalid_decision_${operation}_refused')`);
      expect(sql).toContain(`if not v_refused then v_fail := array_append(v_fail, 'table_null_decision_${operation}_refused')`);
    }
    expect(sql.match(/when not_null_violation then v_refused := true/g)).toHaveLength(2);
    expect(sql).toContain("values (v_user, null, 'v1')");
    expect(sql).toContain("set decision = null where user_id = v_other");
    expect(sql).toContain("returning decided_at into v_decided_at");
    expect(sql).toContain("if v_decided_at is distinct from now() then v_fail := array_append(v_fail, 'table_default_server_time')");

    // Static fixtures for this IN-list contract only; actual SQL execution remains a separate check.
    // Use the real verify's probes: a probe accepted by the fixture reaches its FAILED branch.
    const rejectedByCheck = (ddl: string, value: string): boolean => {
      const values = ddl.match(/check \(decision in \(([^)]*)\)\)/)?.[1];
      expect(values).toBeDefined();
      return ![...values!.matchAll(/'([^']*)'/g)].some((m) => m[1] === value);
    };
    const fixture = "decision text not null check (decision in ('granted', 'declined'))";
    const widened = "decision text not null check (decision in ('granted', 'declined', 'unexpected'))";
    expect(invalidValues.every((value) => rejectedByCheck(fixture, value))).toBe(true);
    expect(invalidValues.every((value) => rejectedByCheck(widened, value))).toBe(false);
    expect(invalidValues.filter((value) => !rejectedByCheck(widened, value))).toEqual(["unexpected"]);
  });

  it("the rollback has one bounded transaction and removes only the new objects", () => {
    const sql = code(read(`rollback/${name}.down.sql`));
    expect(sql).toBe("begin;\nset local lock_timeout = '5s';\ndrop function if exists public.set_ai_reading(text, text);\ndrop table if exists public.ai_reading_consents;\ncommit;");
    expect(migration.startsWith("begin;\nset local lock_timeout = '5s';")).toBe(true);
    expect(migration.endsWith("commit;")).toBe(true);
  });

  it("negative controls: a missing cascade and a NOTICE verdict fail their contracts", () => {
    const withoutCascade = migration.replace(" on delete cascade", "");
    expect(withoutCascade).not.toMatch(/user_id uuid primary key references auth\.users\(id\) on delete cascade/);
    expect(lastStatement("select 1; do $$ begin raise notice 'OK'; end $$;")).not.toMatch(/^(with|select)\b/);
  });
});
