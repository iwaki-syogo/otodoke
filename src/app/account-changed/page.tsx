import { accountChangedPath, actionReturnPath } from "@/lib/action-identity";
import { ACCOUNT_CHANGED_LOGOUT_NOTICE } from "@/lib/account-changed-text";
import { readCookieSession } from "@/lib/auth-session";
import { createClient } from "@/lib/supabase/server";

export const metadata = { title: "ログイン中のアカウントを確認" };

/** GET only: show the current verified identity, then start again from a freshly rendered page. */
export default async function AccountChangedPage({ searchParams }: { searchParams?: Promise<{ next?: string | string[]; notice?: string | string[] }> } = {}) {
  const current = await readCookieSession(await createClient());
  const params = await searchParams;
  const next = params?.next;
  const notice = params?.notice === "logout" ? "logout" : undefined;
  const returnTo = actionReturnPath(typeof next === "string" ? next : null);
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col gap-5 px-4 py-12">
      <h1 className="text-xl font-bold">ログイン中のアカウントを確認してください</h1>
      <p className="text-sm leading-6">{notice === "logout" && current.state === "signed_in" ? ACCOUNT_CHANGED_LOGOUT_NOTICE : "画面を開いたときのアカウントを確認できなかったため、操作を止めました。開き直して、内容を確かめてからもう一度操作してください。"}</p>
      {current.state === "signed_in" ? (
        <>
          <p className="break-all rounded-xl bg-neutral-50 p-4 text-sm">現在ログイン中: {current.session.email ?? "メールアドレスを確認できません"}</p>
          <a href={returnTo} className="inline-flex min-h-12 items-center justify-center rounded-xl bg-neutral-900 px-4 py-3 text-sm font-medium text-white">このアカウントで画面を開き直す</a>
        </>
      ) : current.state === "unknown" ? (
        <>
          <p role="alert" className="text-sm leading-6">現在のアカウントを確認できませんでした。少し時間をおいて、もう一度確認してください。</p>
          <a href={accountChangedPath(returnTo, notice)} className="inline-flex min-h-12 items-center justify-center rounded-xl bg-neutral-900 px-4 py-3 text-sm font-medium text-white">もう一度確認する</a>
        </>
      ) : (
        <>
          <p className="text-sm">現在ログインしていません。</p>
          <a href={`/login?next=${encodeURIComponent(returnTo)}`} className="inline-flex min-h-12 items-center justify-center rounded-xl bg-neutral-900 px-4 py-3 text-sm font-medium text-white">ログインする</a>
        </>
      )}
    </main>
  );
}
