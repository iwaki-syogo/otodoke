import { readBearerSession, throwawayAuthClient } from "@/lib/auth-session";
import { changeSecret } from "@/lib/login-auth";
import { ChangeSecretInputSchema } from "@/lib/login-input";
import { restoreKeyWrap } from "@/lib/mail-keys";

const NO_STORE = { "Cache-Control": "no-store" };
function failure(code: string, status: number): Response {
  return Response.json({ ok: false, code }, { status, headers: NO_STORE });
}

/** Same password, wrap/restore and login-attempt checks as the Web's changeLoginSecret action. */
export async function POST(request: Request): Promise<Response> {
  const session = await readBearerSession(request.headers.get("authorization"));
  if (session.state === "unknown") return failure("unavailable", 503);
  if (session.state !== "signed_in") return failure("unauthorized", 401);
  let input: unknown;
  try {
    const text = await request.text();
    if (text.length > 16 * 1024) return failure("invalid_input", 400);
    input = JSON.parse(text);
  } catch {
    return failure("invalid_input", 400);
  }
  if (!ChangeSecretInputSchema.safeParse(input).success) return failure("invalid_input", 400);
  try {
    const result = await changeSecret(input, restoreKeyWrap, { client: throwawayAuthClient(), session });
    // Known refusals are structured outcomes, including an uncertain password change. No auto retry.
    return Response.json(result, { status: 200, headers: NO_STORE });
  } catch (thrown) {
    console.error("[account-api] change threw:", thrown instanceof Error ? thrown.name : typeof thrown);
    return failure("network", 500);
  }
}
