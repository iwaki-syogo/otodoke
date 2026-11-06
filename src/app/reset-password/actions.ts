"use server";

import { finishReset as finish } from "@/lib/login-auth";
import type { FinishResetResult } from "@/lib/login-errors";
import type { FinishResetInput } from "@/lib/login-input";

/**
 * The end of a reset, on the session the reset link made: the new login secret, then the key the
 * browser registered for it put in use (the old key is retired; mail sealed to it no longer opens).
 * Safe to call again when only the activation failed. The steps: src/lib/login-auth.ts finishReset.
 */
export async function finishReset(input: FinishResetInput): Promise<FinishResetResult> {
  return finish(input);
}
