import type { Metadata } from "next";
import Link from "next/link";
import { Wordmark } from "@/components/wordmark";
import { CopyButton } from "@/app/app/settings/copy-button";
import {
  BEFORE_YOU_START,
  BEFORE_YOU_START_HEADING,
  FORWARDING_CHECK,
  FORWARDING_CHECK_ACTION,
  FORWARDING_GUIDES,
  FORWARDING_LEAD,
  FORWARDING_LEAD_NOTE,
  FORWARDING_PITFALLS,
  FORWARDING_TITLE,
  GMAIL_FILTER,
  PITFALLS_HEADING,
  PITFALLS_LEAD,
  type ForwardingGuide,
  type ForwardingPitfall,
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

function TextLink({ href, label }: { href: string; label: string }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="text-sm leading-6 text-sky-700 underline">
      {label}
    </a>
  );
}

function StepList({ steps, start = 1 }: { steps: { text: string; copy?: "gmailFilter" }[]; start?: number }) {
  return (
    <ol className="flex flex-col gap-3">
      {steps.map((step, i) => (
        <li key={start + i} className="flex gap-3">
          <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-neutral-900 text-xs font-medium text-white">{start + i}</span>
          <div className="min-w-0 flex-1 text-sm leading-6 text-neutral-600">
            {step.text}
            {step.copy === "gmailFilter" && (
              <div className="mt-2 flex items-center gap-2 rounded-xl bg-neutral-50 p-2">
                <code className="min-w-0 flex-1 break-all text-xs">{GMAIL_FILTER}</code>
                <CopyButton text={GMAIL_FILTER} />
              </div>
            )}
          </div>
        </li>
      ))}
    </ol>
  );
}

function CodeList({ codes }: { codes: string[] }) {
  return (
    <div className="mt-2 flex flex-wrap gap-2">
      {codes.map((c) => (
        <code key={c} className="break-all rounded-lg bg-neutral-50 px-2 py-1 text-xs">
          {c}
        </code>
      ))}
    </div>
  );
}

function GuideSection({ guide }: { guide: ForwardingGuide }) {
  const starts = guide.groups.map((_, i) => 1 + guide.groups.slice(0, i).reduce((n, g) => n + g.steps.length, 0));
  return (
    <section id={guide.id} className={`${CARD} scroll-mt-4`}>
      <h2 className="text-base font-bold">{guide.title}</h2>
      {guide.addresses && <p className="mt-1 text-xs text-neutral-500">{guide.addresses}</p>}
      {guide.time && <p className="mt-1 text-xs text-neutral-500">目安: {guide.time}</p>}
      {guide.link && (
        <div className="mt-3">
          <ExternalButton href={guide.link.href} label={guide.link.label} />
          {guide.linkNote && <p className="mt-2 text-xs text-neutral-500">{guide.linkNote}</p>}
        </div>
      )}
      {guide.intro && <p className="mt-3 text-sm leading-6 text-neutral-600">{guide.intro}</p>}
      {guide.groups.map((group, gi) => {
        const start = starts[gi];
        return (
          <div key={gi} className="mt-4">
            {group.heading && <h3 className="mb-3 text-sm font-bold">{group.heading}</h3>}
            <StepList steps={group.steps} start={start} />
          </div>
        );
      })}
      {guide.notes.map((note) => (
        <p key={note} className="mt-4 text-xs leading-5 text-neutral-500">
          {note}
        </p>
      ))}
    </section>
  );
}

function Pitfall({ pitfall, n }: { pitfall: ForwardingPitfall; n: number }) {
  const [first, ...rest] = pitfall.body;
  const body = (t: string) => (
    <p key={t} className="mt-2 text-sm leading-6 text-neutral-600">
      {t}
    </p>
  );
  return (
    <div className="mt-5">
      <h3 className="text-sm font-bold">
        {n}. {pitfall.title}
      </h3>
      {first && body(first)}
      {pitfall.steps && (
        <>
          {pitfall.stepsLabel && <p className="mt-2 text-sm leading-6 text-neutral-600">{pitfall.stepsLabel}</p>}
          <ol className="mt-1 list-decimal space-y-1 pl-5 text-sm leading-6 text-neutral-600">
            {pitfall.steps.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ol>
        </>
      )}
      {pitfall.codes && (
        <>
          {pitfall.codesLead && body(pitfall.codesLead)}
          <CodeList codes={pitfall.codes} />
        </>
      )}
      {pitfall.after?.map(body)}
      {rest.map(body)}
      {pitfall.links && (
        <ul className="mt-2 flex flex-col gap-1">
          {pitfall.links.map((l) => (
            <li key={l.href}>
              <TextLink href={l.href} label={l.label} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function ForwardingGuidePage() {
  return (
    <main className="mx-auto flex w-full max-w-md flex-col gap-8 px-4 py-10">
      <div>
        <Link href="/" className="text-sm text-neutral-500">
          ← <Wordmark className="text-lg" />
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
      </section>

      {FORWARDING_GUIDES.map((g) => (
        <GuideSection key={g.id} guide={g} />
      ))}

      <section id="pitfalls" className="scroll-mt-4 rounded-2xl border border-amber-300 bg-amber-50 p-4">
        <h2 className="text-base font-bold">{PITFALLS_HEADING}</h2>
        <p className="mt-2 text-sm leading-6 text-neutral-600">{PITFALLS_LEAD}</p>
        {FORWARDING_PITFALLS.map((p, i) => (
          <Pitfall key={p.title} pitfall={p} n={i + 1} />
        ))}
      </section>

      <section className={CARD}>
        <h2 className="text-base font-bold">{FORWARDING_CHECK.heading}</h2>
        <ul className="mt-2 flex flex-col gap-1 text-sm leading-6 text-neutral-600">
          {FORWARDING_CHECK.lines.map((t) => (
            <li key={t}>{t}</li>
          ))}
        </ul>
        <Link href="/app/settings" className={`${SECONDARY_BUTTON} mt-4`}>
          {FORWARDING_CHECK_ACTION}
        </Link>
      </section>
    </main>
  );
}
