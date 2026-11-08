import { readWaitingStep } from "../handler";

/** Up to 20 mails are read with Claude one by one; as long as the trouble page's action. */
export const maxDuration = 300;

/** Read the waiting mail; answers { ok: true, read, over_limit } (docs/api/mail.md). */
export async function POST(request: Request): Promise<Response> {
  return readWaitingStep(request);
}
