import { z } from "zod";

/** Bounded unread storage; successful reads free it without waiting for midnight. */
export const mailStorageSchema = z.object({
  OTODOKE_UNREAD_USER_MAIL_LIMIT: z.coerce.number().int().positive().default(200),
  OTODOKE_UNREAD_GLOBAL_MAIL_LIMIT: z.coerce.number().int().positive().default(2000),
  OTODOKE_UNREAD_USER_BYTE_LIMIT: z.coerce.number().int().positive().default(16 * 1024 * 1024),
  OTODOKE_UNREAD_GLOBAL_BYTE_LIMIT: z.coerce.number().int().positive().default(256 * 1024 * 1024),
});

/** Does not require API credentials when loading a precomputed public sample. */
export function mailStorageLimits() {
  const configured = Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== ""));
  const result = mailStorageSchema.safeParse(configured);
  if (!result.success) throw new Error(`Invalid mail storage limits: ${result.error.issues.map((i) => i.path.join(".")).join(", ")}`);
  return result.data;
}
