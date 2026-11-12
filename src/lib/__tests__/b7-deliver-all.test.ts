import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { markReceivedInChunks } from "@/lib/receipt-client";
import { runUndo } from "@/lib/undo-outcome";
import type { ReceivedReceipt } from "@/lib/receipt";
import { FakeDb, type Row } from "./fake-db";

const USER = "00000000-0000-4000-8000-00000000000a";
const OTHER = "00000000-0000-4000-8000-00000000000b";
const WRITTEN = "2026-11-12T01:00:00.000Z";
const control = vi.hoisted(() => ({ db: null as unknown as FakeDb, signedIn: true, revalidate: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: control.revalidate }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => Object.assign(control.db, {
    auth: { getUser: async () => ({ data: { user: control.signedIn ? { id: USER } : null }, error: null }) },
  }),
}));
const actions = await import("@/app/app/parcel-actions");
const mark = (ids: string[]) => markReceivedInChunks(ids, actions.markDeliveredForUndo);
const restore = (items: ReceivedReceipt[]) => runUndo(actions.restoreStatuses, items);
const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
function parcels(size: number, received = false): Row[] {
  return Array.from({ length: size }, (_, i) => ({ id: id(i + 1), user_id: USER, status: received ? "delivered" : "shipped", received_at: received ? WRITTEN : null }));
}
const ids = (rows: Row[]) => rows.map((row) => String(row.id));
const chunks = (db: FakeDb, name = "mark_parcels_received") => db.rpcCalls.filter((call) => call.name === name).map((call) => {
  const args = call.args as { p_ids?: string[]; p_receipts?: unknown[] };
  return (args.p_ids ?? args.p_receipts)!.length;
});

beforeEach(() => {
  control.signedIn = true;
  control.revalidate.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.stubGlobal("fetch", () => { throw new Error("external fetch is forbidden in B7 tests"); });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("B7: full-list operations through bounded real actions", () => {
  it.each([501, 1001])("marks all %i parcels and keeps the undo for every row this press wrote", async (size) => {
    const original = parcels(size);
    const db = control.db = new FakeDb({ parcels: original });
    const done = await mark(ids(original));
    expect(done.saved).toBe(size);
    expect(done.written).toHaveLength(size);
    expect(new Set(done.written.map((row) => row.id))).toEqual(new Set(ids(original)));
    expect(db.rows("parcels").every((row) => row.status === "delivered" && row.received_at !== null)).toBe(true);
    expect(chunks(db)).toEqual(size === 501 ? [200, 200, 101] : [200, 200, 200, 200, 200, 1]);
    const back = await restore(done.written);
    expect(new Set(back.restored)).toEqual(new Set(ids(original)));
    expect(back.changed).toEqual([]);
    expect(back.failed).toEqual([]);
    expect(db.rows("parcels").every((row) => row.status === "shipped" && row.received_at === null)).toBe(true);
    expect(chunks(db, "restore_parcel_receipts").every((length) => length <= 200)).toBe(true);
  });

  it("restores all 1001 opaque receipts instead of silently stopping at the first 500", async () => {
    const original = parcels(1001);
    const db = control.db = new FakeDb({ parcels: original });
    const done = await mark(ids(original));
    const back = await restore(done.written);
    expect(back.restored).toHaveLength(1001);
    expect(back.changed).toEqual([]);
    expect(back.failed).toEqual([]);
    expect(db.rows("parcels").filter((row) => row.received_at !== null)).toHaveLength(0);
    expect(chunks(db, "restore_parcel_receipts")).toEqual([200, 200, 200, 200, 200, 1]);
  });

  it("duplicates do not consume chunks or inflate saved and undo counts", async () => {
    const original = parcels(501);
    const db = control.db = new FakeDb({ parcels: original });
    const done = await mark([...ids(original), ...ids(original), id(1)]);
    expect(done.saved).toBe(501);
    expect(done.written).toHaveLength(501);
    expect(chunks(db)).toEqual([200, 200, 101]);
    const back = await restore([...done.written, ...done.written]);
    expect(back.restored).toHaveLength(501);
    expect(back.changed).toEqual([]);
    expect(back.failed).toEqual([]);
    expect(db.rows("parcels").every((row) => row.received_at === null)).toBe(true);
  });

  it("does not claim another user's, deleted or cancelled parcels were saved", async () => {
    const original = parcels(501);
    original[499].status = "cancelled";
    original[500].user_id = OTHER;
    const db = control.db = new FakeDb({ parcels: original });
    const done = await mark([...ids(original), id(9000)]);
    expect(done.saved).toBe(499);
    expect(done.written).toHaveLength(499);
    expect(db.find("parcels", id(500))).toMatchObject({ status: "cancelled", received_at: null });
    expect(db.find("parcels", id(501))).toMatchObject({ user_id: OTHER, received_at: null });
  });

  it.each(["database unavailable", "session expired"])("keeps confirmed progress and undo when a middle chunk fails: %s", async (message) => {
    const original = parcels(1001);
    const db = control.db = new FakeDb({ parcels: original });
    let calls = 0;
    const done = await markReceivedInChunks(ids(original), async (chunk) => {
      if (++calls === 2) throw new Error(message);
      return actions.markDeliveredForUndo(chunk);
    });
    expect(calls).toBe(6);
    expect(done.saved).toBe(801);
    expect(done.written).toHaveLength(801);
    expect(db.rows("parcels").filter((row) => row.received_at !== null)).toHaveLength(801);
    expect(control.revalidate).toHaveBeenCalledWith("/app", "layout");
    const back = await restore(done.written);
    expect(back.restored).toHaveLength(801);
    expect(back.failed).toEqual([]);
    expect(db.rows("parcels").filter((row) => row.received_at !== null)).toHaveLength(0);
  });

  it("does not discard confirmed writes or an already-received result when a following response fails", async () => {
    const original = parcels(501);
    Object.assign(original[199], { status: "delivered", received_at: WRITTEN });
    const db = control.db = new FakeDb({ parcels: original });
    let calls = 0;
    const done = await markReceivedInChunks(ids(original), async (chunk) => {
      if (++calls === 2) throw new Error("lookup result not confirmed");
      return actions.markDeliveredForUndo(chunk);
    });
    expect(done.saved).toBe(301);
    expect(done.written).toHaveLength(300);
    expect(db.find("parcels", id(200))!.received_at).toBe(WRITTEN);
    expect(control.revalidate).toHaveBeenCalledWith("/app", "layout");
  });

  it("a lost middle update answer returns only confirmed receipts and a retry preserves earlier receives", async () => {
    const original = parcels(1001);
    const db = control.db = new FakeDb({ parcels: original });
    let calls = 0;
    const done = await markReceivedInChunks(ids(original), async (chunk) => {
      const confirmed = await actions.markDeliveredForUndo(chunk);
      if (++calls === 2) throw new Error("synthetic lost answer after commit");
      return confirmed;
    });
    expect(done.saved).toBe(801);
    expect(done.written).toHaveLength(801);
    expect(done.written.some((row) => row.id === id(201))).toBe(false);
    expect(db.rows("parcels").filter((row) => row.received_at !== null)).toHaveLength(1001);
    const firstTime = db.find("parcels", id(201))!.received_at;
    const retry = await mark(ids(original));
    expect(retry).toEqual({ saved: 1001, written: [] });
    expect(db.find("parcels", id(201))!.received_at).toBe(firstTime);
  });

  it("reads all 1001 already-received parcels through bounded actions without making an undo", async () => {
    const original = parcels(1001, true);
    const db = control.db = new FakeDb({ parcels: original });
    expect(await mark(ids(original))).toEqual({ saved: 1001, written: [] });
    expect(chunks(db)).toEqual([200, 200, 200, 200, 200, 1]);
  });

  it("a failed first bounded action throws instead of reporting success", async () => {
    control.db = new FakeDb({ parcels: parcels(200) });
    control.db.hooks.push((query) => query.op === "update" ? { data: null, error: { message: "not saved" } } : undefined);
    await expect(actions.markDeliveredForUndo(ids(control.db.rows("parcels")))).rejects.toThrow("not saved");
    expect(control.db.rows("parcels").every((row) => row.received_at === null)).toBe(true);
  });

  it("an expired login before starting saves nothing", async () => {
    control.signedIn = false;
    control.db = new FakeDb({ parcels: parcels(501) });
    expect(await mark(ids(control.db.rows("parcels")))).toEqual({ saved: 0, written: [] });
    expect(control.db.callsOn("parcels", "update")).toHaveLength(0);
  });

  it("a middle undo chunk failure preserves restored rows and identifies only unconfirmed receipts", async () => {
    const original = parcels(501);
    const db = control.db = new FakeDb({ parcels: original });
    const done = await mark(ids(original));
    let calls = 0;
    const back = await runUndo(async (chunk) => {
      if (++calls === 2) throw new Error("undo failed");
      return actions.restoreStatuses(chunk);
    }, done.written);
    expect(calls).toBe(3);
    expect(back.restored).toHaveLength(301);
    expect(back).toMatchObject({ failed: [], unconfirmed: done.written.slice(200, 400).map((item) => item.id) });
    expect(back.changed).toEqual([]);
    expect(db.rows("parcels").filter((row) => row.received_at !== null)).toHaveLength(200);
    expect(control.revalidate).toHaveBeenCalledWith("/app", "layout");
  });

  it("B3: an old undo across a chunk boundary leaves a newer receive untouched", async () => {
    const original = parcels(501);
    const db = control.db = new FakeDb({ parcels: original });
    const done = await mark(ids(original));
    const later = "2026-11-12T02:00:00.000Z";
    Object.assign(db.find("parcels", id(501))!, { received_at: later, updated_at: db.tick() });
    const back = await restore(done.written);
    expect(back.changed).toEqual([id(501)]);
    expect(back.restored).toHaveLength(500);
    expect(back.failed).toEqual([]);
    expect(db.find("parcels", id(501))).toMatchObject({ status: "delivered", received_at: later });
    expect(db.rows("parcels").filter((row) => row.received_at !== null)).toHaveLength(1);
    expect(chunks(db, "restore_parcel_receipts")).toHaveLength(3);
  });
});
