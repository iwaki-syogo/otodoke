import { activateKey, KeyActivationSchema } from "@/lib/mail-keys";
import { keyStep } from "../handler";

/** Put the pending key in use with the opened challenge; answers { ok: true, keyId } (docs/api/keys.md). */
export async function POST(request: Request): Promise<Response> {
  return keyStep("activate", request, KeyActivationSchema, activateKey);
}
