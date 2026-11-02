import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/db/database.types";
import { env } from "@/lib/env";

const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"; // no 0/o/1/l/i to keep it readable

function randomLocalPart(length = 10): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let s = "";
  for (const b of bytes) s += ALPHABET[b % ALPHABET.length];
  return s;
}

/** The user's forwarding address, created on first use. Idempotent (one address per user). */
export async function ensureInboxAddress(supabase: SupabaseClient<Database>, userId: string): Promise<string> {
  const { data: existing } = await supabase.from("inbox_addresses").select("local_part").eq("user_id", userId).maybeSingle();
  if (existing) return existing.local_part;

  // Retry a couple of times in the unlikely event of a local_part collision.
  for (let attempt = 0; attempt < 3; attempt++) {
    const localPart = randomLocalPart();
    const { error } = await supabase.from("inbox_addresses").insert({ user_id: userId, local_part: localPart });
    if (!error) return localPart;
    if (error.code === "23505") {
      // Unique violation: either our user already has one (race) or the local_part is taken.
      const { data } = await supabase.from("inbox_addresses").select("local_part").eq("user_id", userId).maybeSingle();
      if (data) return data.local_part;
      continue;
    }
    throw new Error(`inbox_addresses insert failed: ${error.message}`);
  }
  throw new Error("could not allocate an inbox address");
}

/** Full address shown to the user, or null when the inbound domain is not configured yet. */
export function inboxEmail(localPart: string): string | null {
  const domain = env().INBOUND_DOMAIN;
  return domain ? `${localPart}@${domain}` : null;
}
