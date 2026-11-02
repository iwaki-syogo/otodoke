import { z } from "zod";

/**
 * Environment access for server code. Values are read lazily so that a missing
 * optional key (e.g. RESEND_API_KEY during local UI work) does not break builds;
 * `requireEnv` throws a clear error at the point of use instead.
 */
const schema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1).optional(),
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  RESEND_API_KEY: z.string().min(1).optional(),
  RESEND_WEBHOOK_SECRET: z.string().min(1).optional(),
  INBOUND_DOMAIN: z.string().min(1).optional(),
  NEXT_PUBLIC_APP_URL: z.url().default("http://localhost:3015"),
  /** Claude model used for email understanding. */
  OTODOKE_MODEL: z.string().default("claude-opus-5-5"),
  /** Effort for extraction calls: low | medium | high. */
  OTODOKE_EXTRACT_EFFORT: z.enum(["low", "medium", "high"]).default("medium"),
});

export type Env = z.infer<typeof schema>;

let cached: Env | null = null;

export function env(): Env {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const missing = parsed.error.issues.map((i) => i.path.join(".")).join(", ");
    throw new Error(`Invalid environment: ${missing}`);
  }
  cached = parsed.data;
  return cached;
}

type OptionalKeys = {
  [K in keyof Env]-?: undefined extends Env[K] ? K : never;
}[keyof Env];

/** Read an optional key and throw a readable error when it is not configured. */
export function requireEnv(key: OptionalKeys): string {
  const value = env()[key];
  if (!value) {
    throw new Error(`${key} is not set. Add it to the local env file (see .env.example) or to the Vercel project settings.`);
  }
  return value;
}
