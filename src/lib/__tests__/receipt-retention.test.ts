import { existsSync, readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeDb } from "./fake-db";

const USER = "00000000-0000-4000-8000-000000000001";
const ID = "00000000-0000-4000-8000-000000000010";
const state = vi.hoisted(() => ({ db: null as unknown as FakeDb }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => Object.assign(state.db, { auth: { getUser: async () => ({ data: { user: { id: USER } }, error: null }) } }) }));
const actions = await import("@/app/app/parcel-actions");
const row = () => ({ id: ID, user_id: USER, shop: "Synthetic receipt shop", status: "shipped", received_at: null });
const source = (part: string) => {
  const url = new URL(`../../../supabase/${part}`, import.meta.url);
  return existsSync(url) ? readFileSync(url, "utf8") : "";
};
const stem = "20261113130000_received_receipts";

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime("2026-11-13T00:00:00Z"); state.db = new FakeDb({ parcels: [row()] }); vi.stubGlobal("fetch", () => { throw new Error("external fetch is forbidden in receipt retention tests"); }); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("receipt retention and prerequisite boundary", () => {
  it("stores one creation-based 24-hour deadline and repeated receives never extend it", async () => {
    await actions.markDeliveredForUndo([ID]);
    const journal = state.db.rows("parcel_receipt_undos")[0];
    expect(journal).toBeDefined();
    expect(Date.parse(String(journal.expires_at)) - Date.parse(String(journal.created_at))).toBe(24 * 60 * 60 * 1000);
    const before = structuredClone(journal);
    vi.setSystemTime("2026-11-13T23:59:59Z");
    await actions.markDeliveredForUndo([ID]);
    expect(state.db.rows("parcel_receipt_undos")).toEqual([before]);
  });

  it("an expired undo cannot restore the old status even before physical cleanup", async () => {
    const marked = await actions.markDeliveredForUndo([ID]);
    const receipt = marked.written[0];
    vi.setSystemTime("2026-11-14T00:00:00Z");
    expect(await actions.restoreStatuses([receipt])).toEqual({restored:[],changed:[],failed:[ID]});
    expect(state.db.find("parcels", ID)).toMatchObject({ status: "delivered" });
    expect(state.db.find("parcels", ID)!.received_at).not.toBeNull();
  });

  it("the existing daily purge removes expired journals and keeps consent expiry active", async () => {
    const marked = await actions.markDeliveredForUndo([ID]);
    state.db.rows("emails").push({ id: "expired-consent", user_id: USER, received_at: "2026-10-01T00:00:00Z", consent_waiting_until: "2026-10-15T00:00:00Z", body_state: "plain", processing_status: "failed" });
    vi.setSystemTime("2026-11-14T00:00:01Z");
    await state.db.rpc("purge_old_screen_events");
    expect(state.db.rows("parcel_receipt_undos")).toEqual([]);
    expect(state.db.find("emails", "expired-consent")).toBeUndefined();
    expect(state.db.find("parcels", ID)).toMatchObject({ status: "delivered", received_at: marked.written[0].received_at });
  });

  it("undo and its same-token replay work just before expiry without renewing the deadline", async () => {
    const marked=await actions.markDeliveredForUndo([ID]);
    const expiry=state.db.rows("parcel_receipt_undos")[0].expires_at;
    vi.setSystemTime("2026-11-13T23:59:59.999Z");
    expect(await actions.restoreStatuses(marked.written)).toEqual({restored:[ID],changed:[],failed:[]});
    expect(await actions.restoreStatuses(marked.written)).toEqual({restored:[ID],changed:[],failed:[]});
    expect(state.db.rows("parcel_receipt_undos")[0].expires_at).toBe(expiry);
    vi.setSystemTime("2026-11-14T00:00:00.000Z");
    expect(await actions.restoreStatuses(marked.written)).toEqual({restored:[],changed:[],failed:[ID]});
    expect(state.db.find("parcels",ID)).toMatchObject({status:"shipped",received_at:null});
  });

  it("a journal expiring while the operation waits is checked against the current clock", async () => {
    const marked=await actions.markDeliveredForUndo([ID]);
    vi.setSystemTime("2026-11-13T23:59:59.999Z");
    const rpc=state.db.rpc.bind(state.db);
    state.db.rpc=async(name,args)=>{
      if(name==="restore_parcel_receipts") vi.setSystemTime("2026-11-14T00:00:00.001Z");
      return rpc(name,args);
    };
    expect(await actions.restoreStatuses(marked.written)).toEqual({restored:[],changed:[],failed:[ID]});
    expect(state.db.find("parcels",ID)!.received_at).not.toBeNull();
  });

  it.each(["20261113110000", "20261113120000", "20261113121000"])("requires the actually recorded %s before any receipt DDL", (version) => {
    const before = source(`verify/${stem}.before.sql`);
    const migration = source(`migrations/${stem}.sql`);
    expect(before).toContain("supabase_migrations.schema_migrations");
    expect(before).toContain(version);
    expect(migration).toContain(version);
    expect(migration.indexOf("supabase_migrations.schema_migrations")).toBeLessThan(migration.indexOf("create table"));
    expect(migration).toContain("55000");
  });
});
