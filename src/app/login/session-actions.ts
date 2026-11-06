"use server";

import { getUser } from "@/lib/supabase/server";

/**
 * The signed-in user's id and address, as Supabase Auth keeps the address. /login reads it once,
 * right before it makes a user's first key (src/lib/crypto/password-flows.ts): that key is made
 * from the address as typed, and every later step (opening it again, a change, a reset) from this
 * one, so the two must be the same for password-v1. Nothing secret goes either way.
 */
export async function readSignedInAddress(): Promise<{ ok: true; userId: string; email: string } | { ok: false }> {
  const user = await getUser();
  return user?.email ? { ok: true, userId: user.id, email: user.email } : { ok: false };
}
