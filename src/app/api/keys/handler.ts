import type { ZodType } from "zod";
import { checkFresh, readBearerSession } from "@/lib/auth-session";
import { keyStepCode, type KeyStepFailure } from "@/lib/login-errors";
import type { KeyResult } from "@/lib/mail-keys";
import { createAdminClient, type AdminClient } from "@/lib/supabase/admin";

/**
 * The key steps for the iOS app (decision 13), which cannot call Server Actions: the same functions
 * of src/lib/mail-keys.ts the web's key-actions.ts calls, behind the same checks.
 *
 * - POST only (Next.js answers 405 for anything else), JSON in and out, no CORS (a native app).
 * - `Authorization: Bearer <the Supabase access token of the user>`, checked by Supabase Auth
 *   (getUser(token)), and fresh: signed in with the password in the last 15 minutes, for every step
 *   (src/lib/auth-session.ts `login`). A session from the 8-digit code, a magic link or a reset link
 *   is refused (review R3-PW-2): the app does not reset, and the code still signs in to its second build.
 * - The body is parsed strictly (the mail-keys schemas): an unknown field is refused.
 * - The answer: 200 { ok: true, ... } or { ok: false, code } with the status below. docs/api/keys.md.
 */

export type KeysApiCode = "unauthorized" | "stale_session" | "unavailable" | "invalid_input" | KeyStepFailure;

const STATUS: Record<KeysApiCode, number> = {
  unauthorized: 401,
  stale_session: 403,
  invalid_input: 400,
  key_in_use_changed: 409,
  key_wrap_changed: 409,
  key_not_pending: 409,
  key_not_in_use: 409,
  key_challenge_failed: 422,
  key_failed: 500,
  unavailable: 503,
};

/** The largest body taken; a registration is about 1 KB. */
const MAX_BODY = 16 * 1024;

const NO_STORE = { "Cache-Control": "no-store" };

export function failure(code: KeysApiCode): Response {
  return Response.json({ ok: false, code }, { status: STATUS[code], headers: NO_STORE });
}

/** The body as JSON; undefined when it is not JSON or too long. */
async function body(request: Request): Promise<unknown> {
  const text = await request.text();
  if (text.length > MAX_BODY) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * One key step: the bearer's session, fresh; the body, by `schema`; then `run` with the service
 * role (like key-actions.ts) and the user's id from the token, never from the body.
 */
export async function keyStep<I, T extends object>(
  step: string,
  request: Request,
  schema: ZodType<I>,
  run: (db: AdminClient, userId: string, input: I) => Promise<KeyResult<T>>,
): Promise<Response> {
  const check = checkFresh(await readBearerSession(request.headers.get("authorization")), "login");
  if (!check.ok) {
    if (check.reason === "unknown") return failure("unavailable");
    return failure(check.reason === "stale" ? "stale_session" : "unauthorized");
  }
  const parsed = schema.safeParse(await body(request));
  if (!parsed.success) return failure("invalid_input");

  let result: KeyResult<T>;
  try {
    result = await run(createAdminClient(), check.session.userId, parsed.data);
  } catch (thrown) {
    console.error(`[keys-api] ${step} threw:`, thrown instanceof Error ? thrown.name : typeof thrown);
    return failure("key_failed");
  }
  if (!result.ok) {
    const code = keyStepCode(result.error);
    // The code only: the text can carry a database message.
    console.warn(`[keys-api] ${step} refused:`, code);
    return failure(code);
  }
  return Response.json(result, { status: 200, headers: NO_STORE });
}
