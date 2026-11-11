import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
const { markDelivered, markDeliveredForUndo, restoreStatuses } = await import("@/app/app/parcel-actions");

const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
function parcels(size: number, received = false): Row[] {
  return Array.from({ length: size }, (_, i) => ({ id: id(i + 1), user_id: USER, status: received ? "delivered" : "shipped", received_at: received ? WRITTEN : null }));
}
const ids = (rows: Row[]) => rows.map((row) => String(row.id));
const undo = (rows: Row[], written = WRITTEN) => rows.map((row) => ({ id: String(row.id), status: "shipped", received_at: null, written_at: written }));
const chunks = (db: FakeDb) => db.callsOn("parcels", "update").map((query) => query.filters.find((filter) => filter.method === "in" && filter.args[0] === "id")!.args[1] as string[]);

beforeEach(() => {
  control.signedIn = true;
  control.revalidate.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.stubGlobal("fetch", () => { throw new Error("external fetch is forbidden in B7 tests"); });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("B7: every requested parcel, across safe request chunks", () => {
  it.each([501, 1001])("marks all %i parcels and keeps the undo for every row this press wrote", async (size) => {
    const original = parcels(size);
    const db = control.db = new FakeDb({ parcels: original });
    const done = await markDeliveredForUndo(ids(original));
    expect(done.saved).toBe(size);
    expect(done.written).toHaveLength(size);
    expect(new Set(done.written.map((row) => row.id))).toEqual(new Set(ids(original)));
    expect(db.rows("parcels").every((row) => row.status === "delivered" && row.received_at !== null)).toBe(true);
    expect(chunks(db).map((chunk) => chunk.length)).toEqual(size === 501 ? [500, 1] : [500, 500, 1]);
    const items = done.written.map((row) => ({ id: row.id, status: "shipped", received_at: null, written_at: row.received_at }));
    expect(await restoreStatuses(items)).toEqual({ leftReceived: false });
    expect(db.rows("parcels").every((row) => row.status === "shipped" && row.received_at === null)).toBe(true);
    expect(chunks(db).every((chunk) => chunk.length <= 500)).toBe(true);
  });

  it("restores all 1001 undo entries instead of silently stopping at the first 500", async () => {
    const original = parcels(1001, true);
    const db = control.db = new FakeDb({ parcels: original });
    expect(await restoreStatuses(undo(original))).toEqual({ leftReceived: false });
    expect(db.rows("parcels").filter((row) => row.received_at !== null)).toHaveLength(0);
    expect(chunks(db).map((chunk) => chunk.length)).toEqual([500, 500, 1]);
  });

  it("duplicates do not consume chunks or inflate saved and undo counts", async () => {
    const original = parcels(501);
    const db = control.db = new FakeDb({ parcels: original });
    const requested = [...ids(original), ...ids(original), id(1)];
    const done = await markDeliveredForUndo(requested);
    expect(done.saved).toBe(501);
    expect(done.written).toHaveLength(501);
    expect(chunks(db).map((chunk) => chunk.length)).toEqual([500, 1]);
    const items = done.written.map((row) => ({ id: row.id, status: "shipped", received_at: null, written_at: row.received_at }));
    expect(await restoreStatuses([...items, ...items])).toEqual({ leftReceived: false });
    expect(db.rows("parcels").every((row) => row.received_at === null)).toBe(true);
  });

  it("does not claim another user's, deleted or cancelled parcels were saved", async () => {
    const original = parcels(501);
    original[499].status = "cancelled";
    original[500].user_id = OTHER;
    const db = control.db = new FakeDb({ parcels: original });
    const done = await markDeliveredForUndo([...ids(original), id(9000)]);
    expect(done.saved).toBe(499);
    expect(done.written).toHaveLength(499);
    expect(db.find("parcels", id(500))).toMatchObject({ status: "cancelled", received_at: null });
    expect(db.find("parcels", id(501))).toMatchObject({ user_id: OTHER, received_at: null });
  });

  it.each(["database unavailable", "session expired"])("keeps confirmed progress and undo after a later chunk fails: %s", async (message) => {
    const original = parcels(1001);
    const db = control.db = new FakeDb({ parcels: original });
    let calls = 0;
    db.hooks.push((query) => {
      if (query.table === "parcels" && query.op === "update" && ++calls === 2) return { data: null, error: { code: "42501", message } };
    });
    const done = await markDeliveredForUndo(ids(original));
    expect(calls).toBe(2);
    expect(done.saved).toBe(500);
    expect(done.written).toHaveLength(500);
    expect(db.rows("parcels").filter((row) => row.received_at !== null)).toHaveLength(500);
    expect(control.revalidate).toHaveBeenCalledWith("/app", "layout");
    db.hooks.length = 0;
    expect(await restoreStatuses(done.written.map((row) => ({ id: row.id, status: "shipped", received_at: null, written_at: row.received_at })))).toEqual({ leftReceived: false });
    expect(db.rows("parcels").filter((row) => row.received_at !== null)).toHaveLength(0);
  });

  it("does not discard confirmed writes when the already-received lookup fails", async () => {
    const original = parcels(501);
    Object.assign(original[499], { status: "delivered", received_at: WRITTEN });
    const db = control.db = new FakeDb({ parcels: original });
    db.hooks.push((query) => query.table === "parcels" && query.op === "select" ? { data: null, error: { message: "lookup failed" } } : undefined);
    const done = await markDeliveredForUndo(ids(original));
    expect(done.saved).toBe(499);
    expect(done.written).toHaveLength(499);
    expect(control.revalidate).toHaveBeenCalledWith("/app", "layout");
  });

  it("a lost later update answer returns only confirmed undo rows, and a retry preserves earlier receives", async () => {
    const original = parcels(1001);
    const db = control.db = new FakeDb({ parcels: original });
    const execute = db.execute.bind(db);
    let writes = 0;
    db.execute = (query) => {
      const result = execute(query);
      // The server committed the second chunk, but its answer never reached this call.
      if (query.table === "parcels" && query.op === "update" && ++writes === 2) return { data: null, error: { message: "synthetic lost answer" } };
      return result;
    };
    const done = await markDeliveredForUndo(ids(original));
    expect(done.saved).toBe(500);
    expect(done.written.map((row) => row.id)).toEqual(ids(original).slice(0, 500));
    expect(db.rows("parcels").filter((row) => row.received_at !== null)).toHaveLength(1000);
    expect(control.revalidate).toHaveBeenCalledWith("/app", "layout");
    const firstTime = db.find("parcels", id(501))!.received_at;
    const retry = await markDeliveredForUndo(ids(original));
    expect(retry.saved).toBe(1001);
    expect(retry.written.map((row) => row.id)).toEqual([id(1001)]);
    expect(db.find("parcels", id(501))!.received_at).toBe(firstTime);
  });

  it("reads back all 1001 already-received parcels through bounded chunks without making an undo", async () => {
    const original = parcels(1001, true);
    const db = control.db = new FakeDb({ parcels: original });
    expect(await markDeliveredForUndo(ids(original))).toEqual({ saved: 1001, written: [] });
    const lookups = db.callsOn("parcels", "select");
    expect(lookups).toHaveLength(3);
    for (const query of lookups) {
      const requested = query.filters.find((filter) => filter.method === "in")!.args[1] as string[];
      expect(requested.length).toBeLessThanOrEqual(500);
    }
  });

  it("a failed first chunk throws instead of reporting success", async () => {
    control.db = new FakeDb({ parcels: parcels(501) });
    control.db.hooks.push((query) => query.op === "update" ? { data: null, error: { message: "not saved" } } : undefined);
    await expect(markDeliveredForUndo(ids(control.db.rows("parcels")))).rejects.toThrow("not saved");
    expect(control.db.rows("parcels").every((row) => row.received_at === null)).toBe(true);
  });

  it("an expired login before starting saves nothing", async () => {
    control.signedIn = false;
    control.db = new FakeDb({ parcels: parcels(501) });
    expect(await markDelivered(ids(control.db.rows("parcels")))).toBe(0);
    expect(control.db.callsOn("parcels", "update")).toHaveLength(0);
  });

  it("a later undo chunk failure reports partial restoration and refreshes the changed list", async () => {
    const original = parcels(501, true);
    const db = control.db = new FakeDb({ parcels: original });
    let calls = 0;
    db.hooks.push((query) => query.table === "parcels" && query.op === "update" && ++calls === 2 ? { data: null, error: { message: "undo failed" } } : undefined);
    expect(await restoreStatuses(undo(original))).toEqual({ leftReceived: true });
    expect(calls).toBe(2);
    expect(db.rows("parcels").filter((row) => row.received_at !== null)).toHaveLength(1);
    expect(control.revalidate).toHaveBeenCalledWith("/app", "layout");
  });

  it("B3: an old undo across the chunk boundary leaves a newer receive untouched", async () => {
    const original = parcels(501, true);
    const db = control.db = new FakeDb({ parcels: original });
    const later = "2026-11-12T02:00:00.000Z";
    db.find("parcels", id(501))!.received_at = later;
    expect(await restoreStatuses(undo(original))).toEqual({ leftReceived: true });
    expect(db.find("parcels", id(501))).toMatchObject({ status: "delivered", received_at: later });
    expect(db.rows("parcels").filter((row) => row.received_at !== null)).toHaveLength(1);
    expect(chunks(db)).toHaveLength(2);
  });
});
