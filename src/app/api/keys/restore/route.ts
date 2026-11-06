import { restoreWrapByRewrap } from "@/lib/login-auth";
import { KeyWrapRestoreSchema } from "@/lib/login-input";
import { keyStep } from "../handler";

/**
 * Put back the wrap from before a rewrap, after the password change it belonged to was refused;
 * answers { ok: true, keyId } (docs/api/keys.md).
 *
 * On integrate/password-v1 this is keyStep("restore", request, KeyRestoreSchema, restoreKeyWrap)
 * from src/lib/mail-keys.ts (the same fields; it also answers ok when the wrap is back already).
 */
export async function POST(request: Request): Promise<Response> {
  return keyStep("restore", request, KeyWrapRestoreSchema, restoreWrapByRewrap);
}
