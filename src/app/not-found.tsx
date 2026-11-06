import { NotFoundScreen, TO_TOP } from "@/components/not-found-screen";

export const metadata = { title: "ページが見つかりません" };

/**
 * Every URL no page answers, and notFound() outside /app.
 *
 * It reads no session: Next renders the root not-found with every page (it is the root
 * boundary's fallback), so a sign-in check here would cost every request a round trip to Supabase
 * Auth and make every page per-request. The one way back is the top page, which serves both: it
 * offers 「荷物を見る」 to someone signed in, and the login to someone who is not (a judge who
 * mistyped a URL is not taken to the login page). The 404 inside /app leads to the parcel list.
 */
export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center px-4 py-10">
      <NotFoundScreen back={TO_TOP} />
    </main>
  );
}
