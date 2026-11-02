"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "/app", label: "荷物", icon: "📦" },
  { href: "/app/calendar", label: "カレンダー", icon: "📅" },
  { href: "/app/spend", label: "支出", icon: "¥" },
  { href: "/app/settings", label: "設定", icon: "⚙︎" },
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
          const active = t.href === "/app" ? pathname === "/app" || pathname.startsWith("/app/parcels") : pathname.startsWith(t.href);
          return (
            <li key={t.href}>
              <Link
                href={t.href}
                aria-current={active ? "page" : undefined}
                className={`flex flex-col items-center gap-0.5 py-2.5 text-[11px] ${active ? "font-bold text-neutral-900" : "text-neutral-500"}`}
              >
                <span aria-hidden className="text-lg leading-none">
                  {t.icon}
                </span>
                {t.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
