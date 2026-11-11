import type { Metadata } from "next";
import { PublicDocument } from "@/components/public-document";
import { PUBLIC_PAGE_TEXT } from "@/lib/public-pages";

export const dynamic = "force-static";
export const metadata: Metadata = { title: PUBLIC_PAGE_TEXT.terms.title };

export default function TermsPage() {
  return <PublicDocument {...PUBLIC_PAGE_TEXT.terms} current="/terms" />;
}
