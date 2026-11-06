import Link from "next/link";

/** 「‹ 設定」: the way back to the list, with a tap target taller than its text. */
export function BackToSettings() {
  return (
    <Link href="/app/settings" className="-ml-2 inline-flex min-h-11 items-center self-start px-2 text-sm text-neutral-600">
      ‹ 設定
    </Link>
  );
}

/** The frame of a page opened from the 設定 list: back link, title, then the content. */
export function SubPage({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <BackToSettings />
      <h1 className="text-xl font-bold">{title}</h1>
      <div className="mt-4 flex flex-col gap-8">{children}</div>
    </div>
  );
}

/** 「ログイン中: …」: whose account this is, shown beside what is private to it (the address, the password). */
export function LoggedInAs({ email }: { email: string | undefined }) {
  return <p className="text-xs text-neutral-500">ログイン中: <span className="break-all font-medium text-neutral-700">{email}</span></p>;
}
