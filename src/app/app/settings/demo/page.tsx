import { demoCount, settingsErrorMessage } from "@/lib/settings-errors";
import { DemoLoader } from "../demo-loader";
import { SubPage } from "../sub-page";
import { getUser } from "@/lib/supabase/server";
import { redirect } from "next/navigation";

export const metadata = { title: "サンプルで試す" };

// The demo loader does not call Claude (the extractions are precomputed); maxDuration stays 300
// because 97 mails go through the pipeline one by one.
export const maxDuration = 300;

type SearchParams = Promise<{ demo?: string; error?: string; cleared?: string }>;

export default async function DemoPage({ searchParams }: { searchParams: SearchParams }) {
  const user = await getUser();
  if (!user) redirect("/login");
  const { demo, error, cleared } = await searchParams;
  // Only fixed words reach the page: ?error= is a code, ?demo= a number.
  const errorMessage = settingsErrorMessage(error);
  const demoLoaded = demoCount(demo);

  return (
    <SubPage title="サンプルで試す">
      <section id="demo" className="scroll-mt-4 rounded-2xl border border-dashed border-neutral-300 p-4">
        <p className="text-sm leading-6 text-neutral-600">匿名化した実際の注文・発送メールと、見本として作った 1 年分の注文を読み込みます。日付は、読み込んだ日に合わせてずらします。</p>
        <DemoLoader userId={user.id} loaded={demoLoaded} error={errorMessage} cleared={Boolean(cleared)} />
      </section>
    </SubPage>
  );
}
