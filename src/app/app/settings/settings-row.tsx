import Link from "next/link";
import type { ReactNode } from "react";

/** A line-drawn icon in the tab bar's style: 24 grid, 1.7 stroke, no fill. */
export function RowIcon({ path }: { path: string }) {
  return (
    <svg aria-hidden viewBox="0 0 24 24" className="h-5 w-5 shrink-0 text-neutral-500" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round">
      <path d={path} />
    </svg>
  );
}

export const ICONS = {
  forwarding: "M4 6h16v12H4V6zM4 7l8 6 8-6",
  password: "M6 11h12v9H6v-9zM8.5 11V8a3.5 3.5 0 017 0v3",
  dropped: "M4 13l2-8h12l2 8M4 13v6h16v-6M4 13h5l1 2h4l1-2h5",
  handling: "M12 3l7 3v5c0 5-3 8-7 10-4-2-7-5-7-10V6l7-3z",
  trouble: "M12 21a9 9 0 100-18 9 9 0 000 18zM9.5 9.5a2.5 2.5 0 114 2c-.9.6-1.5 1-1.5 2M12 17h.01",
  demo: "M5 4l14 8-14 8V4z",
  login: "M12 12a4 4 0 100-8 4 4 0 000 8zM4 20c0-4 4-6 8-6s8 2 8 6",
  logout: "M10 4H5v16h5M14 8l4 4-4 4M18 12H9",
  privacy: "M7 3h8l4 4v14H7V3zM15 3v4h4M10 12h6M10 16h6",
  delete: "M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13M10 11v6M14 11v6",
} as const;

export type IconName = keyof typeof ICONS;

/** The rows that need something done come first in the mail group, in this order. */
const ACTION_ORDER = ["password", "trouble", "forwarding"];

/** Action rows first (in ACTION_ORDER), then the rest in the order given. */
export function orderRows<T extends { id: string; action?: boolean }>(rows: T[]): T[] {
  const urgent = ACTION_ORDER.map((id) => rows.find((r) => r.id === id && r.action)).filter((r): r is T => Boolean(r));
  return [...urgent, ...rows.filter((r) => !urgent.includes(r))];
}

export type Badge = { text: string; tone: "amber" | "neutral" | "red" };

const BADGE_TONES: Record<Badge["tone"], string> = {
  amber: "border border-amber-300 bg-amber-50 text-amber-900",
  neutral: "bg-neutral-100 text-neutral-600",
  red: "border border-red-200 bg-red-50 text-red-800",
};

export const ROW_CLASS = "flex min-h-[52px] w-full items-center gap-3 px-4 text-left text-sm font-medium text-neutral-900";

/** A white card of rows, divided by thin lines. */
export function RowCard({ children }: { children: ReactNode }) {
  return <div className="divide-y divide-neutral-100 overflow-hidden rounded-2xl border border-neutral-200 bg-white">{children}</div>;
}

/** One row that opens a page: icon, title, an optional badge, then 「›」. */
export function RowLink({ href, icon, title, badge }: { href: string; icon: IconName; title: string; badge?: Badge | null }) {
  return (
    <Link href={href} className={`${ROW_CLASS} active:bg-neutral-50`}>
      <RowIcon path={ICONS[icon]} />
      <span className="min-w-0 flex-1">{title}</span>
      {badge ? <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${BADGE_TONES[badge.tone]}`}>{badge.text}</span> : null}
      <span aria-hidden className="shrink-0 text-neutral-400">
        ›
      </span>
    </Link>
  );
}

/** A row that opens nothing: the title, and a value under or beside it. */
export function RowInfo({ icon, title, value }: { icon: IconName; title: string; value: string }) {
  return (
    <div className={`${ROW_CLASS} flex-wrap py-3`}>
      <RowIcon path={ICONS[icon]} />
      <span className="shrink-0">{title}</span>
      <span className="min-w-0 flex-1 break-all text-right text-xs font-normal text-neutral-500">{value}</span>
    </div>
  );
}
