import Link from "next/link";

/** The way to the page of delivered parcels, at the end of a list. */
export function DeliveredLink({ count }: { count?: number }) {
  return (
    <Link
      href="/app/delivered"
      className="flex items-center justify-between rounded-xl border border-neutral-200 bg-white px-4 py-3 text-sm font-medium active:bg-neutral-50"
    >
      <span>届いた荷物 ›</span>
      {count !== undefined ? <span className="text-neutral-500">{count.toLocaleString("ja-JP")} 件</span> : null}
    </Link>
  );
}
