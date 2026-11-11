import { APIConnectionError, APIConnectionTimeoutError, APIError } from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { claudeFailure } from "@/lib/extract/claude-error";

/** Which failures of a Claude call mean "stopped" and which mean "try later". Made-up bodies only. */

const apiError = (status: number, type: string, message: string) => APIError.generate(status, { type: "error", error: { type, message } }, message, new Headers());

const OWN_LIMIT = "You have reached your specified API usage limits. You will regain access on 2027-01-01 at 00:00 UTC.";
const WORKSPACE_LIMIT = "You have reached your specified workspace API usage limits. You will regain access on 2027-01-01 at 00:00 UTC.";
/** The tier monthly limit: a 429 whose body carries error.details.error_code, with no retry-after. */
const tierLimit = () => APIError.generate(429, { type: "error", error: { type: "rate_limit_error", message: "x", details: { error_code: "enforced_spend_limit_reached" } } }, "x", new Headers());

describe("spend limits are a stop too", () => {
  it("the own limit and the workspace limit (400), in the body form and in the message-only form", () => {
    for (const text of [OWN_LIMIT, WORKSPACE_LIMIT]) {
      expect(claudeFailure(apiError(400, "invalid_request_error", text)), text).toEqual({ code: "claude_unavailable", unbilled: true });
      // Without a parsed body the SDK message is "<status> <text>".
      expect(claudeFailure(APIError.generate(400, undefined, text, new Headers())), text).toEqual({ code: "claude_unavailable", unbilled: true });
    }
  });

  it("the tier monthly limit (429 with error_code enforced_spend_limit_reached)", () => {
    expect(claudeFailure(tierLimit())).toEqual({ code: "claude_unavailable", unbilled: true });
  });

  it("negative control: an ordinary 429 with retry-after (no error_code) stays temporary", () => {
    const err = APIError.generate(429, { type: "error", error: { type: "rate_limit_error", message: "Number of request tokens has exceeded your rate limit" } }, "x", new Headers({ "retry-after": "20" }));
    expect(claudeFailure(err)).toEqual({ code: "claude_error", unbilled: true });
    const other = APIError.generate(429, { type: "error", error: { type: "rate_limit_error", message: "x", details: { error_code: "something_else" } } }, "x", new Headers());
    expect(claudeFailure(other)).toEqual({ code: "claude_error", unbilled: true });
  });

  it("negative control: a 400 that only mentions usage limits, not as its opening, is not a stop", () => {
    expect(claudeFailure(apiError(400, "invalid_request_error", "messages.0: You have reached your specified API usage limits is not valid here"))).toEqual({ code: "claude_error", unbilled: true });
    expect(claudeFailure(apiError(400, "invalid_request_error", "Check your API usage limits"))).toEqual({ code: "claude_error", unbilled: true });
  });
});

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
