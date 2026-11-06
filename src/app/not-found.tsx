import { unstable_rethrow } from "next/navigation";
import { NotFoundScreen, TO_LIST, TO_TOP } from "@/components/not-found-screen";
import { getUser } from "@/lib/supabase/server";

export const metadata = { title: "ページが見つかりません" };

/**
 * Every URL no page answers, and notFound() outside /app. Signed in, the way back is the parcel
 * list; otherwise the top page.
 */
export default async function NotFound() {
  let signedIn = false;
  try {
    signedIn = (await getUser()) !== null;
  } catch (err) {
    // Next's own signals go on (reading cookies while prerendering makes this page per request).
    unstable_rethrow(err);
    // Not knowing who this is: the top page works for everyone.
    console.error("not-found (session):", err instanceof Error ? err.message : "unknown error");
  }
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center px-4 py-10">
      <NotFoundScreen back={signedIn ? TO_LIST : TO_TOP} />
    </main>
  );
}
