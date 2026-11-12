import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeDb } from "./fake-db";
import type { AdminClient } from "@/lib/supabase/admin";
import { AiReadingNotAllowedError } from "@/lib/ai-consent";

/**
 * POST /api/inbound (Resend's `email.received` webhook), after the review of 2026-11-06 (item 8).
 *
 * What it answered before is kept: a bad signature 400, another event 200, no email_id 400, a
 * failed fetch 502, no recipient on our domain 200, a failed lookup 500, an address nobody has 200,
 * a failed processing 500, else 200 with the outcome. 5xx is what makes Resend send it again.
 *
 * Changed:
 *  - The address nobody has is no longer logged (the log said which local part was tried).
 *  - When the event already names the envelope recipients, the address is looked up before the
 *    mail is fetched from Resend: a mail for an address nobody has is not fetched at all. An event
 *    without them is fetched first and routed by the fetched mail, as before.
 * Made-up addresses only.
 */

const DOMAIN = "in.example.test";
const KNOWN = "bbbbbbbbbb";
const OTHER = "cccccccccc";
const UNKNOWN = "aaaaaaaaaa";
const USER = "00000000-0000-4000-8000-00000000000b";
const OTHER_USER = "00000000-0000-4000-8000-00000000000c";

type Mail = { id: string; message_id: string | null; from: string; to: string[]; received_for: string[]; subject: string; text: string | null; html: string | null; headers: Record<string, string>; created_at: string };

const mocks = vi.hoisted(() => ({
  db: null as unknown,
  verify: (() => ({})) as () => unknown,
  fetched: null as unknown,
  fetchError: null as unknown,
  gets: [] as string[],
  adminMade: 0,
  scheduleSeal: vi.fn(),
  processInboundEmail: vi.fn<(...args: unknown[]) => Promise<{ kind: string }>>(async () => ({ kind: "processed" })),
}));

vi.mock("resend", () => ({
  Resend: class {
    webhooks = { verify: () => mocks.verify() };
    emails = {
      receiving: {
        get: async (id: string) => {
          mocks.gets.push(id);
          return mocks.fetchError ? { data: null, error: mocks.fetchError } : { data: mocks.fetched, error: null };
        },
      },
    };
  },
}));
vi.mock("@/lib/env", () => ({
  requireEnv: (name: string) => ({ RESEND_API_KEY: "re_test", RESEND_WEBHOOK_SECRET: "whsec_test", INBOUND_DOMAIN: DOMAIN })[name] ?? "",
  env: () => ({}),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => {
    mocks.adminMade++;
    return mocks.db;
  },
}));
vi.mock("@/lib/pipeline", () => ({ processInboundEmail: mocks.processInboundEmail }));
vi.mock("@/lib/seal-later", () => ({ scheduleSealRemaining: mocks.scheduleSeal }));

const { POST } = await import("@/app/api/inbound/route");

const mail = (over: Partial<Mail> = {}): Mail => ({
  id: "re_test_1",
  message_id: "<order-1@shop.example.test>",
  from: "ショップ <shop@shop.example.test>",
  to: [`${KNOWN}@${DOMAIN}`],
  received_for: [`${KNOWN}@${DOMAIN}`],
  subject: "ご注文ありがとうございます",
  text: "注文番号 123",
  html: null,
  headers: { date: "Sun, 01 Nov 2020 12:00:00 +0900" },
  created_at: "2026-11-05T03:00:00Z",
  ...over,
});

/** The event as Resend sends it: the recipients and subject, no body. */
const received = (data: Record<string, unknown> = {}) => () => ({ type: "email.received", data: { email_id: "re_test_1", ...data } });

async function post() {
  const res = await POST(new Request("https://otodoke.example.test/api/inbound", { method: "POST", body: "{}", headers: { "svix-id": "msg_1", "svix-timestamp": "1", "svix-signature": "v1,x" } }));
  return { status: res.status, body: await res.json() };
}

let db: FakeDb;
let warn: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;
const logged = () => JSON.stringify([...warn.mock.calls, ...error.mock.calls]);
const lookups = () => db.callsOn("inbox_addresses", "select").map((q) => q.filters);

beforeEach(() => {
  db = new FakeDb({ inbox_addresses: [{ id: "i1", user_id: USER, local_part: KNOWN }, { id: "i2", user_id: OTHER_USER, local_part: OTHER }] });
  mocks.db = db;
  mocks.verify = received();
  mocks.fetched = mail();
  mocks.fetchError = null;
  mocks.gets = [];
  mocks.adminMade = 0;
  mocks.scheduleSeal.mockReset();
  mocks.processInboundEmail.mockReset();
  mocks.processInboundEmail.mockImplementation(async () => ({ kind: "processed" }));
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  error = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("what the webhook answers (kept as it was)", () => {
  it("a bad signature: 400, nothing fetched or looked up", async () => {
    mocks.verify = () => {
      throw new Error("No matching signature found");
    };
    expect(await post()).toEqual({ status: 400, body: { error: "invalid signature" } });
    expect(mocks.gets).toEqual([]);
    expect(lookups()).toEqual([]);
  });

  it("another event: 200, ignored", async () => {
    mocks.verify = () => ({ type: "email.delivered", data: { email_id: "re_test_1" } });
    expect(await post()).toEqual({ status: 200, body: { ignored: "email.delivered" } });
    expect(mocks.gets).toEqual([]);
  });

  it("no email_id: 400", async () => {
    mocks.verify = () => ({ type: "email.received", data: {} });
    expect(await post()).toEqual({ status: 400, body: { error: "missing email_id" } });
  });

  it("the fetch fails: 502, so Resend sends it again", async () => {
    mocks.fetchError = { name: "internal_server_error", message: "boom" };
    expect(await post()).toEqual({ status: 502, body: { error: "fetch failed" } });
    expect(mocks.processInboundEmail).not.toHaveBeenCalled();
  });

  it("no recipient on our domain: 200, and the log has a count, no address", async () => {
    mocks.fetched = mail({ to: ["taro@mail.example.test"], received_for: ["taro@mail.example.test"] });
    expect(await post()).toEqual({ status: 200, body: { ignored: "no matching recipient" } });
    expect(logged()).not.toContain("taro");
    expect(mocks.processInboundEmail).not.toHaveBeenCalled();
  });

  it("a failed lookup: 500 (kept for a retry, never taken as no such address)", async () => {
    db.hooks.push((q) => (q.table === "inbox_addresses" ? { data: null, error: { message: "connection reset" } } : undefined));
    expect(await post()).toEqual({ status: 500, body: { error: "lookup failed" } });
    expect(mocks.processInboundEmail).not.toHaveBeenCalled();
  });

  it("an address nobody has: 200 and dropped, and the address is not logged", async () => {
    mocks.fetched = mail({ to: [`${UNKNOWN}@${DOMAIN}`], received_for: [`${UNKNOWN}+shop@${DOMAIN}`] });
    expect(await post()).toEqual({ status: 200, body: { ignored: "unknown inbox" } });
    expect(mocks.processInboundEmail).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    expect(logged()).not.toContain(UNKNOWN);
  });

  it("a known address: processed for its owner (envelope first, +tag and case dropped), 200 with the outcome", async () => {
    mocks.fetched = mail({ to: [`${OTHER}@${DOMAIN}`], received_for: [`${KNOWN.toUpperCase()}+Amazon@${DOMAIN.toUpperCase()}`] });
    expect(await post()).toEqual({ status: 200, body: { ok: true, outcome: "processed" } });
    expect(mocks.processInboundEmail).toHaveBeenCalledTimes(1);
    const processingClient = mocks.processInboundEmail.mock.calls[0][0] as AdminClient;
    expect(processingClient).not.toBe(db);
    await processingClient.from("emails").select("id");
    expect(db.callsOn("emails", "select").at(-1)?.requestHeaders).toEqual({
      "x-otodoke-sample-user": USER,
      "x-otodoke-sample-generation": db.rows("sample_generations").find((row) => row.user_id === USER)!.generation,
    });
    expect(mocks.processInboundEmail.mock.calls[0]).toEqual([
      processingClient,
      {
        userId: USER,
        providerEmailId: "re_test_1",
        messageId: "<order-1@shop.example.test>",
        from: "ショップ <shop@shop.example.test>",
        fromName: "ショップ",
        subject: "ご注文ありがとうございます",
        sentAt: "2020-11-01T03:00:00.000Z",
        text: "注文番号 123",
        html: null,
      },
    ]);
  });

  it("the database client is made only for a lookup: none for a refused, ignored, unfetched or unaddressed mail", async () => {
    mocks.verify = () => {
      throw new Error("No matching signature found");
    };
    await post();
    mocks.verify = () => ({ type: "email.delivered", data: { email_id: "re_test_1" } });
    await post();
    mocks.verify = received();
    mocks.fetchError = { name: "internal_server_error", message: "boom" };
    await post();
    mocks.fetchError = null;
    mocks.fetched = mail({ to: ["taro@mail.example.test"], received_for: ["taro@mail.example.test"] });
    await post();
    expect(mocks.adminMade).toBe(0);
    mocks.fetched = mail();
    await post();
    expect(mocks.adminMade).toBe(1);
  });

  it("processing fails: 500, and the log has the message, not the mail", async () => {
    mocks.processInboundEmail.mockImplementation(async () => {
      throw Object.assign(new Error("claim failed"), { code: "XX000", mail: "注文番号 123" });
    });
    expect(await post()).toEqual({ status: 500, body: { error: "processing failed" } });
    expect(logged()).toContain("claim failed");
    expect(logged()).not.toContain("注文番号");
  });
});

describe("the event's recipients are checked before the mail is fetched", () => {
  const announcing = (address: string) => received({ to: [address], received_for: [address], from: "shop@shop.example.test", subject: "ご注文" });

  it("an address nobody has is answered 200 without fetching the mail", async () => {
    mocks.verify = announcing(`${UNKNOWN}@${DOMAIN}`);
    mocks.fetched = mail({ to: [`${UNKNOWN}@${DOMAIN}`], received_for: [`${UNKNOWN}@${DOMAIN}`] });
    expect(await post()).toEqual({ status: 200, body: { ignored: "unknown inbox" } });
    expect(mocks.gets).toEqual([]);
    expect(lookups()).toEqual([[{ method: "eq", args: ["local_part", UNKNOWN] }]]);
    expect(logged()).not.toContain(UNKNOWN);
  });

  it("a failed lookup is 500 without fetching the mail (Resend sends it again)", async () => {
    mocks.verify = announcing(`${KNOWN}@${DOMAIN}`);
    db.hooks.push((q) => (q.table === "inbox_addresses" ? { data: null, error: { message: "connection reset" } } : undefined));
    expect(await post()).toEqual({ status: 500, body: { error: "lookup failed" } });
    expect(mocks.gets).toEqual([]);
  });

  it("a known address: looked up once, then fetched and processed", async () => {
    mocks.verify = announcing(`${KNOWN}@${DOMAIN}`);
    expect(await post()).toEqual({ status: 200, body: { ok: true, outcome: "processed" } });
    expect(mocks.gets).toEqual(["re_test_1"]);
    expect(lookups()).toEqual([[{ method: "eq", args: ["local_part", KNOWN] }]]);
    expect(mocks.processInboundEmail.mock.calls[0][1]).toEqual(expect.objectContaining({ userId: USER }));
  });

  it("the fetched mail still decides: another address there is looked up as before", async () => {
    mocks.verify = announcing(`${KNOWN}@${DOMAIN}`);
    mocks.fetched = mail({ to: [`${OTHER}@${DOMAIN}`], received_for: [`${OTHER}@${DOMAIN}`] });
    expect((await post()).status).toBe(200);
    expect(lookups()).toEqual([[{ method: "eq", args: ["local_part", KNOWN] }], [{ method: "eq", args: ["local_part", OTHER] }]]);
    expect(mocks.processInboundEmail.mock.calls[0][1]).toEqual(expect.objectContaining({ userId: OTHER_USER }));
  });

  it("an event without the envelope recipients is fetched first, as before (its To alone does not decide)", async () => {
    // To is the user's own address on a forwarded mail; only the envelope names ours.
    mocks.verify = received({ to: [`${UNKNOWN}@${DOMAIN}`] });
    mocks.fetched = mail({ to: [`${UNKNOWN}@${DOMAIN}`], received_for: [`${KNOWN}@${DOMAIN}`] });
    expect(await post()).toEqual({ status: 200, body: { ok: true, outcome: "processed" } });
    expect(mocks.gets).toEqual(["re_test_1"]);
    expect(mocks.processInboundEmail.mock.calls[0][1]).toEqual(expect.objectContaining({ userId: USER }));
  });

  it("an event with no recipient on our domain is fetched first, as before", async () => {
    mocks.verify = received({ to: ["taro@mail.example.test"], received_for: ["taro@mail.example.test"] });
    expect((await post()).status).toBe(200);
    expect(mocks.gets).toEqual(["re_test_1"]);
    expect(mocks.processInboundEmail).toHaveBeenCalledTimes(1);
  });
});

describe("sealing the user's older plaintext mail (automatic, once per request)", () => {
  it("a processed mail schedules one bounded sealing for its owner, with the same client", async () => {
    expect((await post()).status).toBe(200);
    expect(mocks.scheduleSeal).toHaveBeenCalledTimes(1);
    expect(mocks.scheduleSeal).toHaveBeenCalledWith(USER, mocks.processInboundEmail.mock.calls[0][0]);
  });

  it("negative controls: a mail that is not processed, or for nobody, schedules nothing", async () => {
    mocks.processInboundEmail.mockRejectedValue(new Error("down"));
    expect((await post()).status).toBe(500);
    mocks.processInboundEmail.mockImplementation(async () => ({ kind: "processed" }));
    mocks.fetched = mail({ to: [`${UNKNOWN}@${DOMAIN}`], received_for: [`${UNKNOWN}@${DOMAIN}`] });
    mocks.verify = received({ received_for: [`${UNKNOWN}@${DOMAIN}`] });
    expect((await post()).status).toBe(200);
    expect(mocks.scheduleSeal).not.toHaveBeenCalled();
  });
});

describe("Claude is stopped", () => {
  it("200 with outcome unavailable (the mail is stored; retrying would not help), and the mail is not logged", async () => {
    const { ClaudeUnavailableError } = await import("@/lib/extract/claude-error");
    mocks.processInboundEmail.mockImplementation(async () => {
      throw new ClaudeUnavailableError("claude is unavailable");
    });
    expect(await post()).toEqual({ status: 200, body: { ok: true, outcome: "unavailable" } });
    expect(logged()).not.toContain("注文番号");
  });

  it("negative control: any other throw is still 500", async () => {
    mocks.processInboundEmail.mockImplementation(async () => {
      throw new Error("claude is unavailable");
    });
    expect(await post()).toEqual({ status: 500, body: { error: "processing failed" } });
  });
});

describe("mail stored while waiting for reading permission", () => {
  it("answers 200 for a deliberate wait, so granting later cannot make a webhook retry start a paid read", async () => {
    mocks.processInboundEmail.mockRejectedValue(new AiReadingNotAllowedError("ai_consent_required"));
    expect(await post()).toEqual({ status: 200, body: { ok: true, outcome: "ai_consent_required" } });
    expect(mocks.scheduleSeal).not.toHaveBeenCalled();
    expect(logged()).not.toContain("注文番号");
  });

  it("a failed consent lookup is still 500 for recovery, and an unrelated error with the same message is not acknowledged", async () => {
    mocks.processInboundEmail.mockRejectedValue(new AiReadingNotAllowedError("ai_consent_unknown"));
    expect(await post()).toEqual({ status: 500, body: { error: "processing failed" } });
    mocks.processInboundEmail.mockRejectedValue(new Error("ai_consent_required"));
    expect(await post()).toEqual({ status: 500, body: { error: "processing failed" } });
  });
});
