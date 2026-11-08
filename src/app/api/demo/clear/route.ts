import { clearDemoStep } from "../handler";

/** Remove all of the user's parcels and mails; answers { ok: true } (docs/api/demo.md). */
export async function POST(request: Request): Promise<Response> {
  return clearDemoStep(request);
}
