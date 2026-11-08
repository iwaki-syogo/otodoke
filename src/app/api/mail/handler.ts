import { z } from "zod";
import { readBearerSession } from "@/lib/auth-session";
import { isScreenEventId, runMarkWronglyDropped, runReadWaitingMail } from "@/lib/mail-run";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * "This dropped mail was a parcel" and "read the waiting mail" for the iOS app, which cannot call
 * Server Actions: the same functions (src/lib/mail-run.ts) as markWronglyDropped and readWaitingMail
 * in settings/actions.ts. Built like src/app/api/demo/handler.ts; docs/api/mail.md.
 * The daily Claude caps are in the pipeline (claim_claude_call), so they apply here as on the web.
 */

export type MailApiCode = "unauthorized" | "invalid_input" | "not_found" | "mark_failed" | "read_failed" | "unavailable";

const STATUS: Record<MailApiCode, number> = {
  unauthorized: 401,
  invalid_input: 400,
  not_found: 404,
  mark_failed: 500,
  read_failed: 500,
  unavailable: 503,
};

/** The largest body taken; the real ones are a few bytes. */
const MAX_BODY = 1024;

const NO_STORE = { "Cache-Control": "no-store" };

export function failure(code: MailApiCode): Response {
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

const MarkBody = z.object({ id: z.string().refine(isScreenEventId) }).strict();
const ReadBody = z.object({}).strict();

async function caller(request: Request): Promise<{ userId: string; email: string | null } | Response> {
  const read = await readBearerSession(request.headers.get("authorization"));
  if (read.state === "unknown") return failure("unavailable");
  if (read.state !== "signed_in") return failure("unauthorized");
  return { userId: read.session.userId, email: read.session.email };
}

export async function markParcelStep(request: Request): Promise<Response> {
  const who = await caller(request);
  if (who instanceof Response) return who;
  const parsed = MarkBody.safeParse(await body(request));
  if (!parsed.success) return failure("invalid_input");

  let marked;
  try {
    marked = await runMarkWronglyDropped(createAdminClient(), who.userId, who.email, parsed.data.id);
  } catch (thrown) {
    console.error("[mail-api] mark-parcel threw:", thrown instanceof Error ? thrown.name : typeof thrown);
    return failure("mark_failed");
  }
  if (marked.ok) return Response.json({ ok: true, outcome: marked.outcome }, { status: 200, headers: NO_STORE });
  if (marked.code === "not_found") return failure("not_found");
  // The database's text stays out of the log too: the code names the step.
  console.error("[mail-api] mark-parcel failed:", marked.code);
  return failure("mark_failed");
}

export async function readWaitingStep(request: Request): Promise<Response> {
  const who = await caller(request);
  if (who instanceof Response) return who;
  if (!ReadBody.safeParse(await body(request)).success) return failure("invalid_input");

  let done;
  try {
    done = await runReadWaitingMail(createAdminClient(), who.userId);
  } catch (thrown) {
    console.error("[mail-api] read-waiting threw:", thrown instanceof Error ? thrown.name : typeof thrown);
    return failure("read_failed");
  }
  if (!done.ok) {
    console.error("[mail-api] read-waiting failed at:", done.stage);
    return failure("read_failed");
  }
  return Response.json({ ok: true, read: done.read, over_limit: done.overLimit }, { status: 200, headers: NO_STORE });
}
