import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const target = "supabase/migrations/20261113120000_consent_waiting_storage.sql";
const baseline = readFileSync("supabase/migrations/20261113090000_claude_call_global_lock.sql", "utf8");
const sql = existsSync(target) ? readFileSync(target, "utf8") : baseline;

function functionBody(source: string, name: string) {
  return source.match(new RegExp(`create(?: or replace)? function public\\.${name}\\([\\s\\S]*?as \\$\\$([\\s\\S]*?)\\$\\$;`, "i"))?.[1] ?? "";
}

function storageContract(source: string) {
  const store = functionBody(source, "store_mail_run_without_sample_fence");
  const expire = functionBody(source, "expire_consent_waiting_row");
  return store.includes("filter (where consent_waiting_until is null)")
    && store.includes("v_old.consent_waiting_until <= v_now")
    && store.includes("'consent_wait_expired'::text")
    && store.includes("public.expire_consent_waiting_row(p_email_id, v_now)")
    && expire.includes("delete from public.emails")
    && store.includes("v_user_count + 1 > (p_limits->>'user_count')::bigint")
    && store.includes("v_user_bytes + v_bytes > (p_limits->>'user_bytes')::bigint");
}

function partialResultContract(source: string) {
  const expire = functionBody(source, "expire_consent_waiting_row");
  return expire.includes("if exists(select 1 from public.extractions where email_id=p_email_id) then")
    && expire.includes("body_state='dropped',processing_status='discarded'")
    && expire.includes("processing_lease_until,v_mail.created_at+interval '180 seconds')>p_now");
}

function immutableWaitingContract(source: string) {
  const mark = functionBody(source, "mark_consent_waiting_mail");
  return mark.includes("new.received_at := old.received_at")
    && mark.includes("new.consent_waiting_until := old.consent_waiting_until")
    && mark.includes("new.received_at + public.ai_consent_waiting_retention()")
    && mark.includes("new.error in ('ai_consent_required','ai_consent_unknown')");
}

describe("consent waiting storage DB contract", () => {
  it("isolates waiting storage, retains owner caps and stops expired takeover", () => {
    expect(storageContract(sql)).toBe(true);
  });

  it("preserves partial results while deleting their expired plaintext, without false processed proof", () => {
    const expire = functionBody(sql, "expire_consent_waiting_row");
    expect(partialResultContract(sql)).toBe(true);
    expect(expire).toContain("if exists(select 1 from public.extractions where email_id=p_email_id) then");
    expect(expire).toContain("subject=null,from_address=null,from_name=null,text_body=null,html_body=null");
    expect(expire).toContain("body_state='dropped',processing_status='discarded'");
    expect(expire).toContain("processing_lease_until,v_mail.created_at+interval '180 seconds')>p_now");
    expect(expire).not.toContain("processing_status='processed',");
    expect(expire).not.toContain("delete from public.extractions");
  });

  it("uses arrival time and one retention constant without retry extension", () => {
    expect(immutableWaitingContract(sql)).toBe(true);
    const mark = functionBody(sql, "mark_consent_waiting_mail");
    expect(mark).toContain("new.received_at := old.received_at");
    expect(mark).toContain("new.consent_waiting_until := old.consent_waiting_until");
    expect(mark).toContain("new.received_at + public.ai_consent_waiting_retention()");
    expect(mark).toContain("new.error in ('ai_consent_required','ai_consent_unknown')");
    expect(sql.match(/interval '14 days'/g)).toHaveLength(1);
  });

  it("extends the existing sweep without creating a schedule and locks every owner before mail", () => {
    const purge = functionBody(sql, "purge_expired_consent_waiting_mail");
    expect(purge.indexOf("-- U:")).toBeGreaterThanOrEqual(0);
    expect(purge.indexOf("-- G:")).toBeGreaterThan(purge.indexOf("-- U:"));
    expect(purge.indexOf("-- E:")).toBeGreaterThan(purge.indexOf("-- G:"));
    expect(functionBody(sql, "purge_old_screen_events")).toContain("public.purge_expired_consent_waiting_mail()");
    expect(sql).not.toMatch(/cron\.schedule\s*\(/);
  });

  it("negative controls reject removal of isolation, expiry or individual limits", () => {
    expect(storageContract(sql.replaceAll("filter (where consent_waiting_until is null)", ""))).toBe(false);
    expect(storageContract(sql.replace("v_old.consent_waiting_until <= v_now", "false"))).toBe(false);
    expect(storageContract(sql.replace("v_user_count + 1 > (p_limits->>'user_count')::bigint", "false"))).toBe(false);
    expect(storageContract(sql.replace("v_user_bytes + v_bytes > (p_limits->>'user_bytes')::bigint", "false"))).toBe(false);
    expect(partialResultContract(sql.replace("if exists(select 1 from public.extractions where email_id=p_email_id) then", "if false then"))).toBe(false);
    expect(partialResultContract(sql.replace("processing_lease_until,v_mail.created_at+interval '180 seconds')>p_now", "processing_lease_until,v_mail.created_at+interval '180 seconds')<p_now"))).toBe(false);
    const withoutUnknownMarker = sql.replace("new.error in ('ai_consent_required','ai_consent_unknown')", "false");
    expect(immutableWaitingContract(withoutUnknownMarker)).toBe(false);
  });

  it("keeps before/verify/rollback paired, with the same existing daily schedule", () => {
    const before = readFileSync("supabase/verify/20261113120000_consent_waiting_storage.before.sql", "utf8");
    const verify = readFileSync("supabase/verify/20261113120000_consent_waiting_storage.sql", "utf8");
    const down = readFileSync("supabase/rollback/20261113120000_consent_waiting_storage.down.sql", "utf8");
    for (const source of [before, verify]) expect(source).toContain("schedule='30 18 * * *'");
    expect(down).toContain("rename to store_mail_run_without_sample_fence");
    expect(down).toContain("rename to set_ai_reading");
    expect(down).toContain("rename to purge_old_screen_events");
    expect(down).toContain("drop column if exists consent_waiting_until");
    expect(down).not.toMatch(/delete from public\.(?:emails|extractions|parcels)/);
  });
});
