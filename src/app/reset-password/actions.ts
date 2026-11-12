"use server";

import { finishReset as finish } from "@/lib/login-auth";
import type { FinishResetResult } from "@/lib/login-errors";
import type { FinishResetInput } from "@/lib/login-input";
import { createClient } from "@/lib/supabase/server";
import { readCookieSession } from "@/lib/auth-session";
import { KEY_SETTINGS_PATH, requireDisplayedUser } from "@/lib/action-identity";

/**
 * The end of a reset, on the session the reset link made: the new login secret, then the key the
 * browser registered for it put in use (the old key is retired; mail sealed to it no longer opens).
 * Safe to call again when only the activation failed. The steps: src/lib/login-auth.ts finishReset.
 */
export async function finishReset(input: FinishResetInput): Promise<FinishResetResult> {
  const current = await readCookieSession(await createClient());
  if (current.state === "signed_in") requireDisplayedUser({ id: current.session.userId }, input?.expectedUserId, KEY_SETTINGS_PATH);
  // The shared reset keeps its input validation and signed-out/network answers on a failed read.
  return finish(input);
}
