"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { createContext, useContext, useState, useTransition, type MouseEvent, type ReactNode } from "react";

type Area = { pending: boolean; target: string | null; go: ((href: string) => void) | null };

const AreaContext = createContext<Area>({ pending: false, target: null, go: null });
/** Whether the link around is the one pressed and its page is on the way. */
const PressedContext = createContext(false);

/**
 * The figures and the orders of the spend screen, with the one transition every filter link in
 * it shares: from a tap until the new URL's page arrives, everything here is faint and every
 * filter link waits (so no link is followed from an old URL).
 */
export function FilterArea({ children }: { children?: ReactNode }) {
  const [pending, startTransition] = useTransition();
  const [target, setTarget] = useState<string | null>(null);
  const router = useRouter();
  const go = (href: string) => {
    setTarget(href);
    startTransition(() => router.push(href));
  };

  return (
    <AreaContext.Provider value={{ pending, target, go }}>
      <div aria-busy={pending || undefined} className={`flex flex-col gap-6 ${pending ? "opacity-50" : ""}`}>
        {children}
      </div>
    </AreaContext.Provider>
  );
}

/** A filter link (a category row, a shop row, a chip). The page builds the href. */
export function FilterLink({ href, children, className, "aria-current": current }: { href: string; children?: ReactNode; className?: string; "aria-current"?: "true" }) {
  const { pending, target, go } = useContext(AreaContext);

  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    if (pending) {
      e.preventDefault();
      return;
    }
    // A new tab or window opens as usual.
    if (!go || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    go(href);
  };

  return (
    <Link href={href} aria-current={current} aria-disabled={pending || undefined} onClick={onClick} className={className}>
      <PressedContext.Provider value={pending && target === href}>{children}</PressedContext.Provider>
    </Link>
  );
}

/** Inside a FilterLink: the spinner while that link's page is on the way, else `children`. */
export function FilterSpinner({ children }: { children?: ReactNode }) {
  return useContext(PressedContext) ? <Spinner /> : <>{children}</>;
}

function Spinner() {
  return <span aria-hidden className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-neutral-300 border-t-neutral-700" />;
}
