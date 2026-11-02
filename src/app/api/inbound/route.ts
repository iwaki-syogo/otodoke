import { NextResponse } from "next/server";
import { Resend } from "resend";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireEnv } from "@/lib/env";
import { processInboundEmail } from "@/lib/pipeline";

/**
 * Resend `email.received` webhook. The event carries metadata only, so the body is
 * fetched with the Received Emails API, then routed to the user who owns the
 * receiving address and processed. Always answers 200 for mail we deliberately
 * ignore (unknown address) so Resend does not retry it.
 */
// One mail means one Claude call; leave room for a slow response.
export const maxDuration = 120;

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
  const emailId = (event.data as { email_id?: string }).email_id;
  if (!emailId) return NextResponse.json({ error: "missing email_id" }, { status: 400 });

  const { data: mail, error } = await resend.emails.receiving.get(emailId);
  if (error || !mail) {
    console.error("inbound: receiving.get failed", error);
    return NextResponse.json({ error: "fetch failed" }, { status: 502 });
  }

  const domain = requireEnv("INBOUND_DOMAIN").toLowerCase();
  const recipients = [...(mail.received_for ?? []), ...(mail.to ?? [])].map((a) => a.toLowerCase());
  const localPart = recipients
    .map((addr) => addr.match(/^([^@<>\s]+)@([^>\s]+)$/))
    .filter((m): m is RegExpMatchArray => !!m && m[2] === domain)
    .map((m) => m[1].split("+")[0])[0];
  if (!localPart) {
    console.warn("inbound: no recipient on our domain", recipients);
    return NextResponse.json({ ignored: "no matching recipient" });
  }

  const db = createAdminClient();
  const { data: inbox } = await db.from("inbox_addresses").select("user_id").eq("local_part", localPart).maybeSingle();
  if (!inbox) {
    console.warn("inbound: unknown inbox", localPart);
    return NextResponse.json({ ignored: "unknown inbox" });
  }

  const fromHeader = mail.headers?.from ?? mail.headers?.From ?? mail.from;
  const fromName = parseDisplayName(fromHeader);
  const sentAt = parseDate(mail.headers?.date ?? mail.headers?.Date) ?? mail.created_at ?? null;

  try {
    const outcome = await processInboundEmail(db, {
      userId: inbox.user_id,
      providerEmailId: mail.id,
      messageId: mail.message_id ?? null,
      from: mail.from,
      fromName,
      subject: mail.subject ?? "",
      sentAt,
      text: mail.text,
      html: mail.html,
    });
    return NextResponse.json({ ok: true, outcome: outcome.kind });
  } catch (err) {
    console.error("inbound: processing failed", err);
    // 500 makes Resend retry later, which is what we want for transient failures.
    return NextResponse.json({ error: "processing failed" }, { status: 500 });
  }
}

function parseDisplayName(fromHeader: string | undefined): string | null {
  if (!fromHeader) return null;
  const m = fromHeader.match(/^\s*"?([^"<]+?)"?\s*<[^>]+>\s*$/);
  return m ? m[1].trim() : null;
}

function parseDate(value: string | undefined): string | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export const dynamic = "force-dynamic";
