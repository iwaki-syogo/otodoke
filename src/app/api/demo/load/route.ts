import { loadDemoStep } from "../handler";

/** The 97 sample mails go through the pipeline one by one; as long as the settings page's action. */
export const maxDuration = 300;

/** Load the sample; answers { ok: true, processed, busy } (docs/api/demo.md). */
export async function POST(request: Request): Promise<Response> {
  return loadDemoStep(request);
}
