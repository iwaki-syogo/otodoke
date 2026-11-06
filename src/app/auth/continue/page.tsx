import Link from "next/link";
import { safeNextPath } from "@/lib/safe-next";
import { getUser } from "@/lib/supabase/server";
import { ContinueButton } from "./continue-button";

export const metadata = { title: "ログイン" };

type Param = string | string[] | undefined;
type SearchParams = Promise<{ token_hash?: Param; type?: Param; next?: Param }>;

/** A query value written twice comes as a list: the first one counts. */
const first = (value: Param) => (Array.isArray(value) ? value[0] : value);

/** Who is signed in on this browser. Null also when that cannot be read: the button shows, as before. */
async function signedInUser() {
  try {
    return await getUser();
  } catch {
    return null;
  }
}

/** The form that posts the link's token to /auth/confirm; nothing when the link has no token. */
function TokenForm({ tokenHash, type, next, className, children }: { tokenHash?: string; type?: string; next: string; className: string; children: React.ReactNode }) {
  if (!tokenHash || !type) return null;
  return (
    <form action="/auth/confirm" method="post" className={className}>
      <input type="hidden" name="token_hash" value={tokenHash} />
      <input type="hidden" name="type" value={type} />
      <input type="hidden" name="next" value={next} />
      {children}
    </form>
  );
}

/**
 * Where the login link lands (GET /auth/confirm sends it here). Opening it uses nothing: the
 * button posts the token to /auth/confirm, so a mail scanner that opens links does not use it up.
 *
 * Signed in already (the link opened a second time, or on a browser that is signed in): no login
 * prompt, but the address that is signed in and the way into the app, and the link stays unused.
 * Pressing 「ログインする」 there ended on the red 「すでに使われたリンク」 for a used link, and
 * switched accounts without a word for another account's link (one somebody else sent). Switching
 * stays possible for someone with two addresses, as its own button that says what it does.
 */
export default async function ContinuePage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const tokenHash = first(params.token_hash);
  const type = first(params.type);
  const next = safeNextPath(first(params.next) ?? null);
  const user = await signedInUser();

  if (user) {
    return (
      <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center px-4 py-10">
        <h1 className="text-2xl font-bold">ログインしています</h1>
        {user.email ? <p className="mt-2 break-all text-sm text-neutral-600">{user.email}</p> : null}
        <Link href={next} className="mt-6 block w-full rounded-lg bg-neutral-900 px-4 py-3 text-center text-base font-medium text-white active:opacity-80">
          荷物を見る
        </Link>
        <TokenForm tokenHash={tokenHash} type={type} next={next} className="mt-3">
          <ContinueButton label="別のアカウントでログインする" secondary />
        </TokenForm>
      </main>
    );
  }

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center px-4 py-10">
      <h1 className="text-2xl font-bold">Otodoke にログインしますか？</h1>
      {tokenHash && type ? (
        <TokenForm tokenHash={tokenHash} type={type} next={next} className="mt-6">
          <ContinueButton />
        </TokenForm>
      ) : (
        <p className="mt-4 text-sm text-neutral-600">
          リンクが不完全です。
          <Link href="/login" className="underline underline-offset-4">
            もう一度リンクを送ってください。
          </Link>
        </p>
      )}
    </main>
  );
}
