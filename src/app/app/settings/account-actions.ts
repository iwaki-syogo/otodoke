"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { ACCOUNT_DELETE_CONFIRM, ACCOUNT_DELETE_FAILED, ACCOUNT_DELETED_PATH, deleteAuthUser, type DeleteAccountState } from "@/lib/account-deletion";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { requireDisplayedUser } from "@/lib/action-identity";

/**
 * 「削除する」 in the confirmation step of 設定「アカウントを削除」: deletes the signed-in user's
 * account and everything in it (src/lib/account-deletion.ts), then this browser's session, and
 * goes to the page that says so.
 *
 * In this order:
 *   1. the user from the session (Supabase Auth checks the token). Never an id from the form, so
 *      nobody can name somebody else's account.
 *   2. the confirmation step's field. Without it, nothing is deleted.
 *   3. the auth user, with the service role. The rows go with it in one transaction, so a failure
 *      leaves everything as it was: the person stays signed in and sees fixed words to try again.
 *   4. only then this browser's session cookies (the sessions themselves went with the user).
 *   5. the page after it, replacing this one in the history: Back does not come here again.
 */
export async function deleteAccount(_previous: DeleteAccountState, formData: FormData): Promise<DeleteAccountState> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  requireDisplayedUser(user, formData.get("expectedUserId"), "/app/settings/delete");
  if (formData.get(ACCOUNT_DELETE_CONFIRM.name) !== ACCOUNT_DELETE_CONFIRM.value) return { error: ACCOUNT_DELETE_FAILED };

  let deleted = false;
  try {
    const outcome = await deleteAuthUser(createAdminClient(), user.id);
    if (outcome.ok) deleted = true;
    else console.error("deleteAccount:", outcome.reason);
  } catch (err) {
    console.error("deleteAccount:", err instanceof Error ? err.message : "unknown error");
  }
  if (!deleted) return { error: ACCOUNT_DELETE_FAILED };

  // The account is gone already: a failure here must not turn into "could not delete".
  try {
    const { error } = await supabase.auth.signOut({ scope: "local" });
    if (error) console.warn("deleteAccount (sign out):", error.message);
  } catch (err) {
    console.warn("deleteAccount (sign out):", err instanceof Error ? err.message : "unknown error");
  }
  revalidatePath("/", "layout");
  redirect(ACCOUNT_DELETED_PATH, "replace");
}
