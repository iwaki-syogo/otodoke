import { createClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@/lib/db/database.types";

const mocks = vi.hoisted(() => ({
  db: null as unknown,
  paid: vi.fn(),
  client: vi.fn(),
  requireEnv: vi.fn(),
  mkdir: vi.fn(),
  writeFile: vi.fn(),
}));

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => mocks.db }));
vi.mock("@/lib/env", () => ({ requireEnv: mocks.requireEnv }));
vi.mock("node:fs/promises", () => ({ mkdir: mocks.mkdir, writeFile: mocks.writeFile }));
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    constructor(options: unknown) { mocks.client(options); }
    messages = { parse: mocks.paid };
  },
}));

const USER = "00000000-0000-4000-8000-00000000000a";
const PARCEL = "00000000-0000-4000-8000-00000000000b";
const GENERATION = "00000000-0000-4000-8000-000000000001";
const NEXT = "00000000-0000-4000-8000-000000000002";
const EMAIL = "person@example.test";
type Request = { path: string; method: string; headers: Headers; body: unknown };

let requests: Request[];
let events: string[];
let scopeReply: { status: number; value: unknown };
let clearAfterPaid: boolean;
let complete: Promise<void>;
let finished: () => void;
let originalArgv: string[];
let exit: ReturnType<typeof vi.spyOn>;
let log: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  originalArgv = process.argv;
  process.argv = ["node", "categorize.ts", "--user", EMAIL, "--apply", "--max-usd", "1"];
  vi.spyOn(process, "loadEnvFile").mockImplementation(() => undefined);
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  complete = new Promise<void>((resolve) => { finished = resolve; });
  exit = vi.spyOn(process, "exit").mockImplementation(() => { finished(); return undefined as never; });
  log = vi.spyOn(console, "log").mockImplementation((message: unknown) => {
    if (typeof message === "string" && (message.startsWith("written ids:") || message.startsWith("dry run:"))) finished();
  });
  error = vi.spyOn(console, "error").mockImplementation(() => undefined);
  requests = [];
  events = [];
  scopeReply = { status: 200, value: GENERATION };
  clearAfterPaid = false;
  mocks.requireEnv.mockReturnValue("synthetic-api-key");
  mocks.mkdir.mockResolvedValue(undefined);
  mocks.writeFile.mockResolvedValue(undefined);
  mocks.paid.mockImplementation(async () => {
    events.push("paid");
    if (clearAfterPaid) scopeReply.value = NEXT;
    return { usage: { input_tokens: 1, output_tokens: 1 }, parsed_output: { answers: [{ id: PARCEL, category: "food" }] } };
  });
  const db = createClient<Database>("http://127.0.0.1:54321", "synthetic-service-key", {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
    global: { fetch: async (url, init) => {
      const path = new URL(String(url)).pathname;
      const method = init?.method ?? "GET";
      const headers = new Headers(init?.headers);
      requests.push({ path, method, headers, body: init?.body ? JSON.parse(String(init.body)) : null });
      let value: unknown;
      let status = 200;
      let count = 1;
      if (path.endsWith("/begin_sample_load")) {
        events.push("scope");
        ({ value, status } = scopeReply);
      } else if (path.endsWith("/parcel_items")) {
        events.push("read");
        value = [];
        count = 0;
      } else if (path.endsWith("/parcels") && method === "GET") {
        events.push("read");
        value = [{ id: PARCEL, shop: "Synthetic shop", title: "Synthetic parcel", category_source: null }];
      } else if (path.endsWith("/parcels") && method === "PATCH") {
        events.push("write");
        if (clearAfterPaid && headers.get("x-otodoke-sample-generation") !== NEXT) {
          status = 400;
          value = { code: "55000", message: "sample load was cleared; load it again" };
        } else value = [{ id: PARCEL }];
      } else throw new Error(`Unexpected synthetic database request: ${method} ${path}`);
      return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", "content-range": count ? `0-${count - 1}/${count}` : "*/0" } });
    } },
  });
  vi.spyOn(db.auth.admin, "listUsers").mockImplementation(async () => {
    events.push("owner");
    return { data: { users: [{ id: USER, email: EMAIL }], nextPage: null, lastPage: 1, total: 1, aud: "authenticated" }, error: null } as never;
  });
  mocks.db = db;
});

afterEach(() => {
  process.argv = originalArgv;
  vi.restoreAllMocks();
});

async function runScript() {
  await import("../../../scripts/categorize");
  await complete;
}

describe("the one-off categorizer's database owner scope", () => {
  it("captures the single owner's generation before paid work and uses it for every apply read and write", async () => {
    await runScript();
    expect(exit).not.toHaveBeenCalled();
    expect(events).toEqual(["owner", "scope", "read", "read", "paid", "write"]);
    expect(requests[0].body).toEqual({ p_user_id: USER });
    for (const request of requests.slice(1)) {
      expect(request.headers.get("x-otodoke-sample-user")).toBe(USER);
      expect(request.headers.get("x-otodoke-sample-generation")).toBe(GENERATION);
    }
    expect(requests.filter((r) => r.method === "PATCH").map((r) => r.body)).toEqual([{ category: "food", category_source: "auto" }]);
    expect(mocks.paid).toHaveBeenCalledTimes(1);
    expect(mocks.client).toHaveBeenCalledWith({ apiKey: "synthetic-api-key", maxRetries: 0 });
  });

  it.each([
    [404, { code: "PGRST202", message: "Synthetic unsupported database" }],
    [200, null],
    [200, "not-a-generation"],
  ])("refuses an unavailable or malformed scope before paid work (HTTP %s)", async (status, value) => {
    scopeReply = { status, value };
    await runScript();
    expect(exit).toHaveBeenCalledWith(1);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("sample generation"));
    expect(events).toEqual(["owner", "scope"]);
    expect(mocks.requireEnv).not.toHaveBeenCalled();
    expect(mocks.client).not.toHaveBeenCalled();
    expect(mocks.paid).not.toHaveBeenCalled();
    expect(mocks.mkdir).not.toHaveBeenCalled();
    expect(mocks.writeFile).not.toHaveBeenCalled();
    expect(requests.filter((r) => r.method === "PATCH")).toEqual([]);
  });

  it("keeps dry-run read-only without requiring the generation migration or a paid client", async () => {
    process.argv = ["node", "categorize.ts", "--user", EMAIL, "--dry-run"];
    scopeReply = { status: 404, value: null };
    await runScript();
    expect(exit).not.toHaveBeenCalled();
    expect(events).toEqual(["owner", "read", "read"]);
    expect(requests.every((r) => r.method === "GET")).toBe(true);
    expect(mocks.client).not.toHaveBeenCalled();
    expect(mocks.paid).not.toHaveBeenCalled();
    expect(mocks.writeFile).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("dry run: nothing was sent or written"));
  });

  it("keeps the original generation after a clear and fails the write without retrying the paid call", async () => {
    clearAfterPaid = true;
    await runScript();
    expect(exit).toHaveBeenCalledWith(1);
    expect(error).toHaveBeenCalledWith("mail work was cleared; start it again");
    expect(mocks.paid).toHaveBeenCalledTimes(1);
    const writes = requests.filter((r) => r.method === "PATCH");
    expect(writes).toHaveLength(1);
    expect(writes[0].headers.get("x-otodoke-sample-generation")).toBe(GENERATION);
    expect(mocks.writeFile).not.toHaveBeenCalled();
  });
});
