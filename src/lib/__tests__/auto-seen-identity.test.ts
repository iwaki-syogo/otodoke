import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The "seen" write of 外した荷物 is sent by the page in the background after it is drawn. It names the account the page was
 * drawn for, and writes only while the verified session is that account: a page drawn for one account says nothing about
 * another account's marks. The database function itself still takes the owner from auth.uid().
 */

const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";
const SEEN = "2026-11-17T03:30:00.123456+00:00";
const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  user: null as { id: string } | null,
  getUserError: null as { message: string } | null,
  revalidatePath: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath, revalidateTag: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: mocks.user }, error: mocks.getUserError }) },
    rpc: (...args: unknown[]) => mocks.rpc(...args),
  }),
  getUser: async () => mocks.user,
}));

const { markAutoExcludedSeen } = await import("@/app/app/parcel-actions");

beforeEach(() => {
  mocks.rpc.mockReset();
  mocks.rpc.mockResolvedValue({ data: "ok", error: null });
  mocks.revalidatePath.mockReset();
  mocks.user = null;
  mocks.getUserError = null;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("markAutoExcludedSeen checks the account the page was drawn for", () => {
  it.each([
    ["A, on a page drawn for A", A],
    ["B, on a page drawn for B", B],
  ])("writes once for %s", async (_name, id) => {
    mocks.user = { id };
    expect(await markAutoExcludedSeen(SEEN, id)).toEqual({ ok: true });
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    expect(mocks.rpc).toHaveBeenCalledWith("mark_auto_excluded_seen", { p_seen_until: SEEN });
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/app", "layout");
  });

  it("writes nothing when the page was drawn for A and the session is now B", async () => {
    mocks.user = { id: B };
    expect(await markAutoExcludedSeen(SEEN, A)).toEqual({ ok: false });
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it.each([
    ["no account named (an old page)", undefined],
    ["an empty account", ""],
  ])("writes nothing with %s", async (_name, expected) => {
    mocks.user = { id: A };
    expect(await markAutoExcludedSeen(SEEN, expected)).toEqual({ ok: false });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("writes nothing when the session could not be read", async () => {
    mocks.user = null;
    mocks.getUserError = { message: "auth unavailable" };
    expect(await markAutoExcludedSeen(SEEN, A)).toEqual({ ok: false });
    mocks.getUserError = null;
    expect(await markAutoExcludedSeen(SEEN, A)).toEqual({ ok: false });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("still refuses a malformed time before reading the session", async () => {
    mocks.user = { id: A };
    expect(await markAutoExcludedSeen("yesterday", A)).toEqual({ ok: false });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});
