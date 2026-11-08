import { NextResponse } from "next/server";
import { Resend } from "resend";
import { createAdminClient, type AdminClient } from "@/lib/supabase/admin";
import { requireEnv } from "@/lib/env";
import { processInboundEmail } from "@/lib/pipeline";
import { scheduleSealRemaining } from "@/lib/seal-later";

/**
 * Resend `email.received` webhook. The event carries metadata only, so the body is
 * fetched with the Received Emails API, then routed to the user who owns the
 * receiving address and processed. Always answers 200 for mail we deliberately
 * ignore (unknown address) so Resend does not retry it.
 *
 * When the event names the envelope recipients (`received_for`), the address is looked up
 * before the fetch: a mail for an address nobody has (a deleted account's, a made-up one) is
 * not fetched at all. The fetched mail still decides where a mail goes; an event without
 * them is fetched first, as before.
 */
// One mail means one Claude call; leave room for a slow response.
export const maxDuration = 120;

/** Far beyond any real order mail. Anyone can send to an inbox address, so storage needs a ceiling. */
const MAX_BODY_CHARS = 512 * 1024;

export async function POST(request: Request) {
  const payload = await request.text();
  const resend = new Resend(requireEnv("RESEND_API_KEY"));

  let event;
  try {
    event = resend.webhooks.verify({
      payload,
      headers: {
        id: request.headers.get("svix-id") ?? "",
        timestamp: request.headers.get("svix-timestamp") ?? "",
        signature: request.headers.get("svix-signature") ?? "",
      },
      webhookSecret: requireEnv("RESEND_WEBHOOK_SECRET"),
    });
  } catch (err) {
    console.warn("inbound: signature verification failed", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "invalid signature" }, { status: 400 });
  }

  if (event.type !== "email.received") {
    return NextResponse.json({ ignored: event.type });
  }
  const data = event.data as { email_id?: string; received_for?: unknown; to?: unknown };
  const emailId = data.email_id;
  if (!emailId) return NextResponse.json({ error: "missing email_id" }, { status: 400 });

  const domain = requireEnv("INBOUND_DOMAIN").toLowerCase();
  // Made when first needed, as before: a mail that never reaches a lookup does not need it.
  let db: AdminClient | undefined;
  const admin = () => (db ??= createAdminClient());
  // The same rule as for the fetched mail below, on the event's own lists.
  const announced = Array.isArray(data.received_for) ? localPartFor([...stringsOf(data.received_for), ...stringsOf(data.to)], domain) : undefined;
  let checked: { localPart: string; userId: string } | null = null;
  if (announced) {
    const found = await findInbox(admin(), announced);
    if (found === "failed") return NextResponse.json({ error: "lookup failed" }, { status: 500 });
    if (!found) return unknownInbox();
    checked = { localPart: announced, userId: found.user_id };
  }

  const { data: mail, error } = await resend.emails.receiving.get(emailId);
  if (error || !mail) {
    console.error("inbound: receiving.get failed", errorSummary(error));
    return NextResponse.json({ error: "fetch failed" }, { status: 502 });
  }

  const recipients = [...(mail.received_for ?? []), ...(mail.to ?? [])];
  const localPart = localPartFor(recipients, domain);
  if (!localPart) {
    // Addresses are not logged: a count is enough to tell this case apart.
    const addressCount = recipients.length;
    console.warn("inbound: no recipient on our domain; addresses:", addressCount);
    return NextResponse.json({ ignored: "no matching recipient" });
  }

  let userId: string;
  if (checked?.localPart === localPart) {
    userId = checked.userId;
  } else {
    const found = await findInbox(admin(), localPart);
    if (found === "failed") return NextResponse.json({ error: "lookup failed" }, { status: 500 });
    if (!found) return unknownInbox();
    userId = found.user_id;
  }

  const fromHeader = mail.headers?.from ?? mail.headers?.From ?? mail.from;
  const fromName = parseDisplayName(fromHeader);
  const sentAt = parseDate(mail.headers?.date ?? mail.headers?.Date) ?? mail.created_at ?? null;

  try {
    const outcome = await processInboundEmail(admin(), {
      userId,
      providerEmailId: mail.id,
      messageId: mail.message_id ?? null,
      from: mail.from,
      fromName,
      subject: mail.subject ?? "",
      sentAt,
      text: mail.text?.slice(0, MAX_BODY_CHARS) ?? null,
      html: mail.html?.slice(0, MAX_BODY_CHARS) ?? null,
    });
    // Once per inbound request: the rest of this user's plaintext mail is sealed after the answer.
    scheduleSealRemaining(userId, admin());
    return NextResponse.json({ ok: true, outcome: outcome.kind });
  } catch (err) {
    // The message and code only: an error object can carry the request or the mail with it.
    console.error("inbound: processing failed", errorSummary(err));
    // 500 makes Resend retry later, which is what we want for transient failures.
    return NextResponse.json({ error: "processing failed" }, { status: 500 });
  }
}

/** The local part a mail is for: the first address on our domain, lower case, without its +tag. */
function localPartFor(addresses: readonly string[], domain: string): string | undefined {
  return addresses
    .map((addr) => addr.toLowerCase().match(/^([^@<>\s]+)@([^>\s]+)$/))
    .filter((m): m is RegExpMatchArray => !!m && m[2] === domain)
    .map((m) => m[1].split("+")[0])[0];
}

function stringsOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/** The owner of a receiving address; "failed" when the lookup itself failed (never taken as none). */
async function findInbox(db: AdminClient, localPart: string): Promise<{ user_id: string } | null | "failed"> {
  const { data, error } = await db.from("inbox_addresses").select("user_id").eq("local_part", localPart).maybeSingle();
  if (error) {
    // Not the same as "no such address": answering 200 here would lose the mail.
    console.error("inbound: inbox lookup failed", error.message);
    return "failed";
  }
  return data;
}

/** Mail for an address nobody has: 200, so Resend does not send it again. The address is not logged. */
function unknownInbox() {
  console.warn("inbound: unknown inbox");
  return NextResponse.json({ ignored: "unknown inbox" });
}

/** What is safe to log about an error: its message and code, never the object itself. */
function errorSummary(err: unknown): string {
  if (!err || typeof err !== "object") return String(err);
  const { message, code, name } = err as { message?: unknown; code?: unknown; name?: unknown };
  const label = typeof code === "string" || typeof code === "number" ? String(code) : typeof name === "string" ? name : "error";
  return `${label}: ${typeof message === "string" ? message : "(no message)"}`;
}

function parseDisplayName(fromHeader: string | undefined): string | null {
  if (!fromHeader) return null;
  const m = fromHeader.match(/^\s*"?([^"<]+?)"?\s*<[^>]+>\s*$/);
  return m ? m[1].trim() : null;
}

function parseDate(value: string | undefined): string | null {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  // The Date header is written by the sender: a future date must not sort above everything else.
  return new Date(Math.min(d.getTime(), Date.now())).toISOString();
}

export const dynamic = "force-dynamic";
