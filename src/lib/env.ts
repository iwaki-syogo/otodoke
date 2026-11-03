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
  /** The app's own origin. Read it through `appUrl()`, which picks the right one per deployment. */
  NEXT_PUBLIC_APP_URL: z.url().optional(),
  /** Set by Vercel: production | preview | development. Absent on a developer machine. */
  VERCEL_ENV: z.string().min(1).optional(),
  /** Set by Vercel: the Git branch URL without the scheme, e.g. otodoke-app-git-dev-<team>.vercel.app. */
  VERCEL_BRANCH_URL: z.string().min(1).optional(),
  /** Claude model used for email understanding. */
  OTODOKE_MODEL: z.string().default("claude-haiku-5-5"),
  /** Effort for extraction calls: low | medium | high. */
  OTODOKE_EXTRACT_EFFORT: z.enum(["low", "medium", "high"]).default("medium"),
  /** Paid Claude calls per user per JST day. */
  OTODOKE_USER_DAILY_LIMIT: z.coerce.number().int().positive().default(30),
  /** Paid Claude calls across all users per JST day: the app-side stop before the Console spend limit. */
  OTODOKE_GLOBAL_DAILY_LIMIT: z.coerce.number().int().positive().default(300),
});

export type Env = z.infer<typeof schema>;

let cached: Env | null = null;

export function env(): Env {
  if (cached) return cached;
  // A key left blank in the env file means "not configured", not "invalid".
  const configured = Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== ""));
  const parsed = schema.safeParse(configured);
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

const LOCAL_APP_URL = "http://localhost:3015";

/**
 * The origin to put in links that leave the app (the login email).
 *
 * - Vercel preview: the branch URL. NEXT_PUBLIC_APP_URL is set for Production only, and the
 *   per-deployment VERCEL_URL does not work with Deployment Protection.
 * - Vercel production (and anything else on Vercel): NEXT_PUBLIC_APP_URL.
 * - Developer machine (no VERCEL_ENV): NEXT_PUBLIC_APP_URL, else localhost.
 *
 * On Vercel without a usable value this throws rather than falling back to localhost, so a
 * login email never carries a link that cannot be opened.
 */
export function appUrl(): string {
  const { NEXT_PUBLIC_APP_URL, VERCEL_ENV, VERCEL_BRANCH_URL } = env();
  if (VERCEL_ENV === "preview" && VERCEL_BRANCH_URL) return `https://${VERCEL_BRANCH_URL}`;
  const url = NEXT_PUBLIC_APP_URL ?? (VERCEL_ENV ? undefined : LOCAL_APP_URL);
  if (!url) {
    throw new Error(`NEXT_PUBLIC_APP_URL is not set for the Vercel ${VERCEL_ENV} environment, and no branch URL applies.`);
  }
  return url.replace(/\/+$/, "");
}
