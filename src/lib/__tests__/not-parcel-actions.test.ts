import { beforeEach, describe, expect, it, vi } from "vitest";
import { EXCLUDE_FAILED } from "@/lib/not-parcel-text";

/**
 * 「これは荷物ではありません」, the two Server Actions. Each makes one call to the database function, with the
 * person's own session; the owner is taken from the session in SQL, never from the caller.
 * excludeParcel: ok is the only success. gone (not there, not theirs, already out), manual, an error and a
 * thrown call all fail, and none of them moves the page.
 * restoreExcluded: ok and gone both succeed (gone = no longer marked = already back, as on a second press).
 */

const ID = "10000000-0000-4000-8000-000000000001";
const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  user: null as { id: string } | null,
  revalidatePath: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath, revalidateTag: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: mocks.user }, error: null }) }, rpc: (...args: unknown[]) => mocks.rpc(...args) }),
  getUser: async () => mocks.user,
}));

const actions = await import("@/app/app/parcel-actions");

beforeEach(() => {
  mocks.rpc.mockReset();
  mocks.revalidatePath.mockReset();
  mocks.user = { id: "00000000-0000-4000-8000-00000000000a" };
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("excludeParcel", () => {
  it("calls exclude_parcel once with the id and succeeds on ok", async () => {
    mocks.rpc.mockResolvedValue({ data: "ok", error: null });
    expect(await actions.excludeParcel(ID)).toEqual({ ok: true });
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    expect(mocks.rpc).toHaveBeenCalledWith("exclude_parcel", { p_parcel_id: ID });
  });

  it.each(["gone", "manual", "something-else"])("fails on %s, with the taking-out sentence", async (answer) => {
    mocks.rpc.mockResolvedValue({ data: answer, error: null });
    expect(await actions.excludeParcel(ID)).toEqual({ ok: false, error: EXCLUDE_FAILED });
  });

  it("fails on a database error and on a thrown call", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { message: "boom" } });
    expect(await actions.excludeParcel(ID)).toEqual({ ok: false, error: EXCLUDE_FAILED });
    mocks.rpc.mockRejectedValue(new Error("network"));
    expect(await actions.excludeParcel(ID)).toEqual({ ok: false, error: EXCLUDE_FAILED });
  });

  it("fails without a session and on a malformed id, without calling the database", async () => {
    mocks.user = null;
    expect(await actions.excludeParcel(ID)).toEqual({ ok: false, error: EXCLUDE_FAILED });
    mocks.user = { id: "00000000-0000-4000-8000-00000000000a" };
    expect(await actions.excludeParcel("not-a-uuid")).toEqual({ ok: false, error: EXCLUDE_FAILED });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("asks for no redraw of the parcel page it is pressed on", async () => {
    mocks.rpc.mockResolvedValue({ data: "ok", error: null });
    await actions.excludeParcel(ID);
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });
});

describe("restoreExcluded", () => {
  it("calls restore_parcel once with the id; ok succeeds and redraws", async () => {
    mocks.rpc.mockResolvedValue({ data: "ok", error: null });
    expect(await actions.restoreExcluded(ID)).toEqual({ ok: true });
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    expect(mocks.rpc).toHaveBeenCalledWith("restore_parcel", { p_parcel_id: ID });
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/app", "layout");
  });

  it("a second press gives the same result: ok then gone are both a success", async () => {
    mocks.rpc.mockResolvedValueOnce({ data: "ok", error: null }).mockResolvedValueOnce({ data: "gone", error: null });
    const first = await actions.restoreExcluded(ID);
    const second = await actions.restoreExcluded(ID);
    expect(second).toEqual(first);
    expect(second).toEqual({ ok: true });
  });

  it("negative control: an unknown answer, a database error and a thrown call are failures", async () => {
    mocks.rpc.mockResolvedValue({ data: "manual", error: null });
    expect(await actions.restoreExcluded(ID)).toEqual({ ok: false });
    mocks.rpc.mockResolvedValue({ data: null, error: { message: "boom" } });
    expect(await actions.restoreExcluded(ID)).toEqual({ ok: false });
    mocks.rpc.mockRejectedValue(new Error("network"));
    expect(await actions.restoreExcluded(ID)).toEqual({ ok: false });
  });

  it("fails without a session and on a malformed id, without calling the database", async () => {
    mocks.user = null;
    expect(await actions.restoreExcluded(ID)).toEqual({ ok: false });
    mocks.user = { id: "00000000-0000-4000-8000-00000000000a" };
    expect(await actions.restoreExcluded("nope")).toEqual({ ok: false });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});
