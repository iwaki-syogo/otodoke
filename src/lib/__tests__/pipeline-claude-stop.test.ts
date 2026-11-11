import { APIError } from "@anthropic-ai/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClaudeUnavailableError } from "@/lib/extract/claude-error";
import type { InboundEmail } from "@/lib/pipeline";
import { FakeDb } from "./fake-db";
import { USER, asConsentingAdmin, mailOf } from "./pipeline-fixtures";

/** A Claude call that fails leaves a fixed code in emails.error, never the raw message. Made-up mails only. */

const mocks = vi.hoisted(() => ({ extractEmail: vi.fn(), isPurchaseMail: vi.fn() }));
vi.mock("@/lib/extract/extract", () => ({ extractEmail: mocks.extractEmail }));
vi.mock("@/lib/extract/triage", () => ({ isPurchaseMail: mocks.isPurchaseMail }));

const { processInboundEmail } = await import("@/lib/pipeline");

const apiError = (status: number, type: string, message: string) => APIError.generate(status, { type: "error", error: { type, message } }, message, new Headers());
const mail = (): InboundEmail => ({ ...mailOf("2026-11-03T01:00:00Z"), messageId: "<stop@example.test>", subject: "ご注文ありがとうございます", text: "ご注文番号 ORD-1 を承りました" });
const seeded = () => new FakeDb({ emails: [] });

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon");
  mocks.extractEmail.mockReset();
  mocks.isPurchaseMail.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("a failed Claude call", () => {
  it("402: the row is failed with the code claude_unavailable, the raw message stays out of it, and ClaudeUnavailableError is thrown", async () => {
    mocks.extractEmail.mockRejectedValue(apiError(402, "billing_error", "RAW-BILLING-MESSAGE"));
    const db = seeded();
    await expect(processInboundEmail(asConsentingAdmin(db), mail())).rejects.toBeInstanceOf(ClaudeUnavailableError);
    const rows = db.rows("emails");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ user_id: USER, processing_status: "failed", error: "claude_unavailable" });
    expect(JSON.stringify(rows)).not.toContain("RAW-BILLING-MESSAGE");
    // The raw message is for the server log.
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).toContain("RAW-BILLING-MESSAGE");
  });

  it("500: failed with claude_error, and the original error is thrown (not the unavailable one)", async () => {
    const err = apiError(500, "api_error", "RAW-500");
    mocks.extractEmail.mockRejectedValue(err);
    const db = seeded();
    const thrown = await processInboundEmail(asConsentingAdmin(db), mail()).catch((e: unknown) => e);
    expect(thrown).toBe(err);
    expect(thrown).not.toBeInstanceOf(ClaudeUnavailableError);
    expect(db.rows("emails")[0]).toMatchObject({ processing_status: "failed", error: "claude_error" });
  });

  it("negative control: a reading that does not parse keeps the raw message, as before", async () => {
    mocks.extractEmail.mockRejectedValue(new SyntaxError("Unexpected token } in JSON"));
    const db = seeded();
    const thrown = await processInboundEmail(asConsentingAdmin(db), mail()).catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(SyntaxError);
    expect(db.rows("emails")[0]).toMatchObject({ processing_status: "failed", error: "Unexpected token } in JSON" });
  });
});
