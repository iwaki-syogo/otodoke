"use server";

import { changeSecret, signIn } from "@/lib/login-auth";
import type { ChangeSecretResult, SignInResult } from "@/lib/login-errors";
import type { ChangeSecretInput, SignInInput } from "@/lib/login-input";
import { restoreKeyWrap } from "@/lib/mail-keys";
import { createClient } from "@/lib/supabase/server";
import { readCookieSession } from "@/lib/auth-session";
import { KEY_SETTINGS_PATH, requireDisplayedUser } from "@/lib/action-identity";

/**
 * 設定: change the password while the current one is known. The key in use is wrapped again for
 * the new one in the same call, and put back when Supabase refuses the new login secret, so a tab
 * closed half-way never leaves a key that opens with a password that does not sign in. The steps:
 * src/lib/login-auth.ts changeSecret; the wrap goes back with restoreKeyWrap of src/lib/mail-keys.ts.
 */
export async function changeLoginSecret(input: ChangeSecretInput, expectedUserId?: string): Promise<ChangeSecretResult> {
  const current = await readCookieSession(await createClient());
  if (current.state !== "signed_in") return { ok: false, code: current.state === "unknown" ? "network" : "signed_out" };
  requireDisplayedUser({ id: current.session.userId }, expectedUserId, KEY_SETTINGS_PATH);
  return changeSecret(input, restoreKeyWrap);
}

/** Settings is a confirmation of the displayed account, unlike the public account-switch login. */
export async function signInForKey(input: SignInInput, expectedUserId?: string): Promise<SignInResult> {
  const current = await readCookieSession(await createClient());
  if (current.state === "unknown") return { ok: false, code: "network" };
  const user = current.state === "signed_in" ? { id: current.session.userId } : null;
  requireDisplayedUser(user, expectedUserId, KEY_SETTINGS_PATH);
  return signIn(input);
}
