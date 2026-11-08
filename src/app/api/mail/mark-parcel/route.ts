import { markParcelStep } from "../handler";

/** Remember a wrongly dropped mail's sender; answers { ok: true, outcome } (docs/api/mail.md). */
export async function POST(request: Request): Promise<Response> {
  return markParcelStep(request);
}
