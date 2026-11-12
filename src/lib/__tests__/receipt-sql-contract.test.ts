import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { RECEIPT_CHUNK_SIZE } from "@/lib/receipt";

const load = (part: string) => readFileSync(new URL(`../../../supabase/${part}`, import.meta.url), "utf8");
const stem = "20261113130000_received_receipts";
const sql = load(`migrations/${stem}.sql`);
const body = (name: string) => sql.match(new RegExp(`function public\\.${name}\\([\\s\\S]+?end \\$\\$;`))?.[0] ?? "";

describe("receipt database boundary (static contract; runtime proof is the PostgreSQL runner)", () => {
  it("bounds raw request cardinality before U/G/E/L, including multidimensional SQL arrays", () => {
    const mark = body("mark_parcels_received");
    const undo = body("restore_parcel_receipts");
    expect(mark).toContain(`cardinality(p_ids)>${RECEIPT_CHUNK_SIZE}`);
    expect(mark).toContain("array_ndims(p_ids)<>1");
    expect(undo).toContain(`jsonb_array_length(p_receipts)>${RECEIPT_CHUNK_SIZE}`);
    for (const source of [mark, undo]) {
      expect(source.indexOf("22023")).toBeLessThan(source.indexOf("public.lock_sample_owner"));
      expect(source.indexOf("public.lock_sample_owner")).toBeLessThan(source.indexOf("from public.emails"));
      expect(source.indexOf("from public.emails")).toBeLessThan(source.indexOf("perform public.lock_parcel_owner(v_user);"));
      expect(source.indexOf("perform public.lock_parcel_owner(v_user);")).toBeLessThan(source.indexOf("from public.parcels"));
    }
  });

  it("stores one private cascading journal per parcel and grants only authenticated entrypoints", () => {
    expect(sql).toMatch(/parcel_id uuid primary key references public\.parcels\(id\) on delete cascade/);
    expect(sql).toMatch(/user_id uuid not null references auth\.users\(id\) on delete cascade/);
    expect(sql).toContain("parcel_receipt_undos_user_id_idx");
    expect(sql).toContain("alter table public.parcel_receipt_undos enable row level security");
    expect(sql).toContain("revoke all on public.parcel_receipt_undos from public,anon,authenticated,service_role");
    expect(sql).toContain("grant execute on function public.mark_parcels_received(uuid[]),public.restore_parcel_receipts(jsonb) to authenticated");
    expect(body("restore_parcel_receipts")).toContain("v_parcel.updated_at is distinct from v_receipt.written_updated_at");
    expect(body("restore_parcel_receipts").indexOf("from public.parcels")).toBeLessThan(body("restore_parcel_receipts").indexOf("from public.parcel_receipt_undos"));
  });

  it("a mail's empty merge advances and reads back its version through the existing fenced ABI", () => {
    const core = body("update_mail_parcel_without_sample_fence");
    expect(core).toContain("if v_noop then v_changes := jsonb_build_object('shop',v_parcel.shop)");
    expect(core).toContain("(v_saved->>'updated_at')::timestamptz is not distinct from v_parcel.updated_at");
    expect(core).toContain("mail confirmation did not advance the parcel version");
    expect(sql).not.toMatch(/create or replace function public\.(update_mail_parcel|mail_run_write|lock_sample_owner)\(/);
    expect(sql).toContain("revoke all on function public.update_mail_parcel_without_sample_fence(jsonb,uuid,timestamptz,jsonb,jsonb,jsonb,uuid,uuid) from public,anon,authenticated,service_role");
  });

  it("rollback restores the previous core exactly, and before/verify expose first-column verdicts", () => {
    const previous = load("migrations/20261113100000_parcel_write_conflicts.sql")
      .match(/create or replace function public\.update_mail_parcel\([\s\S]+?end \$\$;/)?.[0]
      .replace("public.update_mail_parcel(", "public.update_mail_parcel_without_sample_fence(");
    expect(previous).toBeTruthy();
    expect(load(`rollback/${stem}.down.sql`)).toContain(previous);
    for (const suffix of [".before.sql", ".sql"]) {
      expect(load(`verify/${stem}${suffix}`)).toMatch(/select case when[\s\S]*end as verdict,checks\.\* from checks;/);
    }
  });
  it("preserves direct parcels UPDATE grants and the existing consent purge composition", () => {
    expect(sql).not.toMatch(/\b(?:grant|revoke)\b[^;]*\bon(?:\s+table)?\s+public\.parcels\b/i);
    expect(sql).toContain("v_count:=public.purge_old_screen_events_before_receipt_retention();");
    expect(sql).toContain("return v_count+public.purge_expired_parcel_receipts();");
    expect(sql).not.toMatch(/cron\.(?:schedule|unschedule)/i);
    expect(sql).toContain("v_receipt.expires_at<=clock_timestamp()");
    expect(sql.indexOf("v_receipt.expires_at<=clock_timestamp()")).toBeLessThan(sql.indexOf("if v_receipt.undone_at is not null"));
    expect(load(`rollback/${stem}.down.sql`)).toContain("alter function public.purge_old_screen_events_before_receipt_retention() rename to purge_old_screen_events");
  });

  it("requires both real applied history and the dependency definitions before creating receipt state", () => {
    const prefix=sql.slice(0,sql.indexOf("create table"));
    expect(prefix).toContain("to_regclass('supabase_migrations.schema_migrations') is null");
    expect(prefix).toContain("if v_applied<>3 or not (");
    expect(prefix).toContain("using errcode='55000'");
    for(const fragment of ["public.lock_sample_owner(v_user);", "public.set_ai_reading_before_consent_storage(p_decision,p_text_version)", "public.assert_claude_claim_consent(p_user_id)", "public.purge_expired_consent_waiting_mail()", "public.purge_old_screen_events_before_receipt_retention()"])
      expect(prefix).toContain(fragment);
    const before=load(`verify/${stem}.before.sql`);
    expect(before).toContain("case when applied_history and dependency_footprint and shared_owner_helper_ok and receipt_execution_owner_ok and no_global_candidate_lock and no_extra_overloads");
    expect(before).not.toMatch(/\b(?:create|insert|update|delete|alter|drop)\s+(?:function|table|into|from)\b/i);
  });

});
