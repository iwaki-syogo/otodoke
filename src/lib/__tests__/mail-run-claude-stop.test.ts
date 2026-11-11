import { APIError } from "@anthropic-ai/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeDb, type Row } from "./fake-db";
import { USER, asAdmin, precomputed, reading } from "./pipeline-fixtures";

/** 「読み取る」 with Claude stopped ends at the first mail; one failing mail does not stop the rest. Made-up mails only. */

const mocks = vi.hoisted(() => ({ extractEmail: vi.fn(), isPurchaseMail: vi.fn() }));
vi.mock("@/lib/extract/extract", () => ({ extractEmail: mocks.extractEmail }));
vi.mock("@/lib/extract/triage", () => ({ isPurchaseMail: mocks.isPurchaseMail }));

const { runReadWaitingMail } = await import("@/lib/mail-run");

const apiError = (status: number, type: string) => APIError.generate(status, { type: "error", error: { type, message: "x" } }, "x", new Headers());
const waiting = (n: number): Row => ({
  id: `e${n}`,
  user_id: USER,
  body_state: "plain",
  processing_status: "over_limit",
  provider_email_id: `p${n}`,
  message_id: `<m${n}@example.test>`,
  from_address: "shop@example.test",
  from_name: null,
  subject: "ご注文ありがとうございます",
  sent_at: `2026-11-01T00:${String(n).padStart(2, "0")}:00Z`,
  text_body: `ご注文番号 ORD-${n} を承りました`,
  html_body: null,
  created_at: "2026-11-01T00:00:00Z",
});
const twenty = () => new FakeDb({ emails: Array.from({ length: 20 }, (_, i) => waiting(i + 1)), parcels: [] });

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon");
  mocks.extractEmail.mockReset();
  mocks.extractEmail.mockImplementation(async () => precomputed(reading({ relevance: "unrelated" })));
  mocks.isPurchaseMail.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("runReadWaitingMail when Claude fails", () => {
  it("20 waiting, the first call 402: Claude is asked once and the result says unavailable", async () => {
    mocks.extractEmail.mockRejectedValueOnce(apiError(402, "billing_error"));
    const db = twenty();
    const done = await runReadWaitingMail(asAdmin(db), USER);
    expect(mocks.extractEmail).toHaveBeenCalledTimes(1);
    expect(done).toMatchObject({ unavailable: true, read: 0 });
    expect(db.rows("emails").filter((e) => e.error === "claude_unavailable")).toHaveLength(1);
  });

  it("negative control: only the first call 500 — the rest are still read, and it is not unavailable", async () => {
    mocks.extractEmail.mockRejectedValueOnce(apiError(500, "api_error"));
    const done = await runReadWaitingMail(asAdmin(twenty()), USER);
    expect(mocks.extractEmail).toHaveBeenCalledTimes(20);
    expect(done).toMatchObject({ ok: false, unavailable: false, read: 19 });
  });

  it("all read: not unavailable", async () => {
    expect(await runReadWaitingMail(asAdmin(twenty()), USER)).toMatchObject({ ok: true, unavailable: false, read: 20 });
  });
});
