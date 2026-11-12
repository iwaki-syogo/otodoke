import { z } from "zod";
import { readingAllowed } from "@/lib/ai-consent";
import { runReadAfterConsent } from "@/lib/ai-consent-run";
import { readBearerSession } from "@/lib/auth-session";
import { isScreenEventId, runMarkWronglyDropped, runReadWaitingMail } from "@/lib/mail-run";
import { createAdminClient } from "@/lib/supabase/admin";
import { isIntakeNoticeTimestamp, isRememberedSenderDomain, runDismissIntakeNotice, runForgetSender } from "@/lib/settings-mail-actions";

/**
 * Settings mail operations for the iOS app, which cannot call Server Actions: share mail-run.ts
 * and settings-mail-actions.ts with settings/actions.ts. Built like src/app/api/demo/handler.ts;
 * docs/api/mail.md.
 * The daily Claude caps are in the pipeline (claim_claude_call), so they apply here as on the web.
 */

export type MailApiCode = "unauthorized" | "invalid_input" | "not_found" | "mark_failed" | "read_failed" | "forget_failed" | "dismiss_failed" | "unavailable" | "ai_consent_required";

const STATUS: Record<MailApiCode, number> = {
  unauthorized: 401,
  invalid_input: 400,
  not_found: 404,
  mark_failed: 500,
  read_failed: 500,
  forget_failed: 500,
  dismiss_failed: 500,
  unavailable: 503,
  ai_consent_required: 403,
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
const ForgetBody = z.object({ domain: z.string().refine(isRememberedSenderDomain) }).strict();
const DismissBody = z.object({ limited_at: z.string().refine(isIntakeNoticeTimestamp) }).strict();
// Preserve the server's original fractional seconds for the atomic claim; never normalize to
// a JS Date (milliseconds). There is no age cutoff: an old valid token is a harmless claim miss.
const ReadBody = z.object({ after_consent: z.iso.datetime({ offset: true }).refine((value) => {
  // PostgreSQL has no year zero and accepts numeric timezone offsets only below 16 hours.
  const offsetHour = value.match(/[+-](\d{2}):\d{2}$/)?.[1];
  return !value.startsWith("0000-") && (offsetHour === undefined || Number(offsetHour) < 16);
}).optional() }).strict();

async function caller(request: Request): Promise<{ userId: string; email: string | null } | Response> {
  const read = await readBearerSession(request.headers.get("authorization"));
  if (read.state === "unknown") return failure("unavailable");
  if (read.state !== "signed_in") return failure("unauthorized");
  return { userId: read.session.userId, email: read.session.email };
}

/** An unreadable settings request has no valid mutation input. */
async function settingsBody(request: Request): Promise<unknown> {
  try { return await body(request); } catch { return undefined; }
}

/** Removing a remembered sender neither sends mail to Claude nor needs reading permission. */
export async function forgetSenderStep(request: Request): Promise<Response> {
  const who = await caller(request);
  if (who instanceof Response) return who;
  const parsed = ForgetBody.safeParse(await settingsBody(request));
  if (!parsed.success) return failure("invalid_input");
  try {
    const done = await runForgetSender(createAdminClient(), who.userId, parsed.data.domain);
    if (!done.ok) return failure(done.code);
    return Response.json({ ok: true }, { status: 200, headers: NO_STORE });
  } catch {
    console.error("[mail-api] forget-sender failed");
    return failure("forget_failed");
  }
}

/** Dismiss exactly the notice shown, using the server timestamp unchanged. */
export async function dismissIntakeStep(request: Request): Promise<Response> {
  const who = await caller(request);
  if (who instanceof Response) return who;
  const parsed = DismissBody.safeParse(await settingsBody(request));
  if (!parsed.success) return failure("invalid_input");
  try {
    const done = await runDismissIntakeNotice(createAdminClient(), who.userId, parsed.data.limited_at);
    if (!done.ok) return failure(done.code);
    return Response.json({ ok: true }, { status: 200, headers: NO_STORE });
  } catch {
    console.error("[mail-api] dismiss-intake failed");
    return failure("dismiss_failed");
  }
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
  const requestStartedAt = Date.now();
  const who = await caller(request);
  if (who instanceof Response) return who;
  const parsed = ReadBody.safeParse(await body(request));
  if (!parsed.success) return failure("invalid_input");

  let done;
  try {
    const db = createAdminClient();
    const allowed = await readingAllowed(db, who.userId);
    if (allowed === "unknown") return failure("unavailable");
    if (allowed !== "granted") return failure("ai_consent_required");
    done = parsed.data.after_consent === undefined
      ? await runReadWaitingMail(db, who.userId)
      : await runReadAfterConsent(db, who.userId, parsed.data.after_consent, requestStartedAt);
  } catch (thrown) {
    console.error("[mail-api] read-waiting threw:", thrown instanceof Error ? thrown.name : typeof thrown);
    return failure("read_failed");
  }
  // Claude is stopped: not a failure (nothing the app can retry), so a 200 that says so.
  if (done.unavailable) {
    const busy = !done.ok && done.stage === "read" && done.onlyBusy;
    return Response.json({ ok: true, read: done.read, over_limit: done.overLimit, busy, stopped: true }, { status: 200, headers: NO_STORE });
  }
  if (!done.ok) {
    // Only another read holding the same mail: not a failure, the other read finishes it.
    if (done.stage === "read" && done.onlyBusy) {
      return Response.json({ ok: true, read: done.read, over_limit: done.overLimit, busy: true, stopped: false }, { status: 200, headers: NO_STORE });
    }
    console.error("[mail-api] read-waiting failed at:", done.stage);
    return Response.json({ ok: false, code: "read_failed", read: done.read }, { status: STATUS.read_failed, headers: NO_STORE });
  }
  return Response.json({ ok: true, read: done.read, over_limit: done.overLimit, busy: false, stopped: false }, { status: 200, headers: NO_STORE });
}
