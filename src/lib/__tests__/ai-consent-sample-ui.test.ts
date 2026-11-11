import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeDb } from "./fake-db";

const USER = "00000000-0000-4000-8000-00000000000a";
const mocks = vi.hoisted(() => ({ db: null as unknown, load: vi.fn(), revalidate: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidate }));
vi.mock("next/navigation", () => ({ redirect: (to: string) => { throw new Error(`REDIRECT:${to}`); } }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => mocks.db, getUser: async () => ({ id: USER }) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => mocks.db }));
vi.mock("@/lib/demo-run", () => ({ runLoadDemo: mocks.load, runClearAllParcels: vi.fn() }));

let db: FakeDb;
beforeEach(() => {
  vi.clearAllMocks();
  db = new FakeDb();
  mocks.db = db;
  mocks.load.mockResolvedValue({ ok: true, processed: 1, busy: false });
});

describe("trying the existing precomputed sample before deciding", () => {
  it.each(["undecided", "declined", "unknown", "granted"] as const)("a %s person can load the sample and reach its results", async (state) => {
    if (state === "granted" || state === "declined") db.rows("ai_reading_consents").push({ user_id: USER, decision: state, text_version: "v1", decided_at: "2026-11-12T00:00:00Z" });
    if (state === "unknown") db.hooks.push((q) => q.table === "ai_reading_consents" ? { data: null, error: { message: "unavailable" } } : undefined);
    const { loadDemo } = await import("@/app/app/settings/actions");
    await expect(loadDemo()).rejects.toThrow(state === "granted" ? "REDIRECT:/app" : "REDIRECT:/app?sample=1");
    expect(mocks.load).toHaveBeenCalledWith(expect.any(Function), USER);
    expect(db.callsOn("ai_reading_consents", "insert")).toHaveLength(0);
    expect(db.callsOn("ai_reading_consents", "update")).toHaveLength(0);
  });

  it("keeps the other loader's busy notice in the explicit sample view", async () => {
    mocks.load.mockResolvedValue({ ok: true, processed: 0, busy: true });
    const { loadDemo } = await import("@/app/app/settings/actions");
    await expect(loadDemo()).rejects.toThrow("REDIRECT:/app?sample=1&demo=busy");
  });
});
