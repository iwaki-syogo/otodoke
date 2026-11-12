import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ACCOUNT_DELETE_CONFIRM, ACCOUNT_DELETED_PATH } from "@/lib/account-deletion";
import { FakeDb } from "./fake-db";

/**
 * N1: the form was rendered for A, then another tab changed this browser's cookies to B.
 * expectedUserId is a precondition about the displayed account, never authorization to act as A.
 * These are the real Server Actions; only their auth/database/network boundaries are replaced.
 */
const A = { id: "00000000-0000-4000-8000-00000000000a", email: "a@example.test" };
const B = { id: "00000000-0000-4000-8000-00000000000b", email: "b@example.test" };
const AT = "2026-11-12T01:00:00.123456Z";

const mocks = vi.hoisted(() => ({
  db: null as unknown,
  user: null as { id: string; email: string } | null,
  getUser: vi.fn(),
  admin: vi.fn(),
  deleteUser: vi.fn(),
  signOut: vi.fn(),
  readAfter: vi.fn(),
  revalidate: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidate }));
vi.mock("next/navigation", () => ({
  // Match Next's control flow: a redirect stops the action rather than returning normally.
  redirect: (to: string) => { throw new Error(`NEXT_REDIRECT:${to}`); },
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => Object.assign(mocks.db as FakeDb, {
    auth: { getUser: mocks.getUser, signOut: mocks.signOut },
  }),
  getUser: async () => (await mocks.getUser()).data.user,
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: mocks.admin }));
// No paid call may run in this regression test. Reaching the runner is itself an unwanted effect.
vi.mock("@/lib/ai-consent-run", () => ({ runReadAfterConsent: mocks.readAfter }));

const { deleteAccount } = await import("@/app/app/settings/account-actions");
const { clearAllParcels } = await import("@/app/app/settings/actions");
const { setAiReadingDecision } = await import("@/app/app/reading/actions");

let db: FakeDb;
let consentSaves: Array<{ userId: string; decision: unknown }>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", () => { throw new Error("external fetch is forbidden in this test"); });
  mocks.user = A;
  db = new FakeDb({
    parcels: [{ id: "parcel-a", user_id: A.id }, { id: "parcel-b", user_id: B.id }],
    emails: [{ id: "mail-a", user_id: A.id }, { id: "mail-b", user_id: B.id }],
    ai_reading_consents: [A, B].map(({ id }) => ({ user_id: id, decision: "declined", decided_at: "2026-11-11T00:00:00Z", text_version: "v1" })),
  });
  mocks.db = db;
  consentSaves = [];
  mocks.getUser.mockImplementation(async () => ({ data: { user: mocks.user }, error: null }));
  mocks.signOut.mockResolvedValue({ error: null });
  mocks.deleteUser.mockImplementation(async (id: string) => ({ data: { user: { id } }, error: null }));
  mocks.admin.mockImplementation(() => Object.assign(db, {
    auth: { getUser: mocks.getUser, signOut: mocks.signOut, admin: { deleteUser: mocks.deleteUser } },
  }));
  mocks.readAfter.mockResolvedValue({ ok: true, read: 0, overLimit: false, unavailable: false });

  const realRpc = db.rpc.bind(db);
  vi.spyOn(db, "rpc").mockImplementation(async (name, args) => {
    if (name !== "set_ai_reading") return realRpc(name, args);
    // The real authenticated setter derives its owner from the request's cookie, not form data.
    const userId = mocks.user!.id;
    const decision = (args as { p_decision?: unknown } | undefined)?.p_decision;
    consentSaves.push({ userId, decision });
    Object.assign(db.rows("ai_reading_consents").find((row) => row.user_id === userId)!, { decision, decided_at: AT });
    return { data: [{ decision, decided_at: AT }], error: null };
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function form(expectedUserId: string | undefined, fields: Record<string, string>): FormData {
  const data = new FormData();
  if (expectedUserId !== undefined) data.set("expectedUserId", expectedUserId);
  for (const [name, value] of Object.entries(fields)) data.set(name, value);
  return data;
}

/** Only framework redirects are caught; setup errors must fail the test rather than pass a guard. */
async function settle(action: () => Promise<unknown>): Promise<{ state?: unknown; redirectedTo?: string }> {
  try {
    return { state: await action() };
  } catch (error) {
    if (!(error instanceof Error) || !error.message.startsWith("NEXT_REDIRECT:")) throw error;
    return { redirectedTo: error.message.slice("NEXT_REDIRECT:".length) };
  }
}

const deleteForm = (expected: string | undefined) => form(expected, { [ACCOUNT_DELETE_CONFIRM.name]: ACCOUNT_DELETE_CONFIRM.value });
const clearForm = (expected: string | undefined) => form(expected, { confirm: "yes" });
const consentForm = (expected: string | undefined, decision = "granted") => form(expected, { decision, after: "settings" });
const parcelOwners = () => db.rows("parcels").map((row) => row.user_id);

describe("stale account deletion confirmation", () => {
  it("does not delete or sign out B when A's already-rendered confirmation is submitted", async () => {
    const confirmation = deleteForm(A.id);
    mocks.user = B;
    await settle(() => deleteAccount(null, confirmation));
    expect(mocks.getUser).toHaveBeenCalled();
    expect(mocks.deleteUser).not.toHaveBeenCalled();
    expect(mocks.admin).not.toHaveBeenCalled();
    expect(mocks.signOut).not.toHaveBeenCalled();
    expect(mocks.revalidate).not.toHaveBeenCalled();
  });

  it("still deletes A after the same displayed account A is verified", async () => {
    const outcome = await settle(() => deleteAccount(null, deleteForm(A.id)));
    expect(outcome.redirectedTo).toBe(ACCOUNT_DELETED_PATH);
    expect(mocks.deleteUser).toHaveBeenCalledExactlyOnceWith(A.id, false);
    expect(mocks.signOut).toHaveBeenCalledExactlyOnceWith({ scope: "local" });
  });
});

describe("stale clear-all confirmation", () => {
  it("does not clear B's parcels or mail when A's already-rendered confirmation is submitted", async () => {
    const confirmation = clearForm(A.id);
    mocks.user = B;
    await settle(() => clearAllParcels(confirmation));
    expect(mocks.getUser).toHaveBeenCalled();
    expect(parcelOwners()).toEqual([A.id, B.id]);
    expect(db.rows("emails").map((row) => row.user_id)).toEqual([A.id, B.id]);
    expect(db.rpcCalls).toEqual([]);
    expect(mocks.admin).not.toHaveBeenCalled();
    expect(mocks.revalidate).not.toHaveBeenCalled();
  });

  it("still clears only A after the same displayed account A is verified", async () => {
    const outcome = await settle(() => clearAllParcels(clearForm(A.id)));
    expect(outcome.redirectedTo).toBe("/app/settings/demo?cleared=1");
    expect(parcelOwners()).toEqual([B.id]);
    expect(db.rows("emails").map((row) => row.user_id)).toEqual([B.id]);
    expect(db.rpcCalls).toContainEqual({ name: "clear_all_parcels", args: { p_user_id: A.id } });
  });
});

describe("stale reading permission", () => {
  it.each(["granted", "declined"])("does not save %s for B or start its paid reader from A's displayed choice", async (decision) => {
    for (const row of db.rows("ai_reading_consents")) row.decision = decision === "granted" ? "declined" : "granted";
    const before = structuredClone(db.rows("ai_reading_consents"));
    const choice = consentForm(A.id, decision);
    mocks.user = B;
    await settle(() => setAiReadingDecision(choice));
    expect(mocks.getUser).toHaveBeenCalled();
    expect(consentSaves).toEqual([]);
    expect(db.rows("ai_reading_consents")).toEqual(before);
    expect(mocks.readAfter).not.toHaveBeenCalled();
    expect(mocks.admin).not.toHaveBeenCalled();
    expect(mocks.revalidate).not.toHaveBeenCalled();
  });

  it.each(["granted", "declined"])("still saves %s for A after the same displayed account A is verified", async (decision) => {
    const outcome = await settle(() => setAiReadingDecision(consentForm(A.id, decision)));
    expect(outcome.redirectedTo).toBe("/app/settings/mail-handling");
    expect(consentSaves).toEqual([{ userId: A.id, decision }]);
    expect(db.rows("ai_reading_consents").find((row) => row.user_id === B.id)!.decision).toBe("declined");
    if (decision === "granted") expect(mocks.readAfter).toHaveBeenCalledExactlyOnceWith(db, A.id, AT, expect.any(Number));
    else expect(mocks.readAfter).not.toHaveBeenCalled();
  });
});

describe("missing or invalid displayed-account preconditions", () => {
  it.each([undefined, "", "not-a-user-id"])("does not treat %j as permission to delete the current account", async (expected) => {
    await settle(() => deleteAccount(null, deleteForm(expected)));
    expect(mocks.deleteUser).not.toHaveBeenCalled();
    expect(mocks.signOut).not.toHaveBeenCalled();
  });

  it.each([undefined, "", "not-a-user-id"])("does not treat %j as permission to clear the current account", async (expected) => {
    await settle(() => clearAllParcels(clearForm(expected)));
    expect(parcelOwners()).toEqual([A.id, B.id]);
    expect(db.rpcCalls).toEqual([]);
  });

  it.each([undefined, "", "not-a-user-id"])("does not treat %j as permission to save or read for the current account", async (expected) => {
    await settle(() => setAiReadingDecision(consentForm(expected)));
    expect(consentSaves).toEqual([]);
    expect(mocks.readAfter).not.toHaveBeenCalled();
  });
});
