"use client";

import Link, { useLinkStatus } from "next/link";
import { usePathname } from "next/navigation";
import { Spinner } from "@/components/spinner";

const TABS = [
  { href: "/app", label: "荷物", icon: "M3 8l9-5 9 5v8l-9 5-9-5V8zM3 8l9 5 9-5M12 13v8" },
  { href: "/app/calendar", label: "カレンダー", icon: "M4 6h16v14H4V6zM4 10h16M8 3v4M16 3v4" },
  { href: "/app/spend", label: "支出", icon: "M6 4l6 8 6-8M12 12v8M7 13h10M7 17h10" },
  { href: "/app/settings", label: "設定", icon: "M4 7h10M18 7h2M4 17h2M10 17h10M14 5h4v4h-4V5zM6 15h4v4H6v-4z" },
];

export function TabBar() {
  const pathname = usePathname();
  return (
    <nav
      aria-label="メイン"
      className="fixed inset-x-0 bottom-0 z-10 border-t border-neutral-200 bg-white/95 pb-[env(safe-area-inset-bottom)] backdrop-blur"
    >
      <ul className="mx-auto grid w-full max-w-md grid-cols-4">
        {TABS.map((t) => {
          const active = t.href === "/app" ? pathname === "/app" || pathname.startsWith("/app/parcels") || pathname.startsWith("/app/delivered") || pathname.startsWith("/app/cancelled") : pathname.startsWith(t.href);
          return (
            <li key={t.href}>
              <Link
                href={t.href}
                aria-current={active ? "page" : undefined}
                className={`flex flex-col items-center gap-0.5 py-2.5 text-[11px] ${active ? "font-bold text-neutral-900" : "text-neutral-500"}`}
              >
                <TabIcon path={t.icon} active={active} />
                {t.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/**
 * The tab's icon, or a spinner in its place while the tab's page is on the way and its loading
 * screen is not there yet (a slow network, before the prefetch is done). Same size, so nothing moves.
 */
function TabIcon({ path, active }: { path: string; active: boolean }) {
  const { pending } = useLinkStatus();
  return (
    <span aria-hidden className="flex h-5 w-5 items-center justify-center">
      {pending ? (
        <Spinner size="lg" />
      ) : (
        <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={active ? 2.2 : 1.7} strokeLinecap="round" strokeLinejoin="round">
          <path d={path} />
        </svg>
      )}
    </span>
  );
}
