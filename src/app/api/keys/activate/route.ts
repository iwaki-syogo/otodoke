import { activateKey, KeyActivationSchema } from "@/lib/mail-keys";
import { scheduleSealRemaining } from "@/lib/seal-later";
import { keyStep } from "../handler";

/** Put the pending key in use with the opened challenge; answers { ok: true, keyId } (docs/api/keys.md). */
export async function POST(request: Request): Promise<Response> {
  return keyStep("activate", request, KeyActivationSchema, async (db, userId, input) => {
    const result = await activateKey(db, userId, input);
    // The mail stored before the key is sealed in the background, with no step for the user.
    if (result.ok) scheduleSealRemaining(userId, db);
    return result;
  });
}
