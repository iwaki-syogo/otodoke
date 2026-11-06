"use server";

import { changeSecret, restoreWrapByRewrap } from "@/lib/login-auth";
import type { ChangeSecretResult } from "@/lib/login-errors";
import type { ChangeSecretInput } from "@/lib/login-input";

/**
 * 設定: change the password while the current one is known. The key in use is wrapped again for
 * the new one in the same call, and put back when Supabase refuses the new login secret, so a tab
 * closed half-way never leaves a key that opens with a password that does not sign in. The steps:
 * src/lib/login-auth.ts changeSecret.
 */
export async function changeLoginSecret(input: ChangeSecretInput): Promise<ChangeSecretResult> {
  // On integrate/password-v1 this is changeSecret(input, restoreKeyWrap), restoreKeyWrap from @/lib/mail-keys.
  return changeSecret(input, restoreWrapByRewrap);
}
