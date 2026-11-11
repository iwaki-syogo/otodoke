import { beforeEach, describe, expect, it, vi } from "vitest";
import { ManualParcelSchema, manualNeedsReceivedClear, manualParcelFields, manualWritesNothing, type ManualFormState } from "@/lib/manual-parcel";
import { FakeDb } from "./fake-db";

/**
 * A typed-in parcel's state has four choices: 注文済み, 発送済み, 配達済み (delivered, received_at empty)
 * and 受け取り済み (delivered, received_at set; the form value is "received"). Saving writes
 * received_at only when the choice changes it; the same choice writes nothing about it. Turning a
 * parcel into 配達済み from another status needs a second write, because the database fills
 * received_at when a signed-in session turns a parcel into delivered with it empty.
 */

const NOW = new Date("2026-11-05T03:00:00Z");
const R = "2026-11-02T00:00:00.000Z";
const input = (status: string) => ManualParcelSchema.parse({ title: "品", shop: "店", status });
const keys = (v: unknown) => Object.keys(v as object);
const saved = (status: string, received_at: string | null) => ({ category: null, status, received_at });

describe("manualParcelFields: the four choices", () => {
  it("saves 受け取り済み as delivered with received_at, for a new parcel and from another status", () => {
    expect(manualParcelFields(input("received"), NOW)).toMatchObject({ status: "delivered", received_at: NOW.toISOString() });
    expect(manualParcelFields(input("received"), NOW, saved("shipped", null))).toMatchObject({ status: "delivered", received_at: NOW.toISOString() });
  });

  it("配達済み → 受け取り済み puts received_at in", () => {
    expect(manualParcelFields(input("received"), NOW, saved("delivered", null))).toMatchObject({ status: "delivered", received_at: NOW.toISOString() });
  });

  it("受け取り済み → 配達済み empties received_at", () => {
    expect(manualParcelFields(input("delivered"), NOW, saved("delivered", R))).toMatchObject({ status: "delivered", received_at: null });
  });

  it("the same choice changes nothing about received_at (the stored time stays)", () => {
    expect(keys(manualParcelFields(input("received"), NOW, saved("delivered", R)))).not.toContain("received_at");
    expect(keys(manualParcelFields(input("delivered"), NOW, saved("delivered", null)))).not.toContain("received_at");
  });

  it("leaving delivered empties it; a status that was not and is not delivered writes none", () => {
    expect(manualParcelFields(input("shipped"), NOW, saved("delivered", R))).toMatchObject({ status: "shipped", received_at: null });
    expect(keys(manualParcelFields(input("ordered"), NOW))).not.toContain("received_at");
    expect(keys(manualParcelFields(input("shipped"), NOW, saved("ordered", null)))).not.toContain("received_at");
  });

  it("never stores the form-only value 'received' as a status", () => {
    for (const s of [undefined, saved("shipped", null), saved("delivered", null), saved("delivered", R)]) expect(manualParcelFields(input("received"), NOW, s).status).toBe("delivered");
  });

  it("asks for the second write only for 配達済み onto a parcel that is not delivered yet", () => {
    expect(manualNeedsReceivedClear("delivered")).toBe(true);
    expect(manualNeedsReceivedClear("delivered", { status: "shipped" })).toBe(true);
    expect(manualNeedsReceivedClear("delivered", { status: "delivered" })).toBe(false);
    expect(manualNeedsReceivedClear("received")).toBe(false);
    expect(manualNeedsReceivedClear("shipped", { status: "delivered" })).toBe(false);
  });
});

describe("manualWritesNothing sees the difference between 配達済み and 受け取り済み", () => {
  const stored = (status: string, received_at: string | null) => ({ title: "品", shop: "店", status, received_at, total_amount: null, requires_presence: null, ordered_at: "2026-11-05", tracking_number: null, carrier: null });
  const nothing = (choice: string, s: ReturnType<typeof stored>) => manualWritesNothing(manualParcelFields(input(choice), NOW, { ...s, category: null, expected_date: null }), s);

  it("is true when the choice is the stored state", () => {
    expect(nothing("received", stored("delivered", R))).toBe(true);
    expect(nothing("delivered", stored("delivered", null))).toBe(true);
  });

  it("is false when 配達済み ↔ 受け取り済み would change received_at", () => {
    expect(nothing("received", stored("delivered", null))).toBe(false);
    expect(nothing("delivered", stored("delivered", R))).toBe(false);
  });

  it("is false when received_at was not read, never guessed", () => {
    expect(manualWritesNothing({ title: "品", shop: "店", status: "delivered", received_at: null }, { title: "品", shop: "店", status: "delivered", total_amount: null, requires_presence: null })).toBe(false);
  });
});

/* ------------------------------------------------------------------------------------------ */
const USER = { id: "00000000-0000-4000-8000-00000000000a" };
const ID = "11111111-1111-4111-8111-111111111111";
const mocks = vi.hoisted(() => {
  class RedirectSignal extends Error {
    constructor(public url: string) {
      super(`NEXT_REDIRECT ${url}`);
    }
  }
  return {
    RedirectSignal,
    state: { db: null as unknown },
    redirect: vi.fn((url: string) => {
      throw new RedirectSignal(url);
    }),
  };
});
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect, notFound: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => Object.assign(mocks.state.db as FakeDb, { auth: { getUser: async () => ({ data: { user: USER }, error: null }) } }),
  getUser: async () => USER,
}));
const { createManualParcel, updateManualParcel } = await import("@/app/app/parcels/manual-actions");

const INITIAL: ManualFormState = { error: null, values: {} };
const form = (over: Record<string, string>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries({ title: "品", shop: "店", ordered_at: "2026-11-01", status: "shipped", id: ID, updated_at: "2026-11-01T00:00:00Z", ...over })) fd.append(k, v);
  return fd;
};
async function run(action: typeof createManualParcel, over: Record<string, string>) {
  try {
    return { state: await action(INITIAL, form(over)), redirected: false };
  } catch (err) {
    if (err instanceof mocks.RedirectSignal) return { state: undefined, redirected: true };
    throw err;
  }
}

let db: FakeDb;
const row = (over: Record<string, unknown>) => ({ id: ID, user_id: USER.id, source: "manual", shop: "店", shop_key: "other", title: "品", ordered_at: "2026-11-01", status: "shipped", received_at: null, created_at: "2026-11-01T00:00:00Z", updated_at: "2026-11-01T00:00:00Z", ...over });
beforeEach(() => {
  db = new FakeDb({ parcels: [row({})] });
  mocks.state.db = db;
});
const updates = () => db.callsOn("parcels", "update").map((q) => q.values as Record<string, unknown>);

describe("the actions write received_at as the choice says", () => {
  it("update: shipped → 配達済み is two writes, the second clears received_at", async () => {
    expect((await run(updateManualParcel, { status: "delivered" })).redirected).toBe(true);
    expect(updates()).toHaveLength(2);
    expect(updates()[0]).toMatchObject({ status: "delivered" });
    expect(updates()[1]).toEqual({ received_at: null });
  });

  it("update: shipped → 受け取り済み is one write with received_at", async () => {
    await run(updateManualParcel, { status: "received" });
    expect(updates()).toHaveLength(1);
    expect(updates()[0]).toMatchObject({ status: "delivered" });
    expect(typeof updates()[0].received_at).toBe("string");
  });

  it("update: 受け取り済み → 配達済み empties received_at in one write; saving unchanged writes no received_at", async () => {
    db = new FakeDb({ parcels: [row({ status: "delivered", received_at: R })] });
    mocks.state.db = db;
    await run(updateManualParcel, { status: "delivered" });
    expect(updates()).toHaveLength(1);
    expect(updates()[0]).toMatchObject({ status: "delivered", received_at: null });
    db = new FakeDb({ parcels: [row({ status: "delivered", received_at: R })] });
    mocks.state.db = db;
    await run(updateManualParcel, { status: "received" });
    expect(updates().every((u) => !("received_at" in u))).toBe(true);
  });

  it("create: 配達済み inserts then clears received_at; 受け取り済み inserts with it", async () => {
    await run(createManualParcel, { status: "delivered" });
    expect(db.callsOn("parcels", "insert")).toHaveLength(1);
    expect(updates()).toEqual([{ received_at: null }]);
    db = new FakeDb({ parcels: [] });
    mocks.state.db = db;
    await run(createManualParcel, { status: "received" });
    expect(updates()).toHaveLength(0);
    expect(typeof (db.callsOn("parcels", "insert")[0].values as Record<string, unknown>).received_at).toBe("string");
  });

  it("tells the person it was not saved when the second write fails", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    db.hooks.push((q) => (q.table === "parcels" && q.op === "update" && JSON.stringify(q.values) === '{"received_at":null}' ? { data: null, error: { message: "boom" } } : undefined));
    try {
      const out = await run(updateManualParcel, { status: "delivered" });
      expect(out.state?.error).toBe("保存できませんでした");
    } finally {
      log.mockRestore();
    }
  });
});

describe("the form", () => {
  it("offers the four choices and opens on the stored state", async () => {
    const { manualFormDefaults, manualStatusChoices } = await import("@/app/app/parcels/manual-form");
    expect(manualStatusChoices("shipped")).toEqual(["ordered", "shipped", "delivered", "received"]);
    const base = row({}) as never;
    expect(manualFormDefaults({ ...(base as object), status: "delivered", received_at: null } as never, "2026-11-05").status).toBe("delivered");
    expect(manualFormDefaults({ ...(base as object), status: "delivered", received_at: R } as never, "2026-11-05").status).toBe("received");
    expect(manualFormDefaults(null, "2026-11-05").status).toBe("ordered");
  });
});
