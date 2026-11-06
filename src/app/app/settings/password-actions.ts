"use server";

import { changeSecret } from "@/lib/login-auth";
import type { ChangeSecretResult } from "@/lib/login-errors";
import type { ChangeSecretInput } from "@/lib/login-input";
import { restoreKeyWrap } from "@/lib/mail-keys";

/**
 * 設定: change the password while the current one is known. The key in use is wrapped again for
 * the new one in the same call, and put back when Supabase refuses the new login secret, so a tab
 * closed half-way never leaves a key that opens with a password that does not sign in. The steps:
 * src/lib/login-auth.ts changeSecret; the wrap goes back with restoreKeyWrap of src/lib/mail-keys.ts.
 */
export async function changeLoginSecret(input: ChangeSecretInput): Promise<ChangeSecretResult> {
  return changeSecret(input, restoreKeyWrap);
}
