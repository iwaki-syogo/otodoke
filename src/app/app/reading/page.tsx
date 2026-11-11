import { redirect } from "next/navigation";
import { readAiReadingConsent } from "@/lib/ai-consent";
import { AI_CONSENT_TEXT } from "@/lib/ai-consent-text";
import { createClient, getUser } from "@/lib/supabase/server";
import { ReadingConsent } from "./reading-consent";

export const metadata = { title: AI_CONSENT_TEXT.title };

export default async function ReadingPage({ searchParams }: { searchParams?: Promise<{ after?: string; error?: string }> } = {}) {
  const user = await getUser();
  if (!user) redirect("/login");
  const params = await searchParams;
  const after = params?.after === "welcome" || params?.after === "settings" ? params.after : "list";
  const consent = await readAiReadingConsent(await createClient(), user.id);
  const error = params?.error === "save" ? params.error : undefined;
  if (consent === "granted" && !error) redirect(after === "welcome" ? "/app/welcome" : "/app/settings/mail-handling");
  return <ReadingConsent unknown={consent === "unknown"} error={error} after={after} />;
}
