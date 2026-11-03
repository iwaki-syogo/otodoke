import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeDb } from "./fake-db";

/**
 * setCategory(id, category) in src/app/app/category-actions.ts ("use server").
 * Runs with the user's session (row-level security). A refusal may be a thrown error or a
 * `{ ok: false, ... }` answer; either way nothing is written.
 */

const USER = { id: "00000000-0000-4000-8000-00000000000a" };
const PARCEL_ID = "11111111-1111-4111-8111-111111111111";
const MISSING_ID = "33333333-3333-4333-8333-333333333333";

const mocks = vi.hoisted(() => ({
  state: { db: null as unknown, user: null as { id: string } | null },
  revalidatePath: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath, revalidateTag: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn(), notFound: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => Object.assign(mocks.state.db as FakeDb, { auth: { getUser: async () => ({ data: { user: mocks.state.user }, error: null }) } }),
  getUser: async () => mocks.state.user,
}));

const { setCategory } = await import("@/app/app/category-actions");

async function outcome(run: () => Promise<unknown>): Promise<"ok" | "refused"> {
  try {
    const r = await run();
    return r && typeof r === "object" && "ok" in r && (r as { ok: unknown }).ok === false ? "refused" : "ok";
  } catch {
    return "refused";
  }
}

let db: FakeDb;

beforeEach(() => {
  mocks.revalidatePath.mockClear();
  db = new FakeDb({
    parcels: [{ id: PARCEL_ID, user_id: USER.id, shop: "テスト店", category: "food", category_source: "auto", created_at: "2026-11-01T00:00:00Z", updated_at: "2026-11-01T00:00:00Z" }],
  });
  mocks.state.db = db;
  mocks.state.user = USER;
});

type Arg = Parameters<typeof setCategory>[1];

describe("setCategory", () => {
  it("refuses when nobody is signed in, without writing", async () => {
    mocks.state.user = null;
    expect(await outcome(() => setCategory(PARCEL_ID, "hobby"))).toBe("refused");
    expect(db.calls.filter((q) => q.op !== "select")).toHaveLength(0);
    expect(db.find("parcels", PARCEL_ID)!.category).toBe("food");
  });

  it("refuses an id that is not a uuid before the database", async () => {
    expect(await outcome(() => setCategory("not-a-uuid", "hobby"))).toBe("refused");
    expect(db.calls).toHaveLength(0);
  });

  it("refuses a category outside the seven before the database", async () => {
    expect(await outcome(() => setCategory(PARCEL_ID, "toys" as Arg))).toBe("refused");
    expect(db.calls).toHaveLength(0);
  });

  it("writes the category as the user's and checks one row came back", async () => {
    expect(await outcome(() => setCategory(PARCEL_ID, "hobby"))).toBe("ok");
    const row = db.find("parcels", PARCEL_ID)!;
    expect(row.category).toBe("hobby");
    expect(row.category_source).toBe("user");
    const update = db.callsOn("parcels", "update")[0];
    expect(update.values).toEqual({ category: "hobby", category_source: "user" });
    expect(update.filters).toContainEqual({ method: "eq", args: ["id", PARCEL_ID] });
    expect(update.returning).toMatch(/\bid\b/);
    expect(mocks.revalidatePath).toHaveBeenCalled();
  });

  it("refuses when no row was changed", async () => {
    expect(await outcome(() => setCategory(MISSING_ID, "hobby"))).toBe("refused");
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });
});
