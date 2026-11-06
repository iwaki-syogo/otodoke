"use client";

import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { WELCOME_PATH } from "@/lib/onboarding";

/**
 * Inside /app's loading screen, which stands in for a moment while any page under /app is on its
 * way: on the way to the first-run guide, the guide's frame instead of the parcel list's (the list
 * is never shown, even in grey, before the guide).
 */
export function BonesForPath({ welcome, children }: { welcome: ReactNode; children: ReactNode }) {
  const path = usePathname();
  return <>{path === WELCOME_PATH || path?.startsWith(`${WELCOME_PATH}/`) ? welcome : children}</>;
}
