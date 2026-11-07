import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeDb, type Query } from "./fake-db";

/**
 * Two judges share one account and press 「サンプルを読み込む」 almost together. The one who
 * comes second meets mails the first is still storing: that is not a failure of the load. Only
 * those two cases (a young pending row, a lost unique-key race) are skipped; any other error
 * still ends on demo_failed. Made-up mails only.
 */

const USER = "00000000-0000-4000-8000-00000000000a";
const mocks = vi.hoisted(() => ({ db: null as unknown, redirect: vi.fn(), revalidatePath: vi.fn() }));

vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
// The real redirect() throws to leave the action; so does this one.
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    mocks.redirect(to);
    throw new Error(`NEXT_REDIRECT ${to}`);
  },
}));
vi.mock("@/lib/supabase/server", () => ({ getUser: async () => ({ id: USER, email: "qa@example.com" }) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => mocks.db }));

const { loadDemo } = await import("@/app/app/settings/actions");

const run = async () => {
  mocks.redirect.mockClear();
  await expect(loadDemo()).rejects.toThrow("NEXT_REDIRECT");
  return mocks.redirect.mock.calls.map((c) => c[0] as string);
};

let db: FakeDb;
beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon");
  db = new FakeDb({ emails: [], parcels: [] });
  mocks.db = db;
  mocks.redirect.mockReset();
  mocks.revalidatePath.mockReset();
});

/** Fails the n-th (0-based) insert into emails with the given error. */
const failEmailInsert = (n: number, error: { message: string; code?: string }) => {
  let seen = 0;
  db.hooks.push((q: Query) => (q.table === "emails" && q.op === "insert" && seen++ === n ? { data: null, error } : undefined));
};

describe("loadDemo pressed twice", () => {
  it("leaves 17 mails and 6 parcels, and both loads end on /app", async () => {
    expect(await run()).toEqual(["/app"]);
    expect(await run()).toEqual(["/app"]);
    expect(db.rows("emails")).toHaveLength(17);
    expect(db.rows("parcels")).toHaveLength(6);
  });
});

describe("loadDemo meeting the other judge's load", () => {
  it("skips a mail still being read and a mail that lost the insert race, and reads the rest", async () => {
    // Mail 0: a row of the first judge, pending and young (what the pipeline refuses for 3 minutes).
    const probe = new FakeDb({ emails: [], parcels: [] });
    mocks.db = probe;
    await run();
    const first = probe.rows("emails")[0];
    db = new FakeDb({ emails: [{ ...first, processing_status: "pending", created_at: new Date().toISOString() }], parcels: [] });
    mocks.db = db;
    // Mail 1 (the first insert, as mail 0 already has a row): the unique key is taken meanwhile.
    failEmailInsert(0, { message: 'duplicate key value violates unique constraint "emails_user_message_key"', code: "23505" });
    expect(await run()).toEqual(["/app"]);
    // 17 demo mails minus the one left to the other judge and the one lost in the race.
    expect(db.rows("emails")).toHaveLength(1 + 15);
    expect(db.callsOn("emails", "insert")).toHaveLength(16);
  });

  it("negative control: any other error still ends on demo_failed", async () => {
    failEmailInsert(2, { message: "connection reset" });
    const [to] = await run();
    expect(to).toContain("error=demo_failed");
    expect(to).toContain("demo=2");
    // A 23505 on another table is no sign of the other judge either.
    db = new FakeDb({ emails: [], parcels: [] });
    mocks.db = db;
    db.hooks.push((q: Query) => (q.table === "parcels" && q.op === "insert" ? { data: null, error: { message: "duplicate key", code: "23505" } } : undefined));
    const [again] = await run();
    expect(again).toContain("error=demo_failed");
  });
});
