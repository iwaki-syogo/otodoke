"use server";

import { getUser } from "@/lib/supabase/server";

/**
 * The signed-in user's id and address, as Supabase Auth keeps the address. A sign-in reads it right
 * before it makes a user's first key, and before 「ほかのパスワードで開く」 wraps the key again
 * (src/lib/crypto/password-flows.ts): those wraps are made from the address as typed, and every
 * later step (opening it again, a change, a reset) from this one, so the two must be the same for
 * password-v1; and the key wrapped is this user's. Nothing secret goes either way.
 */
export async function readSignedInAddress(): Promise<{ ok: true; userId: string; email: string } | { ok: false }> {
  const user = await getUser();
  return user?.email ? { ok: true, userId: user.id, email: user.email } : { ok: false };
}
