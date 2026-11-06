import { KeyRestoreSchema, restoreKeyWrap } from "@/lib/mail-keys";
import { keyStep } from "../handler";

/**
 * Put back the wrap from before a rewrap, after the password change it belonged to was refused;
 * answers { ok: true, keyId }, also when that wrap is back already (docs/api/keys.md).
 */
export async function POST(request: Request): Promise<Response> {
  return keyStep("restore", request, KeyRestoreSchema, restoreKeyWrap);
}
