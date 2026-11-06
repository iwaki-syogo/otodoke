import { KeyRewrapSchema, rewrapKey } from "@/lib/mail-keys";
import { keyStep } from "../handler";

/** Store a new wrap of the key in use, over the one the app opened; answers { ok: true, keyId } (docs/api/keys.md). */
export async function POST(request: Request): Promise<Response> {
  return keyStep("rewrap", request, KeyRewrapSchema, rewrapKey);
}
