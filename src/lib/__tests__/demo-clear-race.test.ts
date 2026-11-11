import { afterEach, describe, expect, it, vi } from "vitest";
import { runClearAllParcels, runLoadDemo } from "@/lib/demo-run";
import { runReadWaitingMail } from "@/lib/mail-run";
import type { AdminClient } from "@/lib/supabase/admin";
import { FakeDb, type Result } from "./fake-db";

const USER = "00000000-0000-4000-8000-00000000000a";
const asAdmin = (db: unknown) => db as AdminClient;

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

/** Delay a request before it reaches the database, retaining its original request headers. */
function delayedRequest(db: FakeDb, when: (name: string, args: Record<string, unknown>) => boolean) {
  const stopped = deferred();
  const resume = deferred();
  let delayedOnce = false;
  const client = new Proxy(db, {
    get(target, property) {
      if (property === "rpc") return (name: string, args: Record<string, unknown>) => {
        const query = target.rpc(name, args) as Promise<Result> & { setHeader: (key: string, value: string) => unknown };
        const delayed = {
          setHeader: (key: string, value: string) => { query.setHeader(key, value); return delayed; },
          then: async (resolve: (value: Result) => unknown, reject: (reason: unknown) => unknown) => {
            if (!delayedOnce && when(name, args)) { delayedOnce = true; stopped.release(); await resume.promise; }
            return query.then(resolve, reject);
          },
        };
        return delayed;
      };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { client: asAdmin(client), stopped: stopped.promise, resume: resume.release };
}

afterEach(() => vi.unstubAllGlobals());

describe("B5: clear fences a sample load started on another request", () => {
  it("does not restore any parcel or mail when the second mail reservation arrives after clear succeeded", async () => {
    vi.stubGlobal("fetch", () => { throw new Error("external fetch is forbidden in this test"); });
    const db = new FakeDb();
    const stopped = deferred();
    const resume = deferred();
    let reservations = 0;
    const loadingDb = new Proxy(db, {
      get(target, property) {
        if (property === "rpc") return (name: string, args: unknown) => {
          const query = target.rpc(name, args) as Promise<Result> & { setHeader: (key: string, value: string) => unknown };
          const delayed = {
            setHeader: (key: string, value: string) => { query.setHeader(key, value); return delayed; },
            then: async (resolve: (value: Result) => unknown, reject: (reason: unknown) => unknown) => {
              if (name === "store_mail_run" && ++reservations === 2) {
                stopped.release();
                await resume.promise;
              }
              return query.then(resolve, reject);
            },
          };
          return delayed;
        };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const loading = runLoadDemo(() => asAdmin(loadingDb), USER);
    await stopped.promise;
    expect(db.rows("emails")).toHaveLength(1);
    expect(db.rows("parcels")).toHaveLength(1);
    expect(await runClearAllParcels(asAdmin(db), USER)).toBeNull();
    expect(db.rows("emails")).toHaveLength(0);
    expect(db.rows("parcels")).toHaveLength(0);
    resume.release();
    await loading;
    expect(db.rows("emails")).toHaveLength(0);
    expect(db.rows("parcels")).toHaveLength(0);
  });

  it("also rejects a parcel insert delayed after its sample email was reserved", async () => {
    vi.stubGlobal("fetch", () => { throw new Error("external fetch is forbidden in this test"); });
    const db = new FakeDb();
    const gate = delayedRequest(db, (name) => name === "create_mail_parcel");
    const loading = runLoadDemo(() => gate.client, USER);
    await gate.stopped;
    expect(db.rows("emails")).toHaveLength(1);
    expect(await runClearAllParcels(asAdmin(db), USER)).toBeNull();
    gate.resume();
    expect((await loading).ok).toBe(false);
    expect(db.rows("emails")).toHaveLength(0);
    expect(db.rows("parcels")).toHaveLength(0);
  });

  it("fences old received-at postprocessing while allowing a new load after clear", async () => {
    vi.stubGlobal("fetch", () => { throw new Error("external fetch is forbidden in this test"); });
    const db = new FakeDb();
    const gate = delayedRequest(db, (name) => name === "receive_sample_parcels");
    const loading = runLoadDemo(() => gate.client, USER);
    await gate.stopped;
    expect(db.rows("emails")).toHaveLength(97);
    expect(await runClearAllParcels(asAdmin(db), USER)).toBeNull();
    expect((await runLoadDemo(() => asAdmin(db), USER)).ok).toBe(true);
    const before = structuredClone(db.rows("parcels"));
    gate.resume();
    expect((await loading).ok).toBe(false);
    expect(db.rows("emails")).toHaveLength(97);
    expect(db.rows("parcels")).toHaveLength(86);
    expect(db.rows("parcels")).toEqual(before);
  });

  it("does not resume a cached unread sample after its stored generation was cleared", async () => {
    vi.stubGlobal("fetch", () => { throw new Error("external fetch is forbidden in this test"); });
    const db = new FakeDb();
    expect((await runLoadDemo(() => asAdmin(db), USER)).ok).toBe(true);
    Object.assign(db.rows("emails")[0], { processing_status: "pending", processing_run_id: null, processing_lease_until: null, created_at: "2020-01-01T00:00:00Z" });
    const gate = delayedRequest(db, (name) => name === "store_mail_run");
    const reading = runReadWaitingMail(gate.client, USER);
    await gate.stopped;
    expect(await runClearAllParcels(asAdmin(db), USER)).toBeNull();
    gate.resume();
    expect((await reading).ok).toBe(false);
    expect(db.rows("emails")).toHaveLength(0);
    expect(db.rows("parcels")).toHaveLength(0);
  });

  it("does not report clear success or lose rows when its second delete fails", async () => {
    const db = new FakeDb();
    expect((await runLoadDemo(() => asAdmin(db), USER)).ok).toBe(true);
    const generation = db.rows("sample_generations")[0].generation;
    db.hooks.push((q) => q.table === "emails" && q.op === "delete" ? { data: null, error: { message: "synthetic delete failure" } } : undefined);
    expect(await runClearAllParcels(asAdmin(db), USER)).toBe("synthetic delete failure");
    expect(db.rows("emails")).toHaveLength(97);
    expect(db.rows("parcels")).toHaveLength(86);
    expect(db.rows("sample_generations")[0].generation).toBe(generation);
  });
});
