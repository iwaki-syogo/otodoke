/**
 * Sealing stored mail on the server. The server holds only public keys: it can seal a mail to
 * its owner but never open one again. What a read mail keeps in plaintext is decided here.
 *
 *   sealed   the user has a key in use: subject, sender and body go into one envelope
 *   dropped  no key yet, a real mail: none of the five is kept (the parcel data still is)
 *   plain    no key yet, a public sample mail (anonymized fixtures from the repository)
 *
 * Never log what passes through here (src/lib/__tests__/no-mail-in-logs.test.ts).
 */
import { fromBase64 } from "@/lib/crypto/bytes";
import { keyIdOf, sealMail, type MailPlaintext, type PublicRecipient } from "@/lib/crypto/envelope";
import type { Json, TablesUpdate } from "@/lib/db/database.types";
import type { AdminClient } from "@/lib/supabase/admin";

/** The key mail is sealed to now, or null when the user has none yet. Throws when it cannot tell. */
export async function currentSealKey(db: AdminClient, userId: string): Promise<PublicRecipient | null> {
  const { data, error } = await db
    .from("user_keys")
    .select("key_id, public_key")
    .eq("user_id", userId)
    .not("activated_at", "is", null)
    .is("retired_at", null)
    .maybeSingle();
  // Not knowing whether there is a key must not turn into "no key": that would drop the mail.
  if (error) throw new Error(`user_keys lookup failed: ${error.message}`);
  if (!data) return null;
  const publicKey = fromBase64(data.public_key);
  if ((await keyIdOf(publicKey)) !== data.key_id) throw new Error("user_keys: key id does not match the public key");
  return { keyId: data.key_id, publicKey };
}

/** The plaintext columns a sealed or dropped row must not keep. */
export const CLEARED = { subject: null, from_name: null, from_address: null, text_body: null, html_body: null } as const;

export type ClosedBody = Pick<TablesUpdate<"emails">, "body_state" | "body_envelope" | "subject" | "from_name" | "from_address" | "text_body" | "html_body">;

/**
 * The columns that close a read mail: written in the same UPDATE that marks it processed.
 * `publicSample` is the demo loader's anonymized mail, kept readable while there is no key.
 */
export async function closedBody(key: PublicRecipient | null, userId: string, emailId: string, mail: MailPlaintext, publicSample: boolean): Promise<ClosedBody> {
  if (key) return { ...CLEARED, body_state: "sealed", body_envelope: (await sealMail(key, userId, emailId, mail)) as unknown as Json };
  if (publicSample) return {};
  return { ...CLEARED, body_state: "dropped", body_envelope: null };
}

export function domainOf(address: string | null | undefined): string | null {
  return address?.split("@")[1]?.trim().toLowerCase() || null;
}
