import Link from "next/link";
import { Wordmark } from "@/components/wordmark";
import { PublicPageLinks } from "@/components/public-page-links";
import { PUBLIC_CONTACT_EMAIL, PUBLIC_PAGE_TEXT, type PublicSection } from "@/lib/public-pages";

/** No session, request data or client hooks: these documents have the privacy page's static layout. */
export function PublicDocument({ title, lead, sections, current }: { title: string; lead?: string; sections: readonly PublicSection[]; current: "/terms" | "/support" }) {
  return (
    <main className="mx-auto w-full max-w-md px-4 py-10">
      <Link href="/" aria-label={PUBLIC_PAGE_TEXT.home} className="-my-2 inline-flex min-h-11 items-center gap-1 py-2 text-sm text-neutral-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-900">
        <span aria-hidden="true">←</span> <Wordmark className="text-lg" />
      </Link>
      <h1 className="mt-8 text-2xl font-bold">{title}</h1>
      {lead ? <p className="mt-3 text-sm leading-6 text-neutral-700">{lead}</p> : null}
      {sections.map((section) => (
        <section key={section.title} className="mt-8">
          <h2 className="text-base font-bold">{section.title}</h2>
          <div className="mt-2 flex flex-col gap-3 rounded-2xl border border-neutral-200 bg-white p-4 text-sm leading-6 text-neutral-700">
            {section.paragraphs?.map((paragraph) => <p key={paragraph}>{paragraph}</p>)}
            {section.bullets ? <ul className="flex list-disc flex-col gap-2 pl-5">{section.bullets.map((item) => <li key={item}>{item}</li>)}</ul> : null}
            {section.contact ? <p><a href={`mailto:${PUBLIC_CONTACT_EMAIL}`} className="inline-block min-h-11 break-all py-2 font-medium text-sky-700 underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-900">{PUBLIC_CONTACT_EMAIL}</a></p> : null}
            {section.links?.map((link) => <Link key={link.href} href={link.href} className="inline-flex min-h-11 items-center py-2 font-medium text-sky-700 underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-900">{link.label}</Link>)}
          </div>
        </section>
      ))}
      <footer className="mt-8 border-t border-neutral-200 pt-3">
        <PublicPageLinks current={current} />
      </footer>
    </main>
  );
}
