import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

const stem = "20261113130000_received_receipts";
const load = (part: string) => readFileSync(new URL(`../../../supabase/${part}`, import.meta.url), "utf8");
const forward = load(`migrations/${stem}.sql`);
const down = load(`rollback/${stem}.down.sql`);
const fn = (sql: string, name: string) => sql.match(new RegExp(`create or replace function public\\.${name}\\([\\s\\S]+?end \\$\\$;`))?.[0] ?? "";
const fixed = /pg_(?:try_)?advisory(?:_xact)?_lock(?:_shared)?\s*\(\s*62803\s*,\s*0\s*\)/i;

describe("receipt entrypoints join the P1 owner-lock contract", () => {
  it.each(["mark_parcels_received", "restore_parcel_receipts"])("%s calls the shared owner helper after U/G/E and before parcel rows", (name) => {
    const body = fn(forward, name);
    const helper = body.indexOf("perform public.lock_parcel_owner(v_user);");
    expect(helper).toBeGreaterThan(body.indexOf("perform e.id from public.emails"));
    expect(helper).toBeLessThan(body.indexOf("perform p.id from public.parcels"));
    expect(body).not.toMatch(fixed);
  });

  it.each([["forward", forward], ["down", down]])("%s mail core validates owner/run/lease before the shared helper and snapshot", (_label, sql) => {
    const core = fn(sql, "update_mail_parcel_without_sample_fence");
    const helper = core.indexOf("perform public.lock_parcel_owner(v_mail.user_id);");
    expect(helper).toBeGreaterThan(core.indexOf("raise exception 'mail run no longer owns the lease'"));
    expect(helper).toBeLessThan(core.indexOf("v_current := public.mail_parcel_snapshot"));
    expect(core).toContain("parcel transaction owner cannot change");
    expect(sql).not.toMatch(fixed);
  });

  it.each(["migrations/", "verify/", "rollback/", "verify-before/"])("%s validates the private helper ABI, owner and effective ACL including inherited API grants without repairing them", (directory) => {
    const suffix = directory === "rollback/" ? ".down.sql" : directory === "verify-before/" ? ".before.sql" : ".sql";
    const sql = load(`${directory === "verify-before/" ? "verify/" : directory}${stem}${suffix}`);
    expect(sql).toContain("to_regprocedure('public.lock_parcel_owner(uuid)')");
    expect(sql).toContain("p.proargnames=array['p_user']");
    expect(sql).toContain("p.proconfig=array['search_path=\"\"']");
    expect(sql).toContain("p.prosecdef");
    expect(sql).toContain("pg_get_function_result(p.oid)='void'");
    expect(sql).toContain("a.grantee=p.proowner");
    for(const role of ["anon","authenticated","service_role"]) expect(sql).toContain(`not has_function_privilege('${role}',p.oid,'EXECUTE')`);
    expect(sql).toContain("rolname=current_user");
    expect(sql).toContain("p.proowner=(select relowner from pg_class where oid=to_regclass('public.emails'))");
    const baseline=load("migrations/20261113100000_parcel_write_conflicts.sql");
    const helperBody=baseline.match(/function public\.lock_parcel_owner\(p_user uuid\)[\s\S]+?as \$\$([\s\S]+?)\$\$;/)?.[1];
    expect(helperBody).toBeTruthy();
    expect(sql).toContain(createHash("md5").update(helperBody!).digest("hex"));
    expect(sql).not.toMatch(/\b(?:alter\s+(?:function|table)[^;]*\bowner|grant\s+execute\s+on\s+function\s+public\.lock_parcel_owner)/i);
  });
  it("the verifier uses one owner scope and tests cross-owner requests without resetting it", () => {
    const verify=load(`verify/${stem}.sql`);
    expect(verify.indexOf("perform public.lock_sample_owner(v_user);")).toBeLessThan(verify.indexOf("insert into public.parcels"));
    expect(verify.indexOf("perform public.lock_parcel_owner(v_user);")).toBeLessThan(verify.indexOf("insert into public.parcels"));
    expect(verify).toContain("transaction_owner_switch_accepted");
    expect(verify).toContain("if sqlerrm is distinct from 'parcel transaction owner cannot change' then raise; end if;");
    expect(verify).not.toMatch(/set_config\('otodoke\.parcel_owner'/);
  });

  it("rollback refuses a missing sample core before writes, while repeated receipt rollback keeps its prerequisites", () => {
    const guard=down.match(/do \$receipt_down_order\$([\s\S]+?)end \$receipt_down_order\$;/)?.[1];
    expect(guard).toContain("to_regprocedure('public.lock_sample_owner(uuid)') is null");
    expect(guard).toContain("to_regprocedure('public.update_mail_parcel_without_sample_fence(jsonb,uuid,timestamptz,jsonb,jsonb,jsonb,uuid,uuid)') is null");
    expect(guard).toContain("using errcode='55000'");
    expect(down.indexOf("do $receipt_down_order$")).toBeLessThan(down.indexOf("drop function"));
    expect(down).not.toMatch(/drop function[^;]*public\.(?:lock_sample_owner|lock_parcel_owner|update_mail_parcel_without_sample_fence)\(/);
  });

});
