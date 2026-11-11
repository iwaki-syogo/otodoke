import { z } from "zod";
import { ACCOUNT_DELETE_CONFIRM, deleteAuthUser } from "@/lib/account-deletion";
import { readBearerSession } from "@/lib/auth-session";
import { createAdminClient } from "@/lib/supabase/admin";

type Code = "unauthorized" | "invalid_input" | "delete_failed" | "unavailable";
const STATUS: Record<Code, number> = { unauthorized: 401, invalid_input: 400, delete_failed: 500, unavailable: 503 };
const NO_STORE = { "Cache-Control": "no-store" };
const Input = z.object({ confirm: z.literal(ACCOUNT_DELETE_CONFIRM.value) }).strict();

function failure(code: Code): Response {
  return Response.json({ ok: false, code }, { status: STATUS[code], headers: NO_STORE });
}

/** Same verified owner, explicit confirmation and deletion function as the Web action. */
export async function POST(request: Request): Promise<Response> {
  const read = await readBearerSession(request.headers.get("authorization"));
  if (read.state === "unknown") return failure("unavailable");
  if (read.state !== "signed_in") return failure("unauthorized");
  let input: unknown;
  try {
    const text = await request.text();
    if (text.length > 1024) return failure("invalid_input");
    input = JSON.parse(text);
  } catch {
    return failure("invalid_input");
  }
  if (!Input.safeParse(input).success) return failure("invalid_input");

  try {
    const outcome = await deleteAuthUser(createAdminClient(), read.session.userId);
    if (!outcome.ok) {
      console.error("[account-api] delete failed");
      return failure("delete_failed");
    }
  } catch (thrown) {
    console.error("[account-api] delete threw:", thrown instanceof Error ? thrown.name : typeof thrown);
    return failure("delete_failed");
  }
  return Response.json({ ok: true }, { status: 200, headers: NO_STORE });
}
