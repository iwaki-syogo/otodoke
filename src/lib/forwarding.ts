/**
 * Gmail's forwarding confirmation. The settings page turns its link into a button, so
 * anyone who knows an inbox address could otherwise plant a link there. The sender alone
 * proves nothing (it can be forged), so the link itself must also point at Google's page,
 * and a mail whose sender the receiving server found forged (senderFailedDmarc) is not one.
 */
export function isForwardingConfirmation(from: string): boolean {
  return from.trim().toLowerCase() === "forwarding-noreply@google.com";
}

export function forwardingConfirmUrl(body: string): string | null {
  for (const candidate of body.match(/https:\/\/[^\s<>"')]+/g) ?? []) {
    try {
      const url = new URL(candidate);
      if (url.hostname === "mail-settings.google.com" && url.pathname.startsWith("/mail/")) return candidate;
    } catch {
      // Not a URL after all: keep looking.
    }
  }
  return null;
}

/**
 * Whether the receiving server found the sender forged: Resend's Received Emails API gives the
 * SPF, DKIM and DMARC results it computed on arrival as `authentication` ("pass", "fail", "gray",
 * "processing_failed" or "unknown"; null for older mail; https://resend.com/docs/api-reference/emails/retrieve-received-email).
 * The headers of the mail cannot set them. Only a DMARC "fail" counts: Google publishes a policy
 * that tells receivers to reject that mail, and a real confirmation, sent straight from Google to
 * the inbox address, passes. Anything else (no field, null, gray, a failed or unknown check, a value
 * this code does not know) is not a failure, and the mail is judged as before.
 */
export function senderFailedDmarc(authentication: unknown): boolean {
  if (!authentication || typeof authentication !== "object") return false;
  const dmarc = (authentication as { dmarc?: unknown }).dmarc;
  return typeof dmarc === "string" && dmarc.trim().toLowerCase() === "fail";
}
