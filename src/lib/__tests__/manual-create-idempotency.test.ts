import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ManualFormState } from "@/lib/manual-parcel";
import { spendTotal } from "@/lib/spend";
import { FakeDb } from "./fake-db";

const USER = { id: "00000000-0000-4000-8000-00000000000a" };
const INTENT = "11111111-1111-4111-8111-111111111111";
const OTHER_INTENT = "22222222-2222-4222-8222-222222222222";
const OTHER_USER = "00000000-0000-4000-8000-00000000000b";
const INITIAL: ManualFormState = { error: null, values: {} };

const mocks = vi.hoisted(() => {
  class RedirectSignal extends Error {
    constructor(public url: string) { super(`NEXT_REDIRECT ${url}`); }
  }
  return { RedirectSignal, db: null as unknown, revalidate: vi.fn() };
});
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidate }));
vi.mock("next/navigation", () => ({ redirect: (url: string) => { throw new mocks.RedirectSignal(url); } }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => Object.assign(mocks.db as FakeDb, {
    auth: { getUser: async () => ({ data: { user: USER }, error: null }) },
  }),
}));

const { createManualParcel } = await import("@/app/app/parcels/manual-actions");

function form(status: string): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries({
    expectedUserId: USER.id, intentId: INTENT, title: "合成の手入力荷物", shop: "テスト雑貨店",
    ordered_at: "2026-11-01", expected_date: "2026-11-10", total_amount: "2480",
    category: "hobby", tracking_number: "1234-5678-9012", carrier: "yamato", presence: "face", status,
  })) data.set(key, value);
  return data;
}

async function submit(previous: ManualFormState, data: FormData) {
  try {
    return { state: await createManualParcel(previous, data), destination: null };
  } catch (error) {
    if (error instanceof mocks.RedirectSignal) return { state: undefined, destination: error.url };
    throw error;
  }
}

function spending(db: FakeDb) {
  return spendTotal(db.rows("parcels").filter((row) => row.user_id === USER.id).map((row) => {
    const { ordered_at, total_amount, category } = row;
    if (typeof ordered_at !== "string" || typeof total_amount !== "number"
      || (category !== null && typeof category !== "string")) throw new Error("stored spend fixture is incomplete");
    return { ordered_at, total_amount, category };
  }));
}

function database(lostReply = false) {
  const db = new FakeDb();
  mocks.db = db;
  db.hooks.push((query) => {
    if (query.table !== "parcels" || query.op !== "insert") return;
    const values = query.values;
    if (values && typeof values === "object" && !Array.isArray(values) && "id" in values
      && typeof values.id === "string" && db.rows("parcels").some((row) => row.id === values.id)) {
      return { data: null, error: { code: "23505", message: "synthetic parcels primary-key conflict" } };
    }
  });
  const execute = db.execute.bind(db);
  let lost = false;
  vi.spyOn(db, "execute").mockImplementation((query) => {
    const result = execute(query);
    if (query.table === "parcels" && query.op === "insert" && !result.error) {
      // Model the real received trigger's sentinel conversion, without changing the shared fake.
      for (const row of db.rows("parcels")) if (row.received_at === "-infinity") row.received_at = null;
      if (lostReply && !lost) {
        lost = true;
        return { data: null, error: { message: "synthetic reply lost after commit" } };
      }
    }
    return result;
  });
  return db;
}

async function committedForm(status = "shipped") {
  const db = database(true);
  const data = form(status);
  const first = await submit(INITIAL, data);
  if (!first.state || first.destination !== null || db.rows("parcels").length !== 1) {
    throw new Error("the setup must commit once and lose only its response");
  }
  return { db, data, state: first.state };
}

function expectHeld(result: Awaited<ReturnType<typeof submit>>, db: FakeDb, before: unknown) {
  expect(result.destination).toBeNull();
  expect(result.state?.error).toBeTruthy();
  expect(result.state?.values.intentId).toBe(INTENT);
  expect(db.rows("parcels")).toEqual(before);
  expect(db.callsOn("parcels", "update")).toHaveLength(0);
  expect(db.callsOn("parcels", "upsert")).toHaveLength(0);
  expect(fetch).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-12T00:00:00Z"));
  mocks.revalidate.mockClear();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("external requests are forbidden"); }));
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("a manual creation keeps one form intent after a committed insert loses its reply", () => {
  it.each(["shipped", "received"])("stores and counts a %s parcel only once when that form is submitted again", async (status) => {
    const db = new FakeDb();
    mocks.db = db;
    // FakeDb's generic INSERT does not model the real parcels UUID primary key.
    // Model that constraint only; identical values with a different id remain legal.
    db.hooks.push((query) => {
      if (query.table !== "parcels" || query.op !== "insert") return;
      const values = query.values;
      if (values && typeof values === "object" && !Array.isArray(values) && "id" in values
        && typeof values.id === "string" && db.rows("parcels").some((row) => row.id === values.id)) {
        return { data: null, error: { code: "23505", message: "synthetic parcels primary-key conflict" } };
      }
    });
    const execute = db.execute.bind(db);
    let repliesLost = 0;
    vi.spyOn(db, "execute").mockImplementation((query) => {
      const result = execute(query);
      if (query.table === "parcels" && query.op === "insert" && !result.error && repliesLost === 0) {
        repliesLost++;
        // Commit the real stateful fake write first; lose only the response to this action.
        return { data: null, error: { message: "synthetic reply lost after commit" } };
      }
      return result;
    });

    const sameForm = form(status);
    const first = await submit(INITIAL, sameForm);
    expect(repliesLost).toBe(1);
    expect(first.destination).toBeNull();
    expect(first.state).toMatchObject({ error: "保存できませんでした", values: { intentId: INTENT } });
    expect(db.rows("parcels")).toHaveLength(1);
    expect(db.rows("parcels")[0]).toMatchObject({ order_number: null, needs_review: false, check_dismissed_at: null });
    expect(db.rows("parcels")[0].created_at).toBe(db.rows("parcels")[0].updated_at);
    expect(spending(db)).toEqual({ total: 2480, priced: 1, unpriced: 0 });
    const committed = structuredClone(db.rows("parcels"));
    const committedId = committed[0].id;
    if (typeof committedId !== "string" || !first.state) throw new Error("the first write must be committed before retry");

    // The same form is retried later, including a time-derived received_at when selected.
    vi.setSystemTime(new Date("2026-11-12T00:00:05Z"));
    const again = await submit(first.state, sameForm);
    expect({ rows: db.rows("parcels").length, spend: spending(db) }).toEqual({
      rows: 1, spend: { total: 2480, priced: 1, unpriced: 0 },
    });
    expect(db.rows("parcels")).toEqual(committed);
    expect(committedId).toBe(INTENT);
    expect(again.state).toBeUndefined();
    expect(again.destination).toBe(`/app/parcels/${committedId}`);
    expect(mocks.revalidate).toHaveBeenCalledWith("/app", "layout");
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["shipped", "received", "delivered"])("keeps %s times and an empty order date across JST midnight", async (status) => {
    vi.setSystemTime(new Date("2026-11-12T14:59:59Z"));
    const db = database(true);
    const data = form(status);
    data.set("ordered_at", "");
    const first = await submit(INITIAL, data);
    if (!first.state) throw new Error("lost reply must keep the form");
    const before = structuredClone(db.rows("parcels"));
    expect(before[0].ordered_at).toBe("2026-11-12");
    expect(before[0].received_at).toBe(status === "received" ? "2026-11-12T14:59:59.000Z" : null);
    // PostgreSQL can return a different spelling of the same timestamp instant.
    const saved = db.rows("parcels")[0];
    saved.last_email_at = "2026-11-12T14:59:59+00:00";
    if (status === "received") saved.received_at = "2026-11-12T14:59:59+00:00";
    const stored = structuredClone(db.rows("parcels"));
    vi.setSystemTime(new Date("2026-11-13T15:00:01Z"));
    const retry = await submit(first.state, data);
    expect(retry.destination).toBe(`/app/parcels/${INTENT}`);
    expect(db.rows("parcels")).toEqual(stored);
    expect(spending(db)).toEqual({ total: 2480, priced: 1, unpriced: 0 });
  });

  it("allows identical values from two different forms as two separate intentions", async () => {
    const db = database();
    expect((await submit(INITIAL, form("shipped"))).destination).toBe(`/app/parcels/${INTENT}`);
    const otherForm = form("shipped");
    otherForm.set("intentId", OTHER_INTENT);
    expect((await submit(INITIAL, otherForm)).destination).toBe(`/app/parcels/${OTHER_INTENT}`);
    expect(db.rows("parcels").map((row) => row.id)).toEqual([INTENT, OTHER_INTENT]);
    expect(spending(db)).toEqual({ total: 4960, priced: 2, unpriced: 0 });
    expect(db.callsOn("parcels", "select")).toHaveLength(0);
  });

  it("can change the same form after an initial failure that committed nothing", async () => {
    const db = database();
    let refused = false;
    db.hooks.push((query) => {
      if (query.table === "parcels" && query.op === "insert" && !refused) {
        refused = true;
        return { data: null, error: { message: "synthetic pre-commit failure" } };
      }
    });
    const data = form("shipped");
    const first = await submit(INITIAL, data);
    expect(db.rows("parcels")).toHaveLength(0);
    if (!first.state) throw new Error("the failed form must be returned");
    data.set("title", "保存前に直した品名");
    expect((await submit(first.state, data)).destination).toBe(`/app/parcels/${INTENT}`);
    expect(db.rows("parcels")).toMatchObject([{ id: INTENT, title: "保存前に直した品名" }]);
  });

  it("keeps the original id and row when inputs change after the first commit", async () => {
    const { db, data, state } = await committedForm();
    const before = structuredClone(db.rows("parcels"));
    data.set("title", "保存後に直した品名");
    expectHeld(await submit(state, data), db, before);
    expect(db.callsOn("parcels", "insert").map((query) => query.values)).toEqual([
      expect.objectContaining({ id: INTENT }), expect.objectContaining({ id: INTENT }),
    ]);
  });

  it.each([
    ["a mail-filled order number", { order_number: "SYNTHETIC-ORDER" }],
    ["mail metadata on the same visible fields", { tracking_url: "https://tracking.example.test/synthetic" }],
    ["a subsequent edit", { updated_at: "2026-11-12T00:00:10Z" }],
    ["missing original time", { last_email_at: null }],
    ["invalid original time", { last_email_at: "invalid-time" }],
    ["invalid creation version", { created_at: "invalid-time", updated_at: "invalid-time" }],
  ])("does not claim an untouched creation after %s", async (_label, change) => {
    const { db, data, state } = await committedForm();
    Object.assign(db.rows("parcels")[0], change);
    const before = structuredClone(db.rows("parcels"));
    expectHeld(await submit(state, data), db, before);
  });

  it("refuses a linked mail even when source and every creation column stayed unchanged", async () => {
    const { db, data, state } = await committedForm();
    db.rows("extractions").push({ id: "synthetic-extraction", user_id: USER.id, parcel_id: INTENT });
    const before = structuredClone(db.rows("parcels"));
    expectHeld(await submit(state, data), db, before);
    const query = db.callsOn("extractions", "select")[0];
    expect(query.filters).toContainEqual({ method: "eq", args: ["user_id", USER.id] });
    expect(query.filters).toContainEqual({ method: "eq", args: ["parcel_id", INTENT] });
    expect(query).toMatchObject({ head: true, count: "exact" });
  });

  it.each([
    ["another owner", { user_id: OTHER_USER }],
    ["another source", { source: "mail" }],
    ["a different id", { id: OTHER_INTENT }],
  ])("does not trust a readback that returns %s", async (_label, change) => {
    const { db, data, state } = await committedForm();
    const before = structuredClone(db.rows("parcels"));
    db.hooks.push((query) => {
      if (query.table === "parcels" && query.op === "select") {
        return { data: { ...db.rows("parcels")[0], ...change }, error: null };
      }
    });
    expectHeld(await submit(state, data), db, before);
    const query = db.callsOn("parcels", "select")[0];
    expect(query.filters).toContainEqual({ method: "eq", args: ["user_id", USER.id] });
    expect(query.filters).toContainEqual({ method: "eq", args: ["id", INTENT] });
    expect(query.filters).toContainEqual({ method: "eq", args: ["source", "manual"] });
  });

  it.each(["another owner", "mail source"])("cannot settle an actual conflicting row belonging to %s", async (kind) => {
    const { db, data, state } = await committedForm();
    Object.assign(db.rows("parcels")[0], kind === "another owner" ? { user_id: OTHER_USER } : { source: "mail" });
    const before = structuredClone(db.rows("parcels"));
    expectHeld(await submit(state, data), db, before);
  });

  it.each(["read error", "no row"])("keeps the form after a duplicate id followed by %s", async (kind) => {
    const { db, data, state } = await committedForm();
    const before = structuredClone(db.rows("parcels"));
    db.hooks.push((query) => {
      if (query.table === "parcels" && query.op === "select") {
        return { data: kind === "read error" ? { ...db.rows("parcels")[0] } : null,
          error: kind === "read error" ? { message: "synthetic read failure" } : null };
      }
    });
    expectHeld(await submit(state, data), db, before);
  });

  it.each(["read error", "unknown count"])("does not treat an extraction %s as no mail", async (kind) => {
    const { db, data, state } = await committedForm();
    const before = structuredClone(db.rows("parcels"));
    db.hooks.push((query) => {
      if (query.table === "extractions" && query.op === "select") {
        return { data: null, error: kind === "read error" ? { message: "synthetic link read failure" } : null,
          count: kind === "read error" ? 0 : null };
      }
    });
    expectHeld(await submit(state, data), db, before);
  });

  it("does not use duplicate recovery for another insert error", async () => {
    const { db, data, state } = await committedForm();
    const before = structuredClone(db.rows("parcels"));
    db.hooks.unshift((query) => query.table === "parcels" && query.op === "insert"
      ? { data: null, error: { code: "57014", message: "synthetic timeout" } } : undefined);
    expectHeld(await submit(state, data), db, before);
    expect(db.callsOn("parcels", "select")).toHaveLength(0);
  });

  it.each(["different id", "no id"])("does not redirect after a successful insert returns %s", async (kind) => {
    const db = new FakeDb();
    mocks.db = db;
    const execute = db.execute.bind(db);
    vi.spyOn(db, "execute").mockImplementation((query) => {
      const result = execute(query);
      return query.table === "parcels" && query.op === "insert" && !result.error
        ? { data: kind === "different id" ? { id: OTHER_INTENT } : {}, error: null } : result;
    });
    const result = await submit(INITIAL, form("shipped"));
    expect(result.destination).toBeNull();
    expect(result.state).toMatchObject({ error: "保存できませんでした", values: { intentId: INTENT } });
    expect(db.rows("parcels")).toMatchObject([{ id: INTENT }]);
    expect(mocks.revalidate).not.toHaveBeenCalled();
  });

  it.each([undefined, "", "not-a-uuid", `${INTENT}suffix`])("refuses missing or malformed intent %s before any database write", async (intent) => {
    const db = database();
    const data = form("shipped");
    if (intent === undefined) data.delete("intentId");
    else data.set("intentId", intent);
    const result = await submit(INITIAL, data);
    expect(result.destination).toBeNull();
    expect(result.state?.error).toBeTruthy();
    expect(db.calls).toHaveLength(0);
    expect(fetch).not.toHaveBeenCalled();
  });
});
