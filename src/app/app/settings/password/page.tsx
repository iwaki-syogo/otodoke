import { createClient, getUser } from "@/lib/supabase/server";
import { countPlainRead } from "@/lib/mail-keys";
import { PasswordPanel } from "../password-panel";
import { readActiveKey } from "../settings-reads";
import { SubPage } from "../sub-page";

export const metadata = { title: "パスワードとメールの鍵" };

export default async function PasswordPage() {
  const user = (await getUser())!;
  const supabase = await createClient();
  const { key, failed: keyError } = await readActiveKey(supabase, "settings password");
  // Read mail still in plaintext, from before encryption. The public sample mails are not counted:
  // they are anonymized fixtures from the repository, not mail of the user's the operator could read.
  let plainCount: number | null;
  try {
    plainCount = await countPlainRead(supabase, user.id);
  } catch (err) {
    plainCount = null;
    console.error("settings password (plain count):", err instanceof Error ? err.message : "unknown error");
  }
  const { count: oldKeyCount } = key
    ? await supabase.from("emails").select("id", { count: "exact", head: true }).eq("body_state", "sealed").neq("body_envelope->>kid", key.key_id)
    : { count: 0 };

  return (
    <SubPage title="パスワードとメールの鍵">
      {keyError ? (
        <section>
          <h2 className="text-base font-bold">パスワード</h2>
          <p className="mt-2 rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-900">読み込めませんでした</p>
        </section>
      ) : (
        <PasswordPanel state={{ userId: user.id, email: user.email ?? "", keyCreatedAt: key?.created_at ?? null, plainCount, oldKeyCount: oldKeyCount ?? 0 }} />
      )}
    </SubPage>
  );
}
