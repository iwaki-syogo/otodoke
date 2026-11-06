import Link from "next/link";

/** Where a person goes back to: the parcel list inside /app (signed in there), else the top page. */
export type WayBack = { href: "/app"; label: "荷物の一覧へ" } | { href: "/"; label: "トップへ" };

export const TO_LIST: WayBack = { href: "/app", label: "荷物の一覧へ" };
export const TO_TOP: WayBack = { href: "/", label: "トップへ" };

/** 404, for a URL no page answers and for notFound() (another person's parcel, a malformed id). */
export function NotFoundScreen({ back }: { back: WayBack }) {
  return (
    <div className="flex flex-col items-center justify-center py-20 text-center">
      <p aria-hidden className="text-5xl">
        📭
      </p>
      <h1 className="mt-4 text-lg font-bold">ページが見つかりません</h1>
      <Link href={back.href} className="mt-6 w-full rounded-xl bg-neutral-900 px-5 py-3 text-sm font-medium text-white active:opacity-80">
        {back.label}
      </Link>
    </div>
  );
}
