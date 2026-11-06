"use client";

import { usePathname } from "next/navigation";
import { ErrorScreen } from "@/components/error-screen";
import { TO_LIST } from "@/components/not-found-screen";

/**
 * A page under /app that failed: shown inside the app, with its tabs. The way back is the parcel
 * list, left out when the list is the page that failed.
 */
export default function AppErrorPage({ error, retry }: { error: unknown; retry: () => void }) {
  const pathname = usePathname();
  return <ErrorScreen error={error} retry={retry} back={pathname === TO_LIST.href ? null : TO_LIST} />;
}
