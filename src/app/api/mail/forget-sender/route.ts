import { forgetSenderStep } from "../handler";

/** Forget only the verified user's sender domain; no Claude call or reading permission needed. */
export async function POST(request: Request): Promise<Response> {
  return forgetSenderStep(request);
}
