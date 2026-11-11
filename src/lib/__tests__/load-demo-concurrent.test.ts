import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeDb, type Query, type Row } from "./fake-db";

/**
 * Two judges share one account and press 「サンプルを読み込む」 almost together. The one who
 * comes second meets a mail the first is still storing: that is not a failure of the load. It
 * stops there and leaves the rest to the first (/app?demo=busy), and does not go on mail by mail:
 * the two would then work on neighbouring mails of one order at once, and the filing step has no
 * lock, so that could make two parcels. Three cases count as "being read" (a young pending row, a
 * lost unique-key race, a lost take-over update); any other error still ends on demo_failed.
 * The sample is the 17 anonymized real mails (6 parcels) and the 80 made-up history orders (80
 * delivered parcels): 97 mails, 86 parcels. Made-up mails only.
 */

const fixed = vi.hoisted(() => ({ entries: [] as import("@/lib/demo").DemoEntry[] }));
const USER = "00000000-0000-4000-8000-00000000000a";
const mocks = vi.hoisted(() => ({ db: null as unknown, redirect: vi.fn(), revalidatePath: vi.fn() }));

// The iOS endpoint asks Supabase Auth about the Bearer token; here the token is always user USER.
vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({ auth: { getUser: async () => ({ data: { user: { id: USER } }, error: null }) } }) }));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
// The real redirect() throws to leave the action; so does this one.
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    mocks.redirect(to);
    throw new Error(`NEXT_REDIRECT ${to}`);
  },
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => mocks.db, getUser: async () => ({ id: USER, email: "qa@example.com" }) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => mocks.db }));
// loadDemoEntries reads fixture files, which finish in an order and at a time set by the machine's
// load. Both loads must reach their first query on the same turn, so the entries are read once
// before the tests (real function, real time) and handed back as an already-settled value.
vi.mock("@/lib/demo", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/demo")>();
  return { ...real, loadDemoEntries: async () => fixed.entries.slice() };
});

const { loadDemo } = await import("@/app/app/settings/actions");
const { POST: apiLoad } = await import("@/app/api/demo/load/route");
const realDemo = await vi.importActual<typeof import("@/lib/demo")>("@/lib/demo");
fixed.entries = await realDemo.loadDemoEntries();

const run = async () => {
  mocks.redirect.mockClear();
  await expect(loadDemo()).rejects.toThrow("NEXT_REDIRECT");
  return mocks.redirect.mock.calls.map((c) => c[0] as string);
};

let db: FakeDb;

/** The same db, but each query is answered one macrotask later, so concurrent loads really alternate. */
const slowed = (real: FakeDb, seed = 0): unknown => {
  // seed 0: one macrotask per query (strict turns). Other seeds: 1 to 3 macrotasks, from a small
  // seeded generator, so one load drifts ahead or behind the other in a way that can be replayed.
  let state = seed * 2654435761 + 1;
  const pause = async () => {
    const ticks = seed === 0 ? 1 : 1 + (Math.abs((state = (state * 1103515245 + 12345) % 2147483648)) % 3);
    for (let i = 0; i < ticks; i++) await new Promise<void>((r) => setImmediate(r));
  };
  return new Proxy(real, {
    get(target, prop) {
      if (prop === "from") {
        return (table: string) => {
          const query = target.from(table);
          const proxy: object = new Proxy(query, {
            get(q, p) {
              if (p === "then") {
                return (ok: never, bad: never) => pause().then(() => q.then(ok, bad));
              }
              const v = Reflect.get(q, p) as unknown;
              return typeof v === "function" ? (...args: unknown[]) => { const out = (v as (...a: unknown[]) => unknown).apply(q, args); return out === q ? proxy : out; } : v;
            },
          });
          return proxy;
        };
      }
      if (prop === "rpc") return (...args: Parameters<FakeDb["rpc"]>) => {
        const query = target.rpc(...args);
        const proxy: object = new Proxy(query, {
          get(q, p) {
            if (p === "then") return (ok: never, bad: never) => pause().then(() => q.then(ok, bad));
            const value = Reflect.get(q, p);
            return typeof value === "function" ? (...values: unknown[]) => { const out = value.apply(q, values); return out === q ? proxy : out; } : value;
          },
        });
        return proxy;
      };
      const v = Reflect.get(target, prop) as unknown;
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
};

/**
 * What emails_user_message_idx does (supabase/migrations/20261102090000_init.sql:37): a second
 * row with the same (user_id, message_id) is refused with 23505. The FakeDb has no unique keys.
 */
const uniqueMessageIndex = (q: Query, d: FakeDb) => {
  if (q.table !== "emails" || q.op !== "insert") return undefined;
  const v = q.values as { user_id: string; message_id: string | null };
  if (v.message_id && d.rows("emails").some((r) => r.user_id === v.user_id && r.message_id === v.message_id)) {
    return { data: null, error: { message: 'duplicate key value violates unique constraint "emails_user_message_idx"', code: "23505" } };
  }
  return undefined;
};

const newDb = (seed: { emails: Row[]; parcels: Row[] } = { emails: [], parcels: [] }) => {
  // The FakeDb stamps rows from its own clock (a past date by default); the pipeline's "young pending
  // row" check reads the real time, so start the fake clock there or no row would ever look young.
  const d = new FakeDb(seed, Date.now());
  // These concurrency scenarios begin after the person has allowed real-mail reading.
  d.rows("ai_reading_consents").push({ user_id: USER, decision: "granted", decided_at: "2026-11-12T00:00:00Z", text_version: "v1" });
  d.hooks.push(uniqueMessageIndex);
  return d;
};

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon");
  db = newDb();
  mocks.db = db;
  mocks.redirect.mockReset();
  mocks.revalidatePath.mockReset();
});

/** Runs the first load against a scratch db to get the stored row of demo mail 0, then goes back to a fresh one. */
const firstMailRow = async () => {
  const probe = newDb();
  mocks.db = probe;
  await run();
  return probe.rows("emails")[0];
};

/** What one load alone leaves, to compare a concurrent run with. */
const aloneDb = async () => {
  const d = newDb();
  mocks.db = d;
  await run();
  return d;
};

/** The parcels as the user sees them, without ids and stamps, in a fixed order. */
const parcelStates = (d: FakeDb) =>
  d
    .rows("parcels")
    .map((p) => JSON.stringify({ status: p.status, title: p.title, order_number: p.order_number, tracking_number: p.tracking_number, expected_date: p.expected_date, total_amount: p.total_amount, items: d.rows("parcel_items").filter((i) => i.parcel_id === p.id).length }))
    .sort();

describe("loadDemo pressed twice", () => {
  it("one after the other: leaves 97 mails and 86 parcels, and both loads end on /app", async () => {
    expect(await run()).toEqual(["/app"]);
    expect(await run()).toEqual(["/app"]);
    expect(db.rows("emails")).toHaveLength(97);
    expect(db.rows("parcels")).toHaveLength(86);
  });

  it.each(Array.from({ length: 60 }, (_, i) => i))("at the same time (timing %i): 97 mails, 86 parcels, no doubled items; one load ends on /app, the other on /app or /app?demo=busy", async (seed) => {
    // The FakeDb answers on microtasks only, so once one load is running it would run to its end
    // before the other got a turn. Here every query waits one macrotask first (slowed()), so the
    // two loads take turns at each await, like two requests on a real database. Timing 0 is strict turns;
    // the others drift by 1 to 3 macrotasks per query and start the second load later (a replayable seed).
    // The harm of two loads working on neighbouring mails (two judges filing one order at once, with
    // no lock in the filing step) is timing luck in a fake; what is checked is the cause: a mail is
    // never stored while another mail of this account is still being read.
    const overlaps: string[] = [];
    db.hooks.unshift((q, d) => {
      if (q.table !== "emails" || q.op !== "insert") return undefined;
      const v = q.values as Row;
      const taken = d.rows("emails").some((r) => r.user_id === v.user_id && r.message_id === v.message_id);
      const reading = d.rows("emails").filter((r) => r.user_id === v.user_id && r.processing_status === "pending");
      if (!taken && reading.length > 0) overlaps.push(`${String(v.message_id)} stored while ${String(reading[0].message_id)} is being read`);
      return undefined;
    });
    mocks.db = slowed(db, seed);
    mocks.redirect.mockClear();
    // The second judge presses a little after the first: timing n starts it n * 3 macrotasks later, so
    // it comes in while the first is some mails ahead and passes the finished ones quickly (a mail
    // that is done costs it one lookup) until it catches up.
    const laterLoad = async () => {
      for (let i = 0; i < seed * 3; i++) await new Promise<void>((r) => setImmediate(r));
      // The first load must still be running when this one starts; if fixtures shrink and it has
      // already finished, fail here with that cause instead of at the busy assertion below.
      expect(mocks.redirect).not.toHaveBeenCalled();
      return loadDemo();
    };
    const results = await Promise.allSettled([loadDemo(), laterLoad()]);
    expect(results.every((r) => r.status === "rejected" && String((r.reason as Error).message).startsWith("NEXT_REDIRECT"))).toBe(true);
    const to = mocks.redirect.mock.calls.map((c) => c[0] as string);
    expect(to).toHaveLength(2);
    // Really concurrent, in every timing: the load that was ahead finishes (/app), the other one
    // meets a mail it is still reading and stops (busy). Two loads that merely ran one after the
    // other would both end on /app.
    expect([...to].sort()).toEqual(["/app", "/app?demo=busy"]);
    // They did take turns: the second load looked up mail 0 while the first was still filing it
    // (before the first's last write to the emails row), not after it was done.
    const all = db.calls.map((q) => `${q.table}.${q.op}`);
    const lookups = all.flatMap((c, i) => (c === "emails.select" ? [i] : []));
    expect(lookups.length).toBeGreaterThanOrEqual(2);
    if (seed === 0) expect(lookups[1]).toBeLessThan(all.indexOf("emails.update"));

    expect(db.rows("emails")).toHaveLength(97);
    expect(db.rows("parcels")).toHaveLength(86);
    const items = db.rows("parcel_items").map((r) => JSON.stringify([r.parcel_id, r.name, r.quantity, r.email_id ?? null]));
    expect(new Set(items).size).toBe(items.length);
    expect(overlaps).toEqual([]);
    // And the same parcels as one load alone leaves (no stale write over a newer state).
    expect(parcelStates(db)).toEqual(parcelStates(await aloneDb()));
    const messageIds = db.rows("emails").map((r) => r.message_id);
    expect(new Set(messageIds).size).toBe(97);
  });
});

describe("loadDemo meeting the other judge's load", () => {
  it("stops at a mail still being read and leaves the rest to the other load (/app?demo=busy)", async () => {
    // Mail 0: a row of the first judge, pending and young (what the pipeline refuses for 3 minutes).
    const first = await firstMailRow();
    db = newDb({ emails: [{ ...first, processing_status: "pending", created_at: new Date().toISOString() }], parcels: [] });
    mocks.db = db;
    expect(await run()).toEqual(["/app?demo=busy"]);
    // Nothing after mail 0 was touched.
    expect(db.rows("emails")).toHaveLength(1);
    expect(db.callsOn("emails", "insert")).toHaveLength(0);
  });

  it("stops at a mail that lost the insert race, with the other load's row really there", async () => {
    const first = await firstMailRow();
    // Mail 0 has a row, so the first insert is mail 1. The other load stores it between the lookup
    // and the insert: its row is there when this insert meets the unique key.
    db = newDb({ emails: [{ ...first, processing_status: "processed" }], parcels: [] });
    mocks.db = db;
    let seen = 0;
    db.hooks.unshift((q, d) => {
      if (q.table === "emails" && q.op === "insert" && seen++ === 0) {
        const v = q.values as Row;
        d.rows("emails").push({ ...v, id: "11111111-1111-4111-8111-111111111111", processing_status: "pending", created_at: new Date().toISOString() });
      }
      return undefined;
    });
    expect(await run()).toEqual(["/app?demo=busy"]);
    expect(db.rows("emails")).toHaveLength(2);
    expect(db.callsOn("emails", "insert")).toHaveLength(1);
  });

  it("stops at a mail whose take-over update lost to the other load", async () => {
    const first = await firstMailRow();
    // Mail 0's row failed earlier, so this load takes it over; the other load does it first.
    db = newDb({ emails: [{ ...first, processing_status: "failed", created_at: "2026-11-01T00:00:00.000Z" }], parcels: [] });
    mocks.db = db;
    let seen = 0;
    db.hooks.push((q, d) => {
      if (q.table === "emails" && q.op === "update" && seen++ === 0) {
        for (const r of d.rows("emails")) r.created_at = new Date().toISOString();
      }
      return undefined;
    });
    expect(await run()).toEqual(["/app?demo=busy"]);
    expect(db.callsOn("emails", "insert")).toHaveLength(0);
  });

  it("negative control: any other error still ends on demo_failed", async () => {
    let seen = 0;
    db.hooks.push((q: Query) => (q.table === "emails" && q.op === "insert" && seen++ === 2 ? { data: null, error: { message: "connection reset" } } : undefined));
    const [to] = await run();
    expect(to).toContain("error=demo_failed");
    expect(to).toContain("demo=2");
    // A 23505 on another table is no sign of the other judge either.
    db = newDb();
    mocks.db = db;
    db.hooks.push((q: Query) => (q.table === "parcels" && q.op === "insert" ? { data: null, error: { message: "duplicate key", code: "23505" } } : undefined));
    const [again] = await run();
    expect(again).toContain("error=demo_failed");
  });
});

describe("the iOS endpoint POST /api/demo/load shares the guard", () => {
  const b64url = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
  const token = `${b64url({ alg: "ES256" })}.${b64url({ sub: USER })}.c2ln`;
  const callApi = async () => {
    const res = await apiLoad(new Request("https://otodoke.app/api/demo/load", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: "{}" }));
    return (await res.json()) as { ok: boolean; processed?: number; busy?: boolean };
  };

  it.each([0, 1, 7, 23])("an API load while a web load runs (timing %i): one of them answers busy, no duplicated mails or parcels", async (seed) => {
    mocks.db = slowed(db, seed);
    mocks.redirect.mockClear();
    const laterApi = async () => {
      for (let i = 0; i < seed * 3; i++) await new Promise<void>((r) => setImmediate(r));
      expect(mocks.redirect).not.toHaveBeenCalled();
      return callApi();
    };
    const [web, api] = await Promise.allSettled([loadDemo(), laterApi()]);
    expect(web.status).toBe("rejected");
    expect(api.status).toBe("fulfilled");
    const answer = (api as PromiseFulfilledResult<Awaited<ReturnType<typeof callApi>>>).value;
    expect(answer.ok).toBe(true);
    // The web load was ahead, so the API load met a mail still being read and stopped.
    expect(answer.busy).toBe(true);
    expect(mocks.redirect.mock.calls.map((c) => c[0] as string)).toEqual(["/app"]);
    expect(db.rows("emails")).toHaveLength(97);
    expect(db.rows("parcels")).toHaveLength(86);
    const items = db.rows("parcel_items").map((r) => JSON.stringify([r.parcel_id, r.name, r.quantity, r.email_id ?? null]));
    expect(new Set(items).size).toBe(items.length);
  });

  it("one API load alone: ok, busy false, 97 mails and 86 parcels", async () => {
    expect(await callApi()).toMatchObject({ ok: true, busy: false });
    expect(db.rows("emails")).toHaveLength(97);
    expect(db.rows("parcels")).toHaveLength(86);
  });
});
