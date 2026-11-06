import type { ReactNode } from "react";
import { ScrollToHashOnReady } from "./scroll-to-hash";

/** A grey block standing in for text or a control while a page loads (a span, so it may sit in a heading). */
export function Bone({ className = "" }: { className?: string }) {
  return <span aria-hidden className={`block animate-pulse rounded-md bg-neutral-200 ${className}`} />;
}

/**
 * The body of a loading.tsx: the page's frame in grey blocks until the page arrives. It tells
 * screen readers 「読み込み中」, and it never says what a list holds (no 「〜はありません」):
 * nothing has been read yet. Once the page is in, a #fragment in the URL is scrolled to.
 */
export function SkeletonScreen({ children, className = "flex flex-col gap-6" }: { children: ReactNode; className?: string }) {
  return (
    <div role="status" aria-busy="true" className={className}>
      <span className="sr-only">読み込み中</span>
      {children}
      <ScrollToHashOnReady />
    </div>
  );
}

/** A section heading with its count: 「配達中 2」. */
export function HeadingBones({ className = "w-24" }: { className?: string }) {
  return <Bone className={`h-5 ${className}`} />;
}

/** Parcel cards in ParcelCard's frame: shop, name and status, then the date row. */
export function CardBones({ count = 3 }: { count?: number }) {
  return (
    <div className="flex flex-col gap-3">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="rounded-2xl border border-neutral-200 bg-white p-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <Bone className="h-3 w-20" />
              <Bone className="mt-2 h-4 w-3/4" />
            </div>
            <Bone className="h-5 w-14 rounded-full" />
          </div>
          <Bone className="mt-4 h-4 w-1/2" />
        </div>
      ))}
    </div>
  );
}
