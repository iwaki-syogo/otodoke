import { APIConnectionError, APIConnectionTimeoutError, APIError } from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { claudeFailure } from "@/lib/extract/claude-error";

/** Which failures of a Claude call mean "stopped" and which mean "try later". Made-up bodies only. */

const apiError = (status: number, type: string, message: string) => APIError.generate(status, { type: "error", error: { type, message } }, message, new Headers());

describe("claudeFailure", () => {
  it("credit gone, a refused key, a missing model: unavailable, and the call was not billed", () => {
    const creditOut = apiError(400, "invalid_request_error", "Your credit balance is too low to access the Anthropic API.");
    const billing = apiError(400, "billing_error", "Billing problem");
    for (const err of [creditOut, billing, apiError(402, "billing_error", "x"), apiError(401, "authentication_error", "x"), apiError(403, "permission_error", "x"), apiError(404, "not_found_error", "x")]) {
      expect(claudeFailure(err)).toEqual({ code: "claude_unavailable", unbilled: true });
    }
  });

  it("negative control: a 400 that is not about credit is not unavailable", () => {
    expect(claudeFailure(apiError(400, "invalid_request_error", "max_tokens must be positive"))).toEqual({ code: "claude_error", unbilled: true });
  });

  it("rate limit, server trouble, overload and other statuses: temporary", () => {
    for (const status of [429, 500, 502, 529, 409, 422]) {
      expect(claudeFailure(apiError(status, "api_error", "x")), String(status)).toEqual({ code: "claude_error", unbilled: true });
    }
  });

  it("a timeout or a broken connection: temporary, and may have been billed", () => {
    expect(claudeFailure(new APIConnectionTimeoutError())).toEqual({ code: "claude_error", unbilled: false });
    expect(claudeFailure(new APIConnectionError({ message: "reset" }))).toEqual({ code: "claude_error", unbilled: false });
  });

  it("an answer that did not parse, a database error, or anything else is not a Claude failure", () => {
    expect(claudeFailure(new SyntaxError("Unexpected token"))).toBeNull();
    expect(claudeFailure(new ZodError([]))).toBeNull();
    expect(claudeFailure(new Error("emails update failed: boom"))).toBeNull();
    expect(claudeFailure("credit balance")).toBeNull();
    expect(claudeFailure(null)).toBeNull();
  });
});
