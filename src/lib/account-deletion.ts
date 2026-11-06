import type { AdminClient } from "@/lib/supabase/admin";

/**
 * Deleting an account (設定「アカウントを削除」): what the settings section, its Server Action
 * (src/app/app/settings/account-actions.ts) and the page after it share.
 *
 * One call to Supabase Auth's admin API deletes the auth user, and the database takes every row of
 * theirs with it in the same transaction: each table that names a user references auth.users with
 * `on delete cascade` (account-deletion-cascade.test.ts reads the migrations to keep it so). The one
 * exception is the daily count of Claude calls: its rows stay with no user (`on delete set null`,
 * 20261106190000), so deleting an account does not give its calls back to the app-wide daily limit.
 * Their sessions and refresh tokens go too. The receiving address stops: mail to it is answered 200 and
 * dropped (src/app/api/inbound/route.ts), and its local part is never given out again
 * (supabase/migrations/20261106170000_issued_inbox_local_parts.sql).
 *
 * Imported by the client section for the field below: type-only imports here, nothing that reaches
 * Supabase from the browser (no-browser-supabase.test.ts).
 */

/** The hidden field only the confirmation step's form carries. Without it nothing is deleted. */
export const ACCOUNT_DELETE_CONFIRM = { name: "confirm", value: "delete-account" } as const;

/** The page after the account is gone. Outside /app: there is no session any more. */
export const ACCOUNT_DELETED_PATH = "/account-deleted";

/** The only words a failure shows. What Supabase said stays in the server log. */
export const ACCOUNT_DELETE_FAILED = "削除できませんでした。少し時間をおいて、もう一度お試しください。";

/** What the Server Action hands back to the form: null until a try fails. */
export type DeleteAccountState = { error: string } | null;

export type DeleteAuthUserOutcome = { ok: true } | { ok: false; reason: string };

/** An auth error for the server log: status, code and message, never the object itself. */
function summary(error: { message?: string; status?: number; code?: string }): string {
  return [error.status, error.code, error.message].filter((part) => part !== undefined && part !== "").join(" ");
}

/**
 * Delete the auth user `userId` for good. Not Supabase's soft delete: that keeps a marked row in
 * auth.users, so none of the user's rows would cascade.
 *
 * When Supabase answers with an error, it is asked once more whether the user is still there: a
 * delete that went through but whose answer was lost is told as done. Otherwise the person would
 * be shown a failure, press again, and land on the login page with no word of what happened.
 */
export async function deleteAuthUser(admin: AdminClient, userId: string): Promise<DeleteAuthUserOutcome> {
  const { error } = await admin.auth.admin.deleteUser(userId, false);
  if (!error) return { ok: true };

  const { data, error: lookupError } = await admin.auth.admin.getUserById(userId);
  if (lookupError && (lookupError.status === 404 || lookupError.code === "user_not_found")) return { ok: true };
  const after = lookupError ? `; the check after it failed too: ${summary(lookupError)}` : data.user ? "; the user is still there" : "";
  return { ok: false, reason: `${summary(error)}${after}` };
}
