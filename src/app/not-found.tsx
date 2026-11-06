import { NotFoundScreen, TO_LIST } from "@/components/not-found-screen";

export const metadata = { title: "ページが見つかりません" };

/**
 * Every URL no page answers, and notFound() outside /app.
 *
 * It reads no session: Next renders the root not-found with every page (it is the root
 * boundary's fallback), so a sign-in check here would cost every request a round trip to Supabase
 * Auth and make every page per-request. The one way back is the parcel list, as on the 404 inside
 * /app; someone signed out is taken to /login by proxy.ts, and back to the list after signing in.
 */
export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center px-4 py-10">
      <NotFoundScreen back={TO_LIST} />
    </main>
  );
}
