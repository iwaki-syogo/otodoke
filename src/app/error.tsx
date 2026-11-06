"use client";

import { usePathname } from "next/navigation";
import { ErrorScreen } from "@/components/error-screen";
import { TO_TOP } from "@/components/not-found-screen";

/**
 * A page outside /app that failed (the top page, the login screens), or /app's own layout. The way
 * back is the top page, which works signed in or not; it is left out when that is the page that failed.
 */
export default function ErrorPage({ error, retry }: { error: unknown; retry: () => void }) {
  const pathname = usePathname();
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center px-4 py-10">
      <ErrorScreen error={error} retry={retry} back={pathname === TO_TOP.href ? null : TO_TOP} />
    </main>
  );
}
