import { dismissIntakeStep } from "../handler";

/** Acknowledge the original notice timestamp, retaining any newer storage rejection. */
export async function POST(request: Request): Promise<Response> {
  return dismissIntakeStep(request);
}
