import { Fragment } from "react";
import { createClient, getUser } from "@/lib/supabase/server";
import { LogoutForm } from "../logout-form";
import { readActiveKey, readConfirmUrl, readDroppedCount, readUnreadCount } from "../settings-reads";
import { SettingsHashRedirect } from "../settings-hash-redirect";
import { RowCard, RowInfo, RowLink, orderRows, type Badge, type IconName } from "../settings-row";

export const metadata = { title: "設定" };

type LinkRow = { kind: "link"; id: string; href: string; icon: IconName; title: string; badge?: Badge | null; action?: boolean };
type Row = LinkRow | { kind: "info"; id: string; icon: IconName; title: string; value: string } | { kind: "logout"; id: string };

export default async function SettingsPage() {
  const user = (await getUser())!;
  const supabase = await createClient();
  const [{ key, failed: keyFailed }, waiting, confirmation, dropped] = await Promise.all([
    readActiveKey(supabase, "settings list"),
    readUnreadCount(supabase, "settings list"),
    readConfirmUrl(supabase, "settings list"),
    readDroppedCount(supabase, "settings list"),
  ]);

  const mailRows: LinkRow[] = [
    {
      kind: "link",
      id: "forwarding",
      href: "/app/settings/forwarding",
      icon: "forwarding",
      title: "メールの転送",
      badge: confirmation.url ? { text: "承認待ち", tone: "amber" } : null,
      action: Boolean(confirmation.url),
    },
    {
      kind: "link",
      id: "password",
      href: "/app/settings/password",
      icon: "password",
      title: "パスワードとメールの鍵",
      // Not knowing is not "no key": a failed read shows no badge.
      badge: !keyFailed && !key ? { text: "未設定", tone: "amber" } : null,
      action: !keyFailed && !key,
    },
    {
      kind: "link",
      id: "dropped",
      href: "/app/settings/dropped",
      icon: "dropped",
      title: "読まなかったメール",
      // A count that failed is shown as no count, never as 0.
      badge: dropped === null ? null : { text: dropped.toLocaleString("ja-JP"), tone: "neutral" },
    },
    { kind: "link", id: "mail-handling", href: "/app/settings/mail-handling", icon: "handling", title: "あなたのメールの扱い" },
    {
      kind: "link",
      id: "trouble",
      href: "/app/settings/trouble",
      icon: "trouble",
      title: "うまく届かないとき",
      badge: waiting ? { text: `未読 ${waiting}`, tone: "amber" } : null,
      action: Boolean(waiting),
    },
    { kind: "link", id: "demo", href: "/app/settings/demo", icon: "demo", title: "サンプルで試す" },
  ];

  const accountRows: Row[] = [
    { kind: "info", id: "login", icon: "login", title: "ログイン中", value: user.email ?? "" },
    { kind: "logout", id: "logout" },
    { kind: "link", id: "privacy", href: "/privacy", icon: "privacy", title: "プライバシーポリシー" },
    { kind: "link", id: "delete", href: "/app/settings/delete", icon: "delete", title: "アカウントの削除" },
  ];

  const groups: { label: string; rows: Row[] }[] = [
    { label: "メール", rows: orderRows(mailRows) },
    { label: "アカウント", rows: accountRows },
  ];

  return (
    <div className="flex flex-col gap-8">
      <SettingsHashRedirect />
      <h1 className="text-xl font-bold">設定</h1>
      {groups.map((group) => (
        <section key={group.label} className="flex flex-col gap-2">
          <h2 className="px-1 text-xs text-neutral-500">{group.label}</h2>
          <RowCard>
            {group.rows.map((row) =>
              row.kind === "link" ? (
                <RowLink key={row.id} href={row.href} icon={row.icon} title={row.title} badge={row.badge} />
              ) : row.kind === "info" ? (
                <RowInfo key={row.id} icon={row.icon} title={row.title} value={row.value} />
              ) : (
                <Fragment key={row.id}>
                  <LogoutForm />
                </Fragment>
              ),
            )}
          </RowCard>
        </section>
      ))}
    </div>
  );
}
