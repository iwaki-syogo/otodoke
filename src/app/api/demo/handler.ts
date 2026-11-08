import { z } from "zod";
import { readBearerSession } from "@/lib/auth-session";
import { runClearAllParcels, runLoadDemo } from "@/lib/demo-run";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * The sample load and the reset for the iOS app, which cannot call Server Actions: the same
 * functions (src/lib/demo-run.ts) as loadDemo and clearAllParcels in settings/actions.ts.
 *
 * - POST only (Next.js answers 405 otherwise), JSON in and out, no CORS (a native app).
 * - `Authorization: Bearer <Supabase access token>`, checked by Supabase Auth (getUser(token)).
 *   No freshness: these are not key operations, any valid session may call.
 * - The answer: 200 { ok: true, ... } or { ok: false, code } with the status below. docs/api/demo.md.
 */

export type DemoApiCode = "unauthorized" | "invalid_input" | "clear_confirm" | "demo_failed" | "clear_failed" | "unavailable";

const STATUS: Record<DemoApiCode, number> = {
  unauthorized: 401,
  invalid_input: 400,
  clear_confirm: 400,
  demo_failed: 500,
  clear_failed: 500,
  unavailable: 503,
};

/** The largest body taken; the real ones are a few bytes. */
const MAX_BODY = 1024;

const NO_STORE = { "Cache-Control": "no-store" };

export function failure(code: DemoApiCode): Response {
  return Response.json({ ok: false, code }, { status: STATUS[code], headers: NO_STORE });
}

/** The body as JSON; "" is `{}`; undefined when it is not JSON or too long. */
async function body(request: Request): Promise<unknown> {
  const text = await request.text();
  if (text.length > MAX_BODY) return undefined;
  if (text.trim() === "") return {};
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

const LoadBody = z.object({}).strict();
const ClearBody = z.object({ confirm: z.unknown().optional() }).strict();

/** The user of the Bearer token, or the failure to answer. */
async function caller(request: Request): Promise<{ userId: string } | Response> {
  const read = await readBearerSession(request.headers.get("authorization"));
  if (read.state === "unknown") return failure("unavailable");
  if (read.state !== "signed_in") return failure("unauthorized");
  return { userId: read.session.userId };
}

export async function loadDemoStep(request: Request): Promise<Response> {
  const who = await caller(request);
  if (who instanceof Response) return who;
  if (!LoadBody.safeParse(await body(request)).success) return failure("invalid_input");

  const loaded = await runLoadDemo(createAdminClient, who.userId);
  if (!loaded.ok) {
    // The error name only (the message can carry a database text); the app gets the code.
    console.error("[demo-api] load failed:", loaded.name);
    return failure("demo_failed");
  }
  return Response.json({ ok: true, processed: loaded.processed, busy: loaded.busy }, { status: 200, headers: NO_STORE });
}

export async function clearDemoStep(request: Request): Promise<Response> {
  const who = await caller(request);
  if (who instanceof Response) return who;
  const parsed = ClearBody.safeParse(await body(request));
  if (!parsed.success) return failure("invalid_input");
  if (parsed.data.confirm !== "yes") return failure("clear_confirm");

  let message: string | null;
  try {
    message = await runClearAllParcels(createAdminClient(), who.userId);
  } catch (thrown) {
    message = thrown instanceof Error ? thrown.name : String(thrown);
  }
  if (message) {
    console.error("[demo-api] clear failed:", message);
    return failure("clear_failed");
  }
  return Response.json({ ok: true }, { status: 200, headers: NO_STORE });
}
