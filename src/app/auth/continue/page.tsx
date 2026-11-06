import Link from "next/link";
import { getUser } from "@/lib/supabase/server";
import { ContinueButton } from "./continue-button";

export const metadata = { title: "確認" };

type Param = string | string[] | undefined;
type SearchParams = Promise<{ token_hash?: Param; type?: Param }>;

/** A query value written twice comes as a list: the first one counts. */
const first = (value: Param) => (Array.isArray(value) ? value[0] : value);

/** What the page says and its button does, by the link's type (the ones /auth/confirm takes). */
const WORDS = {
  confirm: { heading: "メールアドレスを確認しますか？", button: "確認する", pending: "確認しています…" },
  reset: { heading: "パスワードを再設定しますか？", button: "再設定する", pending: "開いています…" },
} as const;

function kindOf(type: string | undefined): keyof typeof WORDS | null {
  if (type === "recovery") return "reset";
  if (type === "email" || type === "signup" || type === "magiclink") return "confirm";
  return null;
}

/** Who is signed in on this browser. Null also when that cannot be read: then nothing is said. */
async function signedInUser() {
  try {
    return await getUser();
  } catch {
    return null;
  }
}

/**
 * Where a mail's link lands (GET /auth/confirm sends it here). Opening it uses nothing: the button
 * posts the token to /auth/confirm, so a mail scanner that opens links does not use it up.
 *
 * A confirmation link leaves this browser's session as it is (/auth/confirm throws away the one it
 * makes), so the page says nothing about who is signed in. A reset link signs this browser in to
 * the account it resets: when another session is here, the page says which address it leaves.
 *
 * Nothing on the page comes from the URL but the token and its type, which are only posted back;
 * the words are fixed.
 */
export default async function ContinuePage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const tokenHash = first(params.token_hash);
  const type = first(params.type);
  const kind = kindOf(type);

  if (!tokenHash || !type || !kind) {
    return (
      <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center px-4 py-10">
        <p className="text-sm text-neutral-600">リンクが不完全です。いちばん新しいメールのリンクを開いてください。</p>
        <Link href="/login" className="mt-6 self-start text-sm text-neutral-600 underline underline-offset-4">
          ログイン
        </Link>
      </main>
    );
  }

  const words = WORDS[kind];
  const leaving = kind === "reset" ? await signedInUser() : null;
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center px-4 py-10">
      <h1 className="text-2xl font-bold">{words.heading}</h1>
      {leaving ? (
        <p className="mt-2 break-all text-sm text-neutral-600">{leaving.email ? `ログイン中の ${leaving.email} からログアウトします。` : "ログイン中のアカウントからログアウトします。"}</p>
      ) : null}
      <form action="/auth/confirm" method="post" className="mt-6">
        <input type="hidden" name="token_hash" value={tokenHash} />
        <input type="hidden" name="type" value={type} />
        <ContinueButton label={words.button} pendingLabel={words.pending} />
      </form>
    </main>
  );
}
