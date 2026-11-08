import { createClient, getUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { countPlainRead } from "@/lib/mail-keys";
import { scheduleSealRemaining } from "@/lib/seal-later";
import { PasswordPanel } from "../password-panel";
import { readActiveKey } from "../settings-reads";
import { LoggedInAs, SubPage } from "../sub-page";

export const metadata = { title: "パスワードとメールの鍵" };

export default async function PasswordPage() {
  const user = (await getUser())!;
  const supabase = await createClient();
  const { key, failed: keyError } = await readActiveKey(supabase, "settings password");
  // Old plaintext mail is sealed in the background, bounded; nothing to do without a key or plaintext.
  scheduleSealRemaining(user.id);
  const { count: oldKeyCount, error: oldKeyError } = key
    ? await supabase.from("emails").select("id", { count: "exact", head: true }).eq("body_state", "sealed").neq("body_envelope->>kid", key.key_id)
    : { count: 0, error: null };
  if (oldKeyError) console.error("settings password (old key count):", oldKeyError.message);
  // The 11/14 notice is for users who have plaintext mail and no key; a failed count shows it (never hides it).
  let hasPlain = false;
  if (!key && !keyError) {
    try {
      hasPlain = (await countPlainRead(createAdminClient(), user.id)) > 0;
    } catch (err) {
      console.error("settings password (plain count):", err instanceof Error ? err.message : "unknown error");
      hasPlain = true;
    }
  }

  return (
    <SubPage title="パスワードとメールの鍵">
      {keyError ? (
        <section>
          <h2 className="text-base font-bold">パスワード</h2>
          <p className="mt-2 rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-900">メールの鍵を読み込めませんでした</p>
        </section>
      ) : (
        <>
          {/* A failed count is not 0: the panel's 「前の鍵」 line only shows for a count above 0, so the failure is told here. */}
          {oldKeyError ? <p className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-900">前の鍵のメールの数を読み込めませんでした</p> : null}
          <PasswordPanel state={{ userId: user.id, email: user.email ?? "", keyCreatedAt: key?.created_at ?? null, oldKeyCount: oldKeyCount ?? 0, hasPlain }} />
          <LoggedInAs email={user.email} />
        </>
      )}
    </SubPage>
  );
}
