import Link from "next/link";
import { MailHandling } from "../mail-handling";
import { SubPage } from "../sub-page";

export const metadata = { title: "あなたのメールの扱い" };

export default function MailHandlingPage() {
  return (
    <SubPage title="あなたのメールの扱い">
      <MailHandling hideHeading />
      {/* The whole policy, right under the summary of how mail is handled. */}
      <p className="-mt-6 text-xs text-neutral-500">
        <Link href="/privacy" className="underline underline-offset-4">
          プライバシーポリシー
        </Link>
      </p>
    </SubPage>
  );
}
