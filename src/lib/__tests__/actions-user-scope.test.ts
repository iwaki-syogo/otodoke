import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeDb } from "./fake-db";

/**
 * [SEC-N2] Server Actions that write through the user's session also name the user's id, so a
 * swap to a client without row-level security still reaches only their rows. The in-memory
 * database applies no row-level security, so the id condition alone keeps another user's rows.
 */

const USER = { id: "00000000-0000-4000-8000-00000000000a" };
const OTHER = "00000000-0000-4000-8000-0000000000ff";
const MINE = "11111111-1111-4111-8111-111111111111";
const THEIRS = "22222222-2222-4222-8222-222222222222";

const mocks = vi.hoisted(() => ({ state: { db: null as unknown, user: null as { id: string } | null } }));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn(), notFound: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => Object.assign(mocks.state.db as FakeDb, { auth: { getUser: async () => ({ data: { user: mocks.state.user }, error: null }) } }),
  getUser: async () => mocks.state.user,
}));

const { setCategory } = await import("@/app/app/category-actions");
const parcelActions = await import("@/app/app/parcel-actions");
const { markDelivered, restoreStatuses } = parcelActions;
// Added for [Feedback 3]; read through the module so the other tests run before it exists.
const markNotDelivered = (id: string) => (parcelActions as unknown as { markNotDelivered: (id: string) => Promise<{ ok: boolean }> }).markNotDelivered(id);

let db: FakeDb;
const row = (id: string, user_id: string, status: string) => ({ id, user_id, shop: "テスト店", status, category: null, category_source: null, updated_at: "2026-11-01T00:00:00Z" });

beforeEach(() => {
  db = new FakeDb({ parcels: [row(MINE, USER.id, "shipped"), row(THEIRS, OTHER, "shipped")] });
  mocks.state.db = db;
  mocks.state.user = USER;
});

describe("setCategory", () => {
  it("writes only the signed-in user's parcel", async () => {
    expect(await setCategory(THEIRS, "hobby")).toMatchObject({ ok: false });
    expect(db.find("parcels", THEIRS)!.category).toBeNull();
    expect(await setCategory(MINE, "hobby")).toEqual({ ok: true });
    expect(db.callsOn("parcels", "update").every((q) => q.filters.some((f) => f.method === "eq" && f.args[0] === "user_id" && f.args[1] === USER.id))).toBe(true);
  });
});

describe("markDelivered and restoreStatuses", () => {
  it("mark only the signed-in user's parcels", async () => {
    expect(await markDelivered([MINE, THEIRS])).toBe(1);
    expect(db.find("parcels", MINE)!.status).toBe("delivered");
    expect(db.find("parcels", THEIRS)!.status).toBe("shipped");
  });

  it("put back only the signed-in user's parcels", async () => {
    db.find("parcels", MINE)!.status = "delivered";
    db.find("parcels", THEIRS)!.status = "delivered";
    await restoreStatuses([
      { id: MINE, status: "shipped" },
      { id: THEIRS, status: "shipped" },
    ]);
    expect(db.find("parcels", MINE)!.status).toBe("shipped");
    expect(db.find("parcels", THEIRS)!.status).toBe("delivered");
  });

  it("write nothing when nobody is signed in", async () => {
    mocks.state.user = null;
    expect(await markDelivered([MINE])).toBe(0);
    await restoreStatuses([{ id: MINE, status: "ordered" }]);
    expect(db.callsOn("parcels", "update")).toHaveLength(0);
  });
});

describe("markNotDelivered", () => {
  it("puts back only the signed-in user's parcel", async () => {
    db.find("parcels", MINE)!.status = "delivered";
    db.find("parcels", THEIRS)!.status = "delivered";
    expect(await markNotDelivered(THEIRS)).toMatchObject({ ok: false });
    expect(db.find("parcels", THEIRS)!.status).toBe("delivered");
    expect(await markNotDelivered(MINE)).toEqual({ ok: true });
    expect(db.find("parcels", MINE)!.status).not.toBe("delivered");
    expect(db.find("parcels", THEIRS)!.status).toBe("delivered");
  });

  it("names the user's id on every read and update", async () => {
    db.find("parcels", MINE)!.status = "delivered";
    db.find("parcels", THEIRS)!.status = "delivered";
    await markNotDelivered(THEIRS);
    await markNotDelivered(MINE);
    const queries = db.callsOn("parcels");
    expect(db.callsOn("parcels", "update").length).toBeGreaterThanOrEqual(1);
    expect(queries.every((q) => q.filters.some((f) => f.method === "eq" && f.args[0] === "user_id" && f.args[1] === USER.id))).toBe(true);
  });

  it("writes nothing when nobody is signed in", async () => {
    db.find("parcels", MINE)!.status = "delivered";
    mocks.state.user = null;
    expect(await markNotDelivered(MINE)).toMatchObject({ ok: false });
    expect(db.callsOn("parcels", "update")).toHaveLength(0);
    expect(db.find("parcels", MINE)!.status).toBe("delivered");
  });
});
