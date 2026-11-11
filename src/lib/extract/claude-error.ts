import { APIConnectionError, APIError } from "@anthropic-ai/sdk";

/**
 * Why a Claude call failed, told apart for what the app does next.
 *  - claude_unavailable: the account cannot be used (no credit, a bad or refused key, no such model).
 *    Trying again does not help, so the reads stop and the mail is kept.
 *  - claude_error: probably temporary (rate limit, server trouble, a broken connection).
 * `unbilled`: the call was refused or never reached Claude, so the allowance taken for it can be
 * given back. A broken connection may have been served, so it is not unbilled.
 */
export type ClaudeFailure = { code: "claude_unavailable" | "claude_error"; unbilled: boolean };

/** Thrown by the pipeline when Claude cannot be used at all; callers stop instead of trying the next mail. */
export class ClaudeUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClaudeUnavailableError";
  }
}

function bodyErrorType(err: APIError): string | null {
  if (typeof err.type === "string") return err.type;
  const body = err.error as { error?: { type?: unknown }; type?: unknown } | undefined;
  const inner = body?.error?.type ?? body?.type;
  return typeof inner === "string" ? inner : null;
}

/** null when the error is not a failed Claude call (a reading that did not parse, a database error). */
export function claudeFailure(err: unknown): ClaudeFailure | null {
  if (!(err instanceof APIError)) return null;
  if (err instanceof APIConnectionError || typeof err.status !== "number") {
    return err instanceof APIConnectionError ? { code: "claude_error", unbilled: false } : null;
  }
  const status = err.status;
  if (status === 402 || status === 401 || status === 403 || status === 404) return { code: "claude_unavailable", unbilled: true };
  if (status === 400) {
    const creditOut = bodyErrorType(err) === "billing_error" || /credit balance/i.test(err.message);
    return { code: creditOut ? "claude_unavailable" : "claude_error", unbilled: true };
  }
  return { code: "claude_error", unbilled: true };
}
