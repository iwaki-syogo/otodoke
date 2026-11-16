import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/db/database.types";
import { EXCLUDED_TOAST, EXCLUDED_TOAST_AUTO } from "@/lib/not-parcel-text";

/**
 * Which sentence follows a successful 「これは荷物ではありません」: the plain one, or the one that also says the app
 * will do it by itself from now on. Asked once, after exclude_parcel answered 'ok', of the read-only
 * auto_exclusion_would_start. Only a clean `true` gives the second sentence: a failed, thrown or odd answer gives the
 * first, which never says something that may not happen.
 */
export async function excludedToastText(supabase: SupabaseClient<Database>, parcelId: string): Promise<string> {
  try {
    const { data, error } = await supabase.rpc("auto_exclusion_would_start", { p_parcel_id: parcelId });
    if (!error && data === true) return EXCLUDED_TOAST_AUTO;
  } catch {
    // The plain sentence below.
  }
  return EXCLUDED_TOAST;
}
