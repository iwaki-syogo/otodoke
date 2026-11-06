"use client";

// global-error replaces the root layout, so it brings the document and the styles itself.
import "./globals.css";
import { ErrorScreen } from "@/components/error-screen";
import { TO_TOP } from "@/components/not-found-screen";

/** The root layout failed. Japanese like every other screen; the way back is the top page. */
export default function GlobalError({ error, retry }: { error: unknown; retry: () => void }) {
  return (
    <html lang="ja">
      <body className="min-h-dvh antialiased">
        <title>Otodoke</title>
        <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center px-4 py-10">
          <ErrorScreen error={error} retry={retry} back={TO_TOP} />
        </main>
      </body>
    </html>
  );
}
