import Link from "next/link";

/** The way to another page at the end of a list: the whole row is the link. */
export function PageLink({ href, label, count }: { href: string; label: string; count?: number }) {
  return (
    <Link
      href={href}
      className="flex items-center justify-between gap-3 rounded-xl border border-neutral-200 bg-white px-4 py-3 text-sm font-medium active:bg-neutral-50"
    >
      <span className="underline underline-offset-4">{label}</span>
      <span className="flex shrink-0 items-center gap-2 text-neutral-500">
        {count !== undefined ? <span>{count.toLocaleString("ja-JP")} 件</span> : null}
        <span aria-hidden>›</span>
      </span>
    </Link>
  );
}
