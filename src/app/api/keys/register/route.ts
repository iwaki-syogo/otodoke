import { KeyRegistrationSchema, registerKey } from "@/lib/mail-keys";
import { keyStep } from "../handler";

/** Store a new key as pending; answers { ok: true, keyId, challenge } (docs/api/keys.md). */
export async function POST(request: Request): Promise<Response> {
  return keyStep("register", request, KeyRegistrationSchema, registerKey);
}
