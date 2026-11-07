import type { Metadata } from "next";
import Link from "next/link";
import { preload } from "react-dom";
import { Wordmark } from "@/components/wordmark";
import { GuideGroups, GuideVideo } from "@/components/forwarding-steps";
import {
  BEFORE_YOU_START,
  BEFORE_YOU_START_ACTION,
  BEFORE_YOU_START_HEADING,
  FORWARDING_GUIDES,
  FORWARDING_LEAD,
  FORWARDING_LEAD_NOTE,
  FORWARDING_TITLE,
  VIDEO_CREDIT,
  type ForwardingGuide,
} from "@/lib/forwarding-guide";

// Prerendered (○ in `next build`). Readable before signing in (the proxy guards /app only), and it
// reads nothing from the database, the cookies or the request. The words live in
// src/lib/forwarding-guide.ts, shared with the settings page and iOS.
export const dynamic = "force-static";

export const metadata: Metadata = { title: FORWARDING_TITLE };

const CARD = "rounded-2xl border border-neutral-200 bg-white p-4";
const SECONDARY_BUTTON =
  "flex items-center justify-center gap-1.5 rounded-xl border border-neutral-300 bg-white py-3 text-sm font-medium active:bg-neutral-100";

function ExternalIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M14 4h6v6" />
      <path d="M20 4l-9 9" />
      <path d="M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4" />
    </svg>
  );
}

function ExternalButton({ href, label }: { href: string; label: string }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={SECONDARY_BUTTON}>
      {label}
      <ExternalIcon />
    </a>
  );
}

function GuideSection({ guide }: { guide: ForwardingGuide }) {
  return (
    <section id={guide.id} className={`${CARD} scroll-mt-4`}>
      <h2 className="text-base font-bold">{guide.title}</h2>
      {guide.addresses && <p className="mt-1 text-xs text-neutral-500">{guide.addresses}</p>}
      {guide.time && <p className="mt-1 text-xs text-neutral-500">目安: {guide.time}</p>}
      {guide.video && <GuideVideo video={guide.video} title={guide.title} />}
      {guide.link && (
        <div className="mt-3">
          <ExternalButton href={guide.link.href} label={guide.link.label} />
          {guide.linkNote && <p className="mt-2 whitespace-pre-line text-sm text-neutral-600">{guide.linkNote}</p>}
        </div>
      )}
      {guide.intro && <p className="mt-3 text-sm leading-6 text-neutral-600">{guide.intro}</p>}
      <GuideGroups groups={guide.groups} />
      {guide.notes.map((note) => (
        <p key={note} className="mt-4 text-xs leading-5 text-neutral-500">
          {note}
        </p>
      ))}
    </section>
  );
}

export default function ForwardingGuidePage() {
  // Gmail's video card is the first one on the page: start loading its poster early (the video stays preload="none").
  preload("/guide/videos/otodoke-fwd-gmail-poster.jpg", { as: "image", fetchPriority: "high" });
  return (
    <main className="mx-auto flex w-full max-w-md flex-col gap-8 px-4 py-10">
      <div>
        <Link href="/" className="-my-2 inline-block py-2 text-sm text-neutral-500">
          <span aria-hidden="true">←</span> <Wordmark className="text-lg" />
        </Link>
        <h1 className="mt-8 text-2xl font-bold">{FORWARDING_TITLE}</h1>
        <p className="mt-3 text-sm leading-6 text-neutral-600">{FORWARDING_LEAD}</p>
        <p className="mt-2 text-xs text-neutral-500">{FORWARDING_LEAD_NOTE}</p>
        <nav className="mt-4 flex flex-wrap gap-2">
          {FORWARDING_GUIDES.map((g) => (
            <a key={g.id} href={`#${g.id}`} className="rounded-full border border-neutral-300 bg-white px-4 py-2 text-sm font-medium active:bg-neutral-100">
              {g.chip}
            </a>
          ))}
        </nav>
      </div>

      <section className={CARD}>
        <h2 className="text-base font-bold">{BEFORE_YOU_START_HEADING}</h2>
        <ul className="mt-2 flex flex-col gap-1 text-sm leading-6 text-neutral-600">
          {BEFORE_YOU_START.map((t) => (
            <li key={t}>{t}</li>
          ))}
        </ul>
        <Link href="/app/settings/forwarding" className={`${SECONDARY_BUTTON} mt-4`}>
          {BEFORE_YOU_START_ACTION}
        </Link>
      </section>

      {FORWARDING_GUIDES.map((g) => (
        <GuideSection key={g.id} guide={g} />
      ))}

      <p className="text-xs text-neutral-500">{VIDEO_CREDIT}</p>
    </main>
  );
}
