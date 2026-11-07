import { CopyButton } from "@/components/copy-button";
import { PausableVideo } from "@/components/pausable-video";
import { GMAIL_FILTER, VIDEO_CREDIT, VIDEO_LABEL, type ForwardingGroup, type ForwardingGuide, type ForwardingPitfall } from "@/lib/forwarding-guide";

/**
 * Pieces shared by the public guide (/guide/forwarding) and the settings pages: they render the
 * words of src/lib/forwarding-guide.ts and add none of their own.
 */

export function TextLink({ href, label }: { href: string; label: string }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="text-sm leading-6 text-sky-700 underline">
      {label}
    </a>
  );
}

/** The Gmail filter's search words with a copy button: step 5 of the Gmail guide and the approval card. */
export function GmailFilterCopy() {
  return (
    <div className="mt-2 flex items-center gap-2 rounded-xl bg-neutral-50 p-2">
      <code className="min-w-0 flex-1 break-all text-xs">{GMAIL_FILTER}</code>
      <CopyButton text={GMAIL_FILTER} />
    </div>
  );
}

/** Under 「承認ページを開く」 in the yellow approval card (settings and welcome): the filter to copy before going back to Gmail. */
export function ApprovalFilterCopy() {
  return (
    <div className="mt-4">
      <p className="text-sm leading-6">フィルタをまだ作っていなければ、「含む」に貼るこの文字列をコピーして Gmail に戻ります。</p>
      <GmailFilterCopy />
    </div>
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
              <GmailFilterCopy />
            )}
          </div>
        </li>
      ))}
    </ol>
  );
}

/** The groups of a guide: steps numbered straight through all groups. */
export function GuideGroups({ groups }: { groups: ForwardingGroup[] }) {
  const starts = groups.map((_, i) => 1 + groups.slice(0, i).reduce((n, g) => n + g.steps.length, 0));
  return (
    <>
      {groups.map((group, gi) => (
        <div key={gi} className="mt-4">
          {group.heading && <h3 className="mb-3 text-sm font-bold">{group.heading}</h3>}
          <StepList steps={group.steps} start={starts[gi]} />
        </div>
      ))}
    </>
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

/** Everything of a pitfall below its title. */
export function PitfallBody({ pitfall }: { pitfall: ForwardingPitfall }) {
  const [first, ...rest] = pitfall.body;
  const body = (t: string) => (
    <p key={t} className="mt-2 text-sm leading-6 text-neutral-600">
      {t}
    </p>
  );
  return (
    <>
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
    </>
  );
}

const CHEVRON = (
  <svg className="shrink-0 transition-transform group-open:rotate-180" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M6 9l6 6 6-6" />
  </svg>
);

/** A white card that opens: the title always shows, the rest after a tap. */
export function FoldCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <details className="group rounded-2xl border border-neutral-200 bg-white">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-4 py-3 text-sm font-medium [&::-webkit-details-marker]:hidden">
        {title}
        {CHEVRON}
      </summary>
      <div className="border-t border-neutral-100 px-4 py-3">{children}</div>
    </details>
  );
}

/** The explainer video of a guide: plays in place; the length is rounded to the nearest half minute (iOS: ForwardingGuideVideo.swift). */
export function GuideVideo({ video, title }: { video: NonNullable<ForwardingGuide["video"]>; title: string }) {
  const halves = Math.max(0.5, Math.round(video.seconds / 30) / 2);
  const minutes = Number.isInteger(halves) ? `${halves} 分` : halves < 1 ? "半分" : `${Math.floor(halves)} 分半`;
  return (
    <div className="mt-4">
      <h3 className="text-sm font-bold">
        {VIDEO_LABEL}・約 {minutes}
      </h3>
      <PausableVideo controls preload="none" playsInline poster={video.poster} width={720} height={1280} aria-label={`${title} の転送の設定の動画`} className="mx-auto mt-2 block h-auto w-56 rounded-2xl border border-neutral-200 bg-white">
        <source src={video.src} type="video/mp4" />
      </PausableVideo>
    </div>
  );
}

/** The terms of the voice and the music in the videos, once under a list of guides. */
export function VideoCredit() {
  return <p className="mt-3 text-xs text-neutral-500">{VIDEO_CREDIT}</p>;
}

/** What a service's card shows when opened (settings and welcome): the video comes before any step. */
export function GuideCardBody({ guide }: { guide: ForwardingGuide }) {
  return (
    <>
      {guide.addresses && <p className="text-xs text-neutral-500">{guide.addresses}</p>}
      {guide.time && <p className="mt-1 text-xs text-neutral-500">目安: {guide.time}</p>}
      {guide.video && <GuideVideo video={guide.video} title={guide.title} />}
      {guide.intro && <p className="mt-3 text-sm leading-6 text-neutral-600">{guide.intro}</p>}
      {guide.link && (
        <div className="mt-2">
          <TextLink href={guide.link.href} label={guide.link.label} />
          {guide.linkNote && <p className="text-xs text-neutral-500">{guide.linkNote}</p>}
        </div>
      )}
      <GuideGroups groups={guide.groups} />
      {guide.notes.map((note) => (
        <p key={note} className="mt-4 text-xs leading-5 text-neutral-500">
          {note}
        </p>
      ))}
    </>
  );
}
