import { env } from "@/lib/env";
import type { AdminClient } from "@/lib/supabase/admin";
import { AiReadingNotAllowedError } from "@/lib/ai-consent";

/** What a claim answered: "ok" (go ahead and call Claude) or the limit that was reached. */
export type ClaudeVerdict = "ok" | "user_limit" | "global_limit";
const VERDICTS: readonly string[] = ["ok", "user_limit", "global_limit"];

export interface ClaudeClaim {
  verdict: ClaudeVerdict;
  /**
   * Give the claimed call back, once. For a call Claude refused (nothing was billed). Does nothing
   * when the verdict is not "ok", when the database has no release yet, or after the first call.
   * Never throws: a failed release is logged and the allowance simply stays used.
   */
  release(): Promise<void>;
}

const nothingToRelease = async () => {};

/** The database does not know the function: PostgREST's PGRST202, or Postgres's 42883 / its message. */
function functionMissing(error: { code?: string; message?: string }): boolean {
  if (error.code === "PGRST202" || error.code === "42883") return true;
  return /could not find the function|function .* does not exist/i.test(error.message ?? "");
}

function asVerdict(value: unknown): ClaudeVerdict {
  if (typeof value !== "string" || !VERDICTS.includes(value)) throw new Error(`claim_claude_call failed: unexpected answer ${JSON.stringify(value)}`);
  return value as ClaudeVerdict;
}

/** Only the DB's fixed consent denial is a permission choice; lease/DB failures stay failures. */
function claimFailure(error: { code?: string; message: string }): Error {
  return error.code === "42501" && error.message === "ai_consent_required"
    ? new AiReadingNotAllowedError("ai_consent_required")
    : new Error(`claim_claude_call failed: ${error.message}`);
}

/**
 * Take one paid Claude call from today's allowance (claim_claude_call_v2, which also records the
 * claim so it can be given back). While the database has no v2 yet (before supabase/migrations/
 * 20261112020000_claude_call_release.sql is applied, or after its rollback), the old
 * claim_claude_call is used and release() does nothing. Only a function that is not there falls
 * back; any other database error throws, so "missing" and "broken" are never mixed up.
 */
export async function claimClaudeCall(db: AdminClient, userId: string): Promise<ClaudeClaim> {
  const { OTODOKE_USER_DAILY_LIMIT, OTODOKE_GLOBAL_DAILY_LIMIT } = env();
  const args = { p_user_id: userId, p_user_limit: OTODOKE_USER_DAILY_LIMIT, p_global_limit: OTODOKE_GLOBAL_DAILY_LIMIT };

  const { data, error } = await db.rpc("claim_claude_call_v2", args);
  if (error) {
    if (!functionMissing(error)) throw claimFailure(error);
    console.warn("claude-usage: claim_claude_call_v2 is missing, so the old claim_claude_call is used (a refused call is not given back)");
    const old = await db.rpc("claim_claude_call", args);
    if (old.error) throw claimFailure(old.error);
    return { verdict: asVerdict(old.data), release: nothingToRelease };
  }

  // A set-returning function: PostgREST answers with an array of one row.
  const row: unknown = Array.isArray(data) ? data[0] : data;
  const fields = row && typeof row === "object" ? (row as { verdict?: unknown; claim_id?: unknown }) : {};
  const verdict = asVerdict(fields.verdict);
  if (verdict !== "ok") return { verdict, release: nothingToRelease };
  const id = fields.claim_id;
  if (typeof id !== "number") throw new Error("claim_claude_call failed: no claim id came back");

  let released = false;
  return {
    verdict,
    async release() {
      if (released) return;
      released = true;
      try {
        const { error: releaseError } = await db.rpc("release_claude_call", { p_claim_id: id, p_user_id: userId });
        if (releaseError) console.warn("claude-usage: could not give back the allowance:", releaseError.message);
      } catch (err) {
        console.warn("claude-usage: could not give back the allowance:", err instanceof Error ? err.message : err);
      }
    },
  };
}
