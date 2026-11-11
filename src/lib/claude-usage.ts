import { env } from "@/lib/env";
import type { AdminClient } from "@/lib/supabase/admin";

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

/**
 * Take one paid Claude call from today's allowance (claim_claude_call_v2, which also records the
 * claim so it can be given back). While the database has no v2 yet (before supabase/pending/
 * 20261111100000_claude_call_release.sql is applied, or after its rollback), the old
 * claim_claude_call is used and release() does nothing. Only a function that is not there falls
 * back; any other database error throws, so "missing" and "broken" are never mixed up.
 */
export async function claimClaudeCall(db: AdminClient, userId: string): Promise<ClaudeClaim> {
  const { OTODOKE_USER_DAILY_LIMIT, OTODOKE_GLOBAL_DAILY_LIMIT } = env();
  const args = { p_user_id: userId, p_user_limit: OTODOKE_USER_DAILY_LIMIT, p_global_limit: OTODOKE_GLOBAL_DAILY_LIMIT };

  const { data, error } = await db.rpc("claim_claude_call_v2", args);
  if (error) {
    if (!functionMissing(error)) throw new Error(`claim_claude_call failed: ${error.message}`);
    const old = await db.rpc("claim_claude_call", args);
    if (old.error) throw new Error(`claim_claude_call failed: ${old.error.message}`);
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
