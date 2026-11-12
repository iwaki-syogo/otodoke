import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

const target = "supabase/migrations/20261113121000_claude_claim_consent.sql";
const sql = existsSync(target) ? readFileSync(target, "utf8") : readFileSync("supabase/migrations/20261113090000_claude_call_global_lock.sql", "utf8");

function body(source: string, name: string) {
  return source.match(new RegExp(`create(?: or replace)? function public\\.${name}\\([\\s\\S]*?as \\$\\$([\\s\\S]*?)\\$\\$;`, "i"))?.[1] ?? "";
}

function consentContract(source: string) {
  const guard = body(source, "assert_claude_claim_consent");
  return guard.includes("from public.ai_reading_consents")
    && guard.includes("for share")
    && guard.includes("v_decision is distinct from 'granted'")
    && guard.includes("raise exception 'ai_consent_required' using errcode='42501'")
    && !guard.includes("exception when");
}

function claimPrefixContract(source: string, name: string) {
  const claim = body(source, name);
  const owner = claim.indexOf("public.lock_sample_owner(p_user_id)");
  const consent = claim.indexOf("public.assert_claude_claim_consent(p_user_id)");
  const quota = claim.indexOf(`public.${name}_before_consent_guard(`);
  return owner >= 0 && consent > owner && quota > consent;
}

describe("Claude claims enforce the current consent under a row lock", () => {
  it("locks the current choice and denies only absent/declined, preserving database errors", () => {
    expect(consentContract(sql)).toBe(true);
  });

  it("puts U/G before C and quota mutations on both standalone entry points", () => {
    expect(claimPrefixContract(sql, "claim_claude_call")).toBe(true);
    expect(claimPrefixContract(sql, "claim_claude_call_v2")).toBe(true);
  });

  it("negative controls remove the same lock, decision, or prefix protection", () => {
    expect(consentContract(sql.replace("for share", ""))).toBe(false);
    expect(consentContract(sql.replace("v_decision is distinct from 'granted'", "false"))).toBe(false);
    expect(claimPrefixContract(sql.replace("perform public.lock_sample_owner(p_user_id);", ""), "claim_claude_call")).toBe(false);
    expect(claimPrefixContract(sql.replaceAll("perform public.assert_claude_claim_consent(p_user_id);", ""), "claim_claude_call_v2")).toBe(false);
  });

  it("requires the actual 120000 setter body that takes U/G/E before C", () => {
    const previous = readFileSync("supabase/migrations/20261113120000_consent_waiting_storage.sql", "utf8");
    const setter = body(previous, "set_ai_reading");
    const digest = createHash("md5").update(setter).digest("hex");
    expect(sql).toContain(`md5(prosrc)='${digest}'`);
    expect(setter.indexOf("public.lock_sample_owner(v_user)")).toBeLessThan(setter.indexOf("from public.emails where user_id=v_user order by id for update"));
    expect(setter.indexOf("from public.emails where user_id=v_user order by id for update")).toBeLessThan(setter.indexOf("public.set_ai_reading_before_consent_storage("));
  });

  it("pairs preflight/verification/rollback and keeps bypass helpers private", () => {
    const before = readFileSync("supabase/verify/20261113121000_claude_claim_consent.before.sql", "utf8");
    const verify = readFileSync("supabase/verify/20261113121000_claude_claim_consent.sql", "utf8");
    const down = readFileSync("supabase/rollback/20261113121000_claude_claim_consent.down.sql", "utf8");
    expect(before).toContain("required_120000_setter_prefix");
    expect(before).toContain("has_table_privilege(current_user,'public.ai_reading_consents','UPDATE')");
    expect(verify).toContain("private_cores");
    expect(sql).toContain("public.claim_claude_call_v2_before_consent_guard(uuid,integer,integer) from public,anon,authenticated,service_role");
    expect(down).toContain("rename to claim_claude_call");
    expect(down).toContain("rename to claim_claude_call_v2");
    expect(down).not.toMatch(/delete from|truncate /i);
  });
});
