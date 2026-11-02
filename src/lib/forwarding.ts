/**
 * Gmail's forwarding confirmation. The settings page turns its link into a button, so
 * anyone who knows an inbox address could otherwise plant a link there. The sender alone
 * proves nothing (it can be forged), so the link itself must also point at Google's page.
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
