"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { createContext, useContext, useId, useState, useTransition, type MouseEvent, type ReactNode } from "react";

/**
 * One move to another URL at a time. `target` is the key of what was pressed (a link, the month
 * picker), so only that one shows a spinner.
 */
export type FilterNav = { pending: boolean; target: string | null; go: ((href: string, key: string) => void) | null };

const NavContext = createContext<FilterNav>({ pending: false, target: null, go: null });
/** Whether the link around is the one pressed and its page is on the way. */
const PressedContext = createContext(false);

function useOwnNav(): FilterNav {
  const [pending, startTransition] = useTransition();
  const [target, setTarget] = useState<string | null>(null);
  const router = useRouter();
  const go = (href: string, key: string) => {
    setTarget(key);
    startTransition(() => router.push(href));
  };
  return { pending, target, go };
}

/** The transition of the FilterScope / FilterArea around, or null when there is none. */
export function useFilterScope(): FilterNav | null {
  const outer = useContext(NavContext);
  return outer.go ? outer : null;
}

/** The transition of the FilterScope / FilterArea around, or one of the caller's own when there is none. */
function useFilterNav(): FilterNav {
  const outer = useFilterScope();
  const own = useOwnNav();
  return outer ?? own;
}

/**
 * Every control that changes what a screen shows (the month, the period, a filter) shares this
 * one transition: while any of them is on the way, every other one waits, so none is followed
 * from an old URL.
 */
export function FilterScope({ children }: { children?: ReactNode }) {
  const nav = useFilterNav();
  return <NavContext.Provider value={nav}>{children}</NavContext.Provider>;
}

/**
 * The figures and the orders of the spend screen: faint from a tap until the new URL's page
 * arrives. Joins the FilterScope around it, or holds the transition itself when there is none.
 */
export function FilterArea({ children }: { children?: ReactNode }) {
  const nav = useFilterNav();
  const { pending } = nav;

  return (
    <NavContext.Provider value={nav}>
      <div aria-busy={pending || undefined} className={`flex flex-col gap-6 ${pending ? "opacity-50" : ""}`}>
        {children}
      </div>
    </NavContext.Provider>
  );
}

type FilterLinkProps = {
  href: string;
  children?: ReactNode;
  className?: string;
  "aria-current"?: "true" | "page";
  "aria-label"?: string;
  title?: string;
  prefetch?: boolean;
};

/** A link that changes the screen's conditions (a row, a chip, a month, a bar). The page builds the href. */
export function FilterLink({ href, children, className, "aria-current": current, "aria-label": label, title, prefetch }: FilterLinkProps) {
  const { pending, target, go } = useContext(NavContext);
  const key = useId();

  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    if (pending) {
      e.preventDefault();
      return;
    }
    // A new tab or window opens as usual.
    if (!go || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    go(href, key);
  };

  return (
    <Link
      href={href}
      prefetch={prefetch}
      aria-current={current}
      aria-label={label}
      title={title}
      aria-disabled={pending || undefined}
      onClick={onClick}
      className={className}
    >
      <PressedContext.Provider value={pending && target === key}>{children}</PressedContext.Provider>
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
