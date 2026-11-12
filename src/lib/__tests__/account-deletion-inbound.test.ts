import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeDb } from "./fake-db";
import type { AdminClient } from "@/lib/supabase/admin";

/**
 * After an account is deleted its receiving address has no row (the cascade took it, and the
 * registry keeps the value from being given out again). Mail the user's Gmail still forwards
 * there must be answered 2xx and dropped: a 5xx would make Resend send it again and again.
 * Only a failed lookup is 5xx (that mail is kept for a retry, not lost).
 */

const DOMAIN = "in.example.test";
const DELETED = "aaaaaaaaaa";
const LIVE = "bbbbbbbbbb";
const LIVE_USER = "00000000-0000-4000-8000-00000000000b";

const mocks = vi.hoisted(() => ({
  db: null as unknown,
  to: [] as string[],
  processInboundEmail: vi.fn<(...args: unknown[]) => Promise<{ kind: string }>>(async () => ({ kind: "processed" })),
}));

vi.mock("resend", () => ({
  Resend: class {
    webhooks = { verify: () => ({ type: "email.received", data: { email_id: "re_test_1" } }) };
    emails = {
      receiving: {
        get: async () => ({
          data: {
            id: "re_test_1",
            message_id: "<order-1@shop.example>",
            from: "shop@shop.example",
            to: mocks.to,
            received_for: mocks.to,
            subject: "ご注文ありがとうございます",
            text: "注文番号 123",
            html: null,
            headers: {},
            created_at: "2026-11-06T03:00:00Z",
          },
          error: null,
        }),
      },
    };
  },
}));
vi.mock("@/lib/env", () => ({
  requireEnv: (name: string) => ({ RESEND_API_KEY: "re_test", RESEND_WEBHOOK_SECRET: "whsec_test", INBOUND_DOMAIN: DOMAIN })[name] ?? "",
  env: () => ({}),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => mocks.db }));
vi.mock("@/lib/pipeline", () => ({ processInboundEmail: mocks.processInboundEmail }));

const { POST } = await import("@/app/api/inbound/route");

async function deliver(to: string) {
  mocks.to = [to];
  const res = await POST(new Request("https://otodoke.app/api/inbound", { method: "POST", body: "{}", headers: { "svix-id": "msg_1", "svix-timestamp": "1", "svix-signature": "v1,x" } }));
  return { status: res.status, body: await res.json() };
}

let db: FakeDb;
beforeEach(() => {
  // The deleted user's row went with the cascade; another user's address is still there.
  db = new FakeDb({ inbox_addresses: [{ id: "i1", user_id: LIVE_USER, local_part: LIVE }] });
  mocks.db = db;
  mocks.processInboundEmail.mockClear();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("mail to the address of a deleted account", () => {
  it("is answered 200 and dropped: nothing is read or stored", async () => {
    expect(await deliver(`${DELETED}@${DOMAIN}`)).toEqual({ status: 200, body: { ignored: "unknown inbox" } });
    expect(await deliver(`${DELETED}+amazon@${DOMAIN}`)).toEqual({ status: 200, body: { ignored: "unknown inbox" } });
    expect(mocks.processInboundEmail).not.toHaveBeenCalled();
    expect(db.callsOn("inbox_addresses", "select").map((q) => q.filters)).toEqual([
      [{ method: "eq", args: ["local_part", DELETED] }],
      [{ method: "eq", args: ["local_part", DELETED] }],
    ]);
  });

  it("positive control: mail to an address in use is processed for its owner", async () => {
    expect((await deliver(`${LIVE}@${DOMAIN}`)).status).toBe(200);
    expect(mocks.processInboundEmail).toHaveBeenCalledTimes(1);
    const scoped = mocks.processInboundEmail.mock.calls[0][0] as AdminClient;
    expect(scoped).not.toBe(db);
    expect(mocks.processInboundEmail.mock.calls[0]).toEqual([scoped, expect.objectContaining({ userId: LIVE_USER })]);
    await scoped.from("emails").select("id");
    expect(db.callsOn("emails", "select").at(-1)?.requestHeaders).toEqual({
      "x-otodoke-sample-user": LIVE_USER,
      "x-otodoke-sample-generation": db.rows("sample_generations").find((row) => row.user_id === LIVE_USER)!.generation,
    });
  });

  it("only a failed lookup is a 5xx (kept for Resend to send again), never a missing row", async () => {
    db.hooks.push((q) => (q.table === "inbox_addresses" ? { data: null, error: { message: "connection reset" } } : undefined));
    expect(await deliver(`${DELETED}@${DOMAIN}`)).toEqual({ status: 500, body: { error: "lookup failed" } });
    expect(mocks.processInboundEmail).not.toHaveBeenCalled();
  });
});
