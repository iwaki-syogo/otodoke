import { describe, expect, it } from "vitest";
import { processInboundEmail } from "@/lib/pipeline";
import { FakeDb, MAIL_RUN_ALLOWED_COLUMNS } from "./fake-db";
import { USER, asAdmin, mailOf, precomputed, reading, sure } from "./pipeline-fixtures";

const RECEIVED = "2026-11-02T00:00:00.000Z";
const TRACKING = "123456789012";
const base = { user_id: USER, shop: "Synthetic shop", shop_key: "other", created_at: "2026-11-01T00:00:00Z", updated_at: "2026-11-01T00:00:00Z", last_email_at: "2026-11-01T00:00:00Z" };

describe("mail gateway column contract from the real SQL", () => {
  it("reads every table allowlist instead of using a permissive fake", () => {
    expect([...MAIL_RUN_ALLOWED_COLUMNS.keys()].sort()).toEqual(["emails", "extractions", "parcel_items", "parcels"]);
    for (const columns of MAIL_RUN_ALLOWED_COLUMNS.values()) expect(columns.size).toBeGreaterThan(0);
  });

  it("accepts the real pipeline merge payload carrying an absorbed parcel's received_at", async () => {
    const db = new FakeDb({
      emails: [{ id: "mail-order", user_id: USER, sent_at: "2026-11-01T00:00:00Z" }, { id: "mail-carrier", user_id: USER, sent_at: "2026-11-02T00:00:00Z" }],
      parcels: [
        { ...base, id: "keep", order_number: "ORD-12345678", status: "ordered" },
        { ...base, id: "absorb", shop: "送り主不明", tracking_number: TRACKING, status: "delivered", received_at: RECEIVED, created_at: "2026-11-02T00:00:00Z" },
      ],
      extractions: [
        { id: "order-reading", user_id: USER, email_id: "mail-order", parcel_id: "keep", result: reading({ relevance: "order", order_number: sure("ORD-12345678") }) },
        { id: "carrier-reading", user_id: USER, email_id: "mail-carrier", parcel_id: "absorb", result: reading({ relevance: "shipped", shop_name: null, tracking_number: sure(TRACKING) }) },
      ],
    });
    await processInboundEmail(asAdmin(db), mailOf("2026-11-03T01:00:00Z"), {
      precomputed: precomputed(reading({ relevance: "shipped", order_number: sure("ORD-12345678"), tracking_number: sure(TRACKING) })),
    });
    expect(db.find("parcels", "absorb")).toBeUndefined();
    expect(db.find("parcels", "keep")).toMatchObject({ status: "delivered", received_at: RECEIVED });
    const writes = db.rpcCalls.filter((call) => call.name === "mail_run_write").map((call) => call.args as { p_table: string; p_operation: string; p_values: Record<string, unknown> | Record<string, unknown>[] });
    expect(writes.some((call) => call.p_table === "parcels" && !Array.isArray(call.p_values) && call.p_values?.received_at === RECEIVED)).toBe(true);
    for (const write of writes.filter((call) => ["insert", "update"].includes(call.p_operation))) {
      const values = Array.isArray(write.p_values) ? write.p_values : [write.p_values];
      for (const value of values) expect(Object.keys(value).filter((key) => !MAIL_RUN_ALLOWED_COLUMNS.get(write.p_table)?.has(key))).toEqual([]);
    }
  });

  it.each(["emails", "extractions", "parcel_items", "parcels"])("still rejects an unknown %s column", async (table) => {
    const db = new FakeDb({ emails: [{ id: "active-mail", user_id: USER, processing_status: "pending", processing_run_id: "active-run", processing_lease_until: new Date(Date.now() + 360_000).toISOString() }] });
    const result = await db.rpc("mail_run_write", { p_email_id: "active-mail", p_run_id: "active-run", p_table: table, p_operation: "update", p_values: { unsupported_mail_column: true }, p_filters: [] });
    expect(result).toMatchObject({ data: null, error: { code: "22023", message: "unsupported mail column" } });
  });
});
