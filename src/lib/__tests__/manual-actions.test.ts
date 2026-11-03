import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ManualFormState } from "@/lib/manual-parcel";
import { FakeDb, type Query } from "./fake-db";

/**
 * Server Actions for parcels typed in by hand (src/app/app/parcels/manual-actions.ts).
 * Each is `(prevState: ManualFormState, formData: FormData) => Promise<ManualFormState>`;
 * ManualFormState is `{ error: string | null; values: Record<string, string> }` and, on an
 * error, `values` gives back what was sent so the form can refill its fields.
 * The user's own session client (row-level security) does the writes; user_id comes from the
 * session, never from the form.
 */

const USER = { id: "00000000-0000-4000-8000-00000000000a" };
const OTHER_ID = "00000000-0000-4000-8000-00000000000b";
const MANUAL_ID = "11111111-1111-4111-8111-111111111111";
const MAIL_ID = "22222222-2222-4222-8222-222222222222";
const MISSING_ID = "33333333-3333-4333-8333-333333333333";

const mocks = vi.hoisted(() => {
  class RedirectSignal extends Error {
    constructor(public url: string) {
      super(`NEXT_REDIRECT ${url}`);
    }
  }
  return {
    RedirectSignal,
    state: { db: null as unknown, user: null as { id: string } | null },
    revalidatePath: vi.fn(),
    redirect: vi.fn((url: string) => {
      throw new RedirectSignal(url);
    }),
  };
});

vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath, revalidateTag: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect, notFound: vi.fn(() => mocks.redirect("/404")) }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => {
    const db = mocks.state.db as FakeDb;
    return Object.assign(db, { auth: { getUser: async () => ({ data: { user: mocks.state.user }, error: null }) } });
  },
  getUser: async () => mocks.state.user,
}));

const { createManualParcel, updateManualParcel, deleteManualParcel } = await import("@/app/app/parcels/manual-actions");

const INITIAL: ManualFormState = { error: null, values: {} };

function formData(values: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(values)) fd.append(k, v);
  return fd;
}

const fields = (over: Record<string, string> = {}): Record<string, string> => ({
  title: "テスト用の品名",
  shop: "テスト雑貨店",
  ordered_at: "2026-11-01",
  expected_date: "2026-11-10",
  total_amount: "2480",
  category: "hobby",
  tracking_number: "1234-5678-9012",
  carrier: "yamato",
  presence: "face",
  status: "shipped",
  ...over,
});

type Outcome = { state: ManualFormState | undefined; redirectedTo: string | null };

async function run(action: (prev: ManualFormState, fd: FormData) => Promise<ManualFormState>, values: Record<string, string>): Promise<Outcome> {
  try {
    return { state: await action(INITIAL, formData(values)), redirectedTo: null };
  } catch (err) {
    if (err instanceof mocks.RedirectSignal) return { state: undefined, redirectedTo: err.url };
    throw err;
  }
}

let db: FakeDb;
const parcelQueries = () => db.calls.filter((q: Query) => q.table === "parcels");

beforeEach(() => {
  mocks.revalidatePath.mockClear();
  mocks.redirect.mockClear();
  db = new FakeDb({
    parcels: [
      { id: MANUAL_ID, user_id: USER.id, source: "manual", shop: "手入力の店", shop_key: "other", title: "手入力の品名", status: "ordered", created_at: "2026-11-01T00:00:00Z", updated_at: "2026-11-01T00:00:00Z" },
      { id: MAIL_ID, user_id: USER.id, source: "mail", shop: "メールの店", shop_key: "other", title: "メールの品名", status: "shipped", created_at: "2026-11-01T00:00:00Z", updated_at: "2026-11-01T00:00:00Z" },
    ],
  });
  mocks.state.db = db;
  mocks.state.user = USER;
});

describe("createManualParcel", () => {
  it("refuses when nobody is signed in, without touching the database", async () => {
    mocks.state.user = null;
    const { state } = await run(createManualParcel, fields());
    expect(state?.error).toBeTruthy();
    expect(db.calls).toHaveLength(0);
  });

  it("refuses invalid input before the database and gives back what was sent", async () => {
    const sent = fields({ expected_date: "2026-02-30", title: "入力した品名" });
    const { state } = await run(createManualParcel, sent);
    expect(state?.error).toBeTruthy();
    expect(state?.values.title).toBe("入力した品名");
    expect(state?.values.expected_date).toBe("2026-02-30");
    expect(db.calls).toHaveLength(0);
  });

  it.each([
    ["an amount over the limit", { total_amount: "10000001" }],
    ["a negative amount", { total_amount: "-5" }],
    ["a category outside the list", { category: "toys" }],
    ["a status outside the list", { status: "cancelled" }],
  ])("refuses %s without touching the database", async (_label, over) => {
    const { state } = await run(createManualParcel, fields(over));
    expect(state?.error).toBeTruthy();
    expect(db.calls).toHaveLength(0);
  });

  it("writes the parcel as the signed-in user, ignoring a user_id in the form", async () => {
    await run(createManualParcel, fields({ user_id: OTHER_ID }));
    const created = db.rows("parcels").filter((r) => r.id !== MANUAL_ID && r.id !== MAIL_ID);
    expect(created).toHaveLength(1);
    expect(created[0].user_id).toBe(USER.id);
    expect(created[0].source).toBe("manual");
    expect(created[0].shop_key).toBe("other");
    expect(created[0].title).toBe("テスト用の品名");
    expect(created[0].total_amount).toBe(2480);
    expect(created[0].category).toBe("hobby");
    expect(created[0].category_source).toBe("user");
    expect(created[0].tracking_number).toBe("123456789012");
    expect(created[0].tracking_url).toBeNull();
    expect(mocks.revalidatePath).toHaveBeenCalled();
  });

  it("does not write parcel_items", async () => {
    await run(createManualParcel, fields());
    expect(db.calls.filter((q) => q.table === "parcel_items")).toHaveLength(0);
  });
});

describe("updateManualParcel", () => {
  it("refuses when nobody is signed in", async () => {
    mocks.state.user = null;
    const { state } = await run(updateManualParcel, fields({ id: MANUAL_ID }));
    expect(state?.error).toBeTruthy();
    expect(db.calls).toHaveLength(0);
  });

  it("refuses an id that is not a uuid without touching the database", async () => {
    const { state } = await run(updateManualParcel, fields({ id: "not-a-uuid" }));
    expect(state?.error).toBeTruthy();
    expect(db.calls).toHaveLength(0);
  });

  it("updates only a typed-in parcel, and checks one row came back", async () => {
    await run(updateManualParcel, fields({ id: MANUAL_ID, title: "直した品名" }));
    expect(db.find("parcels", MANUAL_ID)!.title).toBe("直した品名");
    const updates = parcelQueries().filter((q) => q.op === "update");
    expect(updates).toHaveLength(1);
    expect(updates[0].filters).toContainEqual({ method: "eq", args: ["source", "manual"] });
    expect(updates[0].filters).toContainEqual({ method: "eq", args: ["id", MANUAL_ID] });
    expect(updates[0].returning).toMatch(/\bid\b/);
    expect(mocks.revalidatePath).toHaveBeenCalled();
  });

  it("answers 「見つかりません」 for a mail parcel and leaves it unchanged", async () => {
    const { state } = await run(updateManualParcel, fields({ id: MAIL_ID, title: "書き換え" }));
    expect(state?.error).toContain("見つかりません");
    expect(state?.values.title).toBe("書き換え");
    expect(db.find("parcels", MAIL_ID)!.title).toBe("メールの品名");
  });

  it("answers 「見つかりません」 when no row matches", async () => {
    const { state } = await run(updateManualParcel, fields({ id: MISSING_ID }));
    expect(state?.error).toContain("見つかりません");
  });

  it("clears the category and who set it when the category is emptied", async () => {
    await run(updateManualParcel, fields({ id: MANUAL_ID, category: "" }));
    const row = db.find("parcels", MANUAL_ID)!;
    expect(row.category).toBeNull();
    expect(row.category_source).toBeNull();
  });
});

describe("deleteManualParcel", () => {
  it("refuses when nobody is signed in", async () => {
    mocks.state.user = null;
    const { state } = await run(deleteManualParcel, { id: MANUAL_ID });
    expect(state?.error).toBeTruthy();
    expect(db.find("parcels", MANUAL_ID)).toBeDefined();
  });

  it("refuses an id that is not a uuid without touching the database", async () => {
    const { state } = await run(deleteManualParcel, { id: "1 or 1=1" });
    expect(state?.error).toBeTruthy();
    expect(db.calls).toHaveLength(0);
  });

  it("deletes a typed-in parcel, then goes to /app", async () => {
    const { redirectedTo } = await run(deleteManualParcel, { id: MANUAL_ID });
    expect(db.find("parcels", MANUAL_ID)).toBeUndefined();
    const deletes = parcelQueries().filter((q) => q.op === "delete");
    expect(deletes).toHaveLength(1);
    expect(deletes[0].filters).toContainEqual({ method: "eq", args: ["source", "manual"] });
    expect(deletes[0].returning).toMatch(/\bid\b/);
    expect(mocks.revalidatePath).toHaveBeenCalled();
    expect(redirectedTo).toBe("/app");
  });

  it("answers 「見つかりません」 for a mail parcel and keeps it", async () => {
    const { state, redirectedTo } = await run(deleteManualParcel, { id: MAIL_ID });
    expect(state?.error).toContain("見つかりません");
    expect(redirectedTo).toBeNull();
    expect(db.find("parcels", MAIL_ID)).toBeDefined();
  });
});
