import Link from "next/link";
import { PUBLIC_PAGE_TEXT } from "@/lib/public-pages";

/** The same public destinations remain available before and after signing in. */
export function PublicPageLinks({ current, includePrivacy = true }: { current?: "/terms" | "/support"; includePrivacy?: boolean }) {
  return (
    <nav aria-label={PUBLIC_PAGE_TEXT.navigation} className="flex flex-wrap gap-x-5 text-xs text-neutral-500">
      {PUBLIC_PAGE_TEXT.links
        .filter((link) => link.href !== current && (includePrivacy || link.href !== "/privacy"))
        .map((link) => (
          <Link key={link.href} href={link.href} className="inline-flex min-h-11 items-center py-2 underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-900">
            {link.label}
          </Link>
        ))}
    </nav>
  );
}
