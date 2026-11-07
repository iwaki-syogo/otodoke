import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeDb, type Row } from "./fake-db";
import { reading } from "./pipeline-fixtures";

/**
 * 「読み取る」 (readWaitingMail) meets a sample mail that an interrupted loadDemo left pending.
 * It must be read the way loadDemo reads it (precomputed, plain, no Claude); a normal mail still
 * goes through Claude. Anonymized sample mails and made-up mails only.
 */

const USER = "00000000-0000-4000-8000-00000000000a";
const mocks = vi.hoisted(() => ({ db: null as unknown, redirect: vi.fn(), extract: vi.fn() }));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    mocks.redirect(to);
    throw new Error(`NEXT_REDIRECT ${to}`);
  },
}));
vi.mock("@/lib/supabase/server", () => ({ getUser: async () => ({ id: USER, email: "qa@example.com" }) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => mocks.db }));
vi.mock("@/lib/extract/extract", () => ({ extractEmail: mocks.extract }));

const { loadDemo, readWaitingMail } = await import("@/app/app/settings/actions");

const OLD = new Date(Date.now() - 10 * 60_000).toISOString();

const newDb = (emails: Row[] = []) => {
  // The pipeline's "young pending row" check reads the real time.
  return new FakeDb({ emails, parcels: [] }, Date.now());
};
const run = async (fn: () => Promise<void>) => {
  mocks.redirect.mockClear();
  await expect(fn()).rejects.toThrow("NEXT_REDIRECT");
  return mocks.redirect.mock.calls.map((c) => c[0] as string);
};
/** The parcel's identity (later mails of the same order move its status and dates, so those are left out). */
const identity = (d: FakeDb) => d.rows("parcels").map((p) => JSON.stringify({ title: p.title, order_number: p.order_number, total_amount: p.total_amount }));

/** What an interrupted loadDemo leaves: the first sample mail as a pending row older than 3 minutes. */
const stuckSample = async () => {
  const probe = newDb();
  mocks.db = probe;
  await run(loadDemo);
  return { ...probe.rows("emails")[0], processing_status: "pending", body_state: "plain", created_at: OLD };
};

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon");
  mocks.extract.mockReset();
  mocks.extract.mockResolvedValue({
    data: reading({ relevance: "order" }),
    model: "m",
    truncated: false,
    usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  });
});

describe("readWaitingMail with a sample mail left pending", () => {
  it("reads it as loadDemo does: no Claude, kept in plain text, the same parcel", async () => {
    const stuck = await stuckSample();
    const db = newDb([stuck]);
    mocks.db = db;
    expect(await run(readWaitingMail)).toEqual(["/app/settings/trouble"]);
    expect(mocks.extract).not.toHaveBeenCalled();
    expect(db.callsOn("emails", "insert")).toHaveLength(0);
    expect(db.rpcCalls.filter((c) => c.name === "claim_claude_call")).toHaveLength(0);
    expect(db.rows("emails")).toHaveLength(1);
    expect(db.rows("emails")[0]).toMatchObject({ processing_status: "processed", body_state: "plain" });
    expect(db.rows("emails")[0].text_body).not.toBeNull();

    // The same parcel loadDemo files for this mail (its full load files it among the others).
    const alone = newDb();
    mocks.db = alone;
    await run(loadDemo);
    expect(db.rows("parcels")).toHaveLength(1);
    expect(identity(alone)).toEqual(expect.arrayContaining(identity(db)));
    expect(db.rows("parcel_items").length).toBeGreaterThan(0);
  });

  it("a sample id with no matching sample: Claude is not called and the read ends as failed", async () => {
    const stuck = await stuckSample();
    const db = newDb([{ ...stuck, provider_email_id: "demo:gone/missing", message_id: "demo:gone/missing" }]);
    mocks.db = db;
    const [to] = await run(readWaitingMail);
    expect(to).toContain("error=read_failed");
    expect(mocks.extract).not.toHaveBeenCalled();
    expect(db.rows("emails")[0].processing_status).toBe("pending");
  });

  it("negative control: an ordinary waiting mail still goes through Claude", async () => {
    const stuck = await stuckSample();
    const db = newDb([
      { ...stuck, provider_email_id: "re_ordinary", message_id: "<ordinary@example.test>", from_address: "orders@shop.example.test", subject: "ご注文ありがとうございます", processing_status: "over_limit" },
    ]);
    mocks.db = db;
    await run(readWaitingMail);
    expect(mocks.extract).toHaveBeenCalledTimes(1);
  });
});
