import { APIConnectionError, APIError } from "@anthropic-ai/sdk";

/**
 * Why a Claude call failed, told apart for what the app does next.
 *  - claude_unavailable: the account cannot be used (no credit, a bad or refused key, no such model).
 *    Trying again does not help, so the reads stop and the mail is kept.
 *  - claude_error: probably temporary (rate limit, server trouble, a broken connection).
 * `unbilled`: the call was refused or never reached Claude, so the allowance taken for it can be
 * given back (src/lib/claude-usage.ts, used by the pipeline). A broken connection may have been served, so it is not unbilled.
 */
export type ClaudeFailure = { code: "claude_unavailable" | "claude_error"; unbilled: boolean };

/** Thrown by the pipeline when Claude cannot be used at all; callers stop instead of trying the next mail. */
export class ClaudeUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClaudeUnavailableError";
  }
}

type Body = { type?: unknown; message?: unknown; details?: { error_code?: unknown }; error?: Body };

/** The API's JSON body is `{type, error: {type, message, details?}}`; err.error holds it. */
function inner(err: APIError): Body | null {
  const body = err.error as Body | undefined;
  return body?.error ?? body ?? null;
}

function bodyErrorType(err: APIError): string | null {
  if (typeof err.type === "string") return err.type;
  const t = inner(err)?.type;
  return typeof t === "string" ? t : null;
}

/** The API's own message. Without a body the SDK's message is "<status> <text>", so the status is cut off. */
function bodyMessage(err: APIError): string {
  const m = inner(err)?.message;
  return typeof m === "string" ? m : err.message.replace(/^\d{3} /, "");
}

/** The spend limits an account sets for itself (own limit, workspace limit): not credit, but the same "stopped". */
const SPEND_LIMIT_OPENINGS = ["You have reached your specified API usage limits", "You have reached your specified workspace API usage limits"];

/** null when the error is not a failed Claude call (a reading that did not parse, a database error). */
export function claudeFailure(err: unknown): ClaudeFailure | null {
  if (!(err instanceof APIError)) return null;
  if (err instanceof APIConnectionError || typeof err.status !== "number") {
    return err instanceof APIConnectionError ? { code: "claude_error", unbilled: false } : null;
  }
  const status = err.status;
  if (status === 402 || status === 401 || status === 403 || status === 404) return { code: "claude_unavailable", unbilled: true };
  if (status === 400) {
    const text = bodyMessage(err);
    const stopped = bodyErrorType(err) === "billing_error" || /credit balance/i.test(text) || SPEND_LIMIT_OPENINGS.some((o) => text.startsWith(o));
    return { code: stopped ? "claude_unavailable" : "claude_error", unbilled: true };
  }
  // The tier's monthly spend limit is a 429 too, but with no retry-after: told apart by its error code, not by the text.
  if (status === 429 && inner(err)?.details?.error_code === "enforced_spend_limit_reached") return { code: "claude_unavailable", unbilled: true };
  return { code: "claude_error", unbilled: true };
}
