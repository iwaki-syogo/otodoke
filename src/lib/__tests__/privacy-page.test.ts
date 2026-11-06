import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { PLAINTEXT_DROP_NOTICE, RESET_LOSES_MAIL } from "@/lib/mail-notices";
import { findAll, parseHtml, textOf, type HtmlNode } from "./html-tree";
import { appSourceFiles, read as readSource, withoutComments } from "./source-scan";

/**
 * [Review 2026-11-06 E-4] The privacy policy at /privacy, readable before signing in.
 *
 * - A static page: nothing from the database, the cookies or the request.
 * - Who runs Otodoke (no person's name), what is kept and why, how a mail is screened, read,
 *   sealed and backed up, which outside services hold what and where, how to delete, where to write.
 * - The owner's wording rules: 「データベースからは読めません」 only of sealed mail; never 「絶対」,
 *   「知り得ない」 or 「転送するだけ」; no brackets.
 * - The contact address comes from one constant, CONTACT_EMAIL (Otodoke's support address). The page
 *   is rendered with a probe value in its place, so a hard-coded address fails.
 * - Where a sentence states what other code does (「これは荷物」, the cookies, the record of sent
 *   mail, what account deletion leaves), a test here reads that code too, so the two cannot drift
 *   apart unseen. The sentences told on other screens too (11 月 14 日, what a reset costs) come
 *   from src/lib/mail-notices.ts.
 * - Password sign-in (password-v1): no passphrase, no login link, no login screen cookie.
 */

const probe = vi.hoisted(() => ({ contact: "privacy-probe@example.test" }));

vi.mock("next/link", async () => {
  const { createElement: h } = await import("react");
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const Link = ({ href, children, prefetch, ...rest }: Record<string, unknown>) => h("a", { href: String(href), ...rest }, children as never);
  return { default: Link };
});
// next/font only works inside the Next.js compiler.
vi.mock("@/components/wordmark", () => ({ Wordmark: () => "Otodoke" }));
vi.mock("@/app/privacy/contact", () => ({ CONTACT_EMAIL: probe.contact }));

const PAGE_SOURCE = path.join(process.cwd(), "src/app/privacy/page.tsx");
const CONTACT_SOURCE = path.join(process.cwd(), "src/app/privacy/contact.ts");

async function render(): Promise<HtmlNode> {
  const Page = (await import("@/app/privacy/page")).default;
  return parseHtml(renderToStaticMarkup(createElement(Page)));
}

/** The <section> under the heading `title`. */
function section(root: HtmlNode, title: string): HtmlNode {
  const found = findAll(root, (n) => n.tag === "section" && findAll(n, (h) => h.tag === "h2" && textOf(h) === title).length > 0);
  expect(found, title).toHaveLength(1);
  return found[0];
}

/** The text of each term (dt) in a section, with what it says (dd). */
function terms(root: HtmlNode): Array<[string, string]> {
  return findAll(root, (n) => n.tag === "dt").map((dt) => {
    const dd = dt.parent!.children.find((c): c is HtmlNode => typeof c !== "string" && c.tag === "dd");
    return [textOf(dt), dd ? textOf(dd) : ""];
  });
}

/** Every sentence a reader sees: each block's text, cut at 「。」. */
function sentences(root: HtmlNode): string[] {
  return findAll(root, (n) => ["h1", "h2", "p", "dt", "dd", "li"].includes(n.tag))
    .flatMap((n) => textOf(n).split("。"))
    .map((s) => s.trim())
    .filter(Boolean);
}

/** What in these sentences breaks the owner's wording rules (empty when nothing does). */
function wordingProblems(lines: string[]): string[] {
  const out: string[] = [];
  for (const line of lines) {
    for (const word of ["絶対", "知り得", "転送するだけ", "（", "）", "(", ")"]) if (line.includes(word)) out.push(`${word}: ${line}`);
    // The operator cannot read it from the database: said of sealed mail only, never of everything.
    if (line.includes("読めません") && !line.includes("暗号化したメール")) out.push(`読めません: ${line}`);
  }
  return out;
}

describe("/privacy: the page", () => {
  it("draws the policy: its title and every section, in order", async () => {
    const root = await render();
    expect(findAll(root, (n) => n.tag === "h1").map(textOf)).toEqual(["プライバシーポリシー"]);
    expect(findAll(root, (n) => n.tag === "h2").map(textOf)).toEqual([
      "運営者",
      "集める情報と使い道",
      "メールの扱い",
      "外部のサービスと置き場所",
      "保存の期間と消し方",
      "安全の対策",
      "ポリシーを変えるとき",
      "問い合わせ先",
    ]);
    expect(textOf(root)).toContain("制定日: 2026 年 11 月");
    // The page promises the day of a change (ポリシーを変えるとき): the password sign-in changed it.
    expect(textOf(section(root, "ポリシーを変えるとき"))).toContain("変えた日を書きます");
    expect(textOf(root)).toContain("改定日: 2026 年 11 月 7 日");
  });

  it("is named for the tab too", async () => {
    const { metadata } = await import("@/app/privacy/page");
    expect(metadata.title).toBe("プライバシーポリシー");
  });

  it("names the operator as 「Otodoke 運営」, and the only address on it is the contact one", async () => {
    const root = await render();
    expect(textOf(section(root, "運営者")).replace("運営者", "").trim()).toBe("Otodoke 運営");
    expect(textOf(root).match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g)).toEqual([probe.contact]);
  });
});

describe("/privacy: what it says", () => {
  it("lists what is collected, and why", async () => {
    const list = terms(section(await render(), "集める情報と使い道"));
    expect(list.map(([name]) => name)).toEqual([
      "ログインのメールアドレス",
      "パスワード",
      "転送されたメール",
      "荷物の情報と根拠の行",
      "読まなかったメールの件名と差出人のドメイン",
      "「これは荷物」で覚えた差出人",
      "確認や再設定のメールを送った記録",
      "Claude を使った回数",
      "接続の記録",
      "cookie",
    ]);
    const said = Object.fromEntries(list);
    // No login link any more: the address gets the confirmation and reset mails.
    expect(said["ログインのメールアドレス"]).toBe("確認や再設定のメールを送り、あなたのアカウントを見分けるために使います。");
    // password-v1: the browser splits the password in two and sends only the login value.
    expect(said["パスワード"]).toContain("ブラウザで、ログイン用の値とメールの鍵を開く値の 2 つに分け、ログイン用の値だけをサーバーに送ります");
    expect(said["パスワード"]).toContain("ログイン用の値は、Supabase がハッシュ値に変えて保存します");
    expect(said["読まなかったメールの件名と差出人のドメイン"]).toContain("14 日で消します");
    // What login_mail_sends keeps (migration 20261106100000): hashes and the time, pruned after an hour.
    expect(said["確認や再設定のメールを送った記録"]).toContain("ハッシュ値に変えて");
    expect(said["確認や再設定のメールを送った記録"]).toContain("どちらのアドレスも、そのままでは記録しません");
    expect(said["確認や再設定のメールを送った記録"]).toContain("1 時間を過ぎた記録");
    expect(said["接続の記録"]).toContain("障害や不正を調べるときに使うことがあります");
    // Review R3-20: the providers' logs keep the address used to log in, for as long as the plans say.
    expect(said["接続の記録"]).toContain("Supabase の記録には、ログインに使ったメールアドレスも入ります。Supabase は 7 日、Vercel は 1 日で消えます。");
  });

  it("tells what 「これは荷物」 remembers, that it still goes through Haiku, and how to remove it", async () => {
    const said = Object.fromEntries(terms(section(await render(), "集める情報と使い道")));
    const marked = said["「これは荷物」で覚えた差出人"];
    expect(marked).toContain("押したメールの差出人のドメインを覚えます");
    expect(marked).toContain("ふるいで落ちても Claude Haiku で確かめます");
    expect(marked).toContain("覚えている間は、押したメールの件名と差出人のドメインを残します");
    expect(marked).toContain("設定の「外す」で外すと、ほかと同じく 14 日で消します");
    expect(marked).toContain("Gmail など多くの人が使うドメインは覚えません");
    // Gone: a mark is no longer kept for every sender, nor read without the Haiku check.
    expect(said["読まなかったメールの件名と差出人のドメイン"]).not.toContain("これは荷物");
    expect(textOf(await render())).not.toContain("次から読むために消さずに残します");
  });

  it("names the one cookie, Supabase's login state: the login screen's address cookie went with the login link", async () => {
    const cookie = Object.fromEntries(terms(section(await render(), "集める情報と使い道"))).cookie;
    expect(cookie).toBe(
      "ログインのためだけに使います。広告やアクセス解析のための cookie は使いません。ログインの状態を保つ cookie は、Supabase のログインの仕組みが使います。ログアウトしたときと、アカウントを削除したときに消えます。",
    );
    expect(cookie).not.toContain("ログインの画面でだけ使う cookie");
    expect(cookie).not.toContain("1 時間");
  });

  it("no passphrase and no login link anywhere on the page", async () => {
    const text = textOf(await render());
    expect(text).not.toContain("合言葉");
    expect(text).not.toContain("ログインのリンク");
    // The old 「ログインのメールの送信」 and 「ログインのメールを送るとき」 (the address itself stays).
    expect(text).not.toMatch(/ログインのメール(の送信|を送る)/);
  });

  it("tells how a mail is screened, read, sealed and backed up, and what is not sealed", async () => {
    const part = section(await render(), "メールの扱い");
    const said = Object.fromEntries(terms(part));
    expect(said["ふるい"]).toContain("迷うメールと、「これは荷物」で覚えた差出人のメールだけ、件名と本文の初めの部分を Claude Haiku に送って確かめます");
    expect(said["Claude での読み取り"]).toContain("読み取る数秒のあいだ、サーバーと Claude API がメールの中身を扱います");
    expect(said["保存と暗号化"]).toContain("あなたのパスワードでしか開けない形に暗号化して保存します");
    expect(said["保存と暗号化"]).toContain("暗号化したメールは、運営者もデータベースからは読めません");
    expect(said["保存と暗号化"]).toContain("パスワードそのものは、サーバーに送りません");
    // Where the key comes from, and where an opened one stays (src/lib/crypto/tab-key.ts).
    expect(said["保存と暗号化"]).toContain("メールの鍵は、パスワードでログインしたときにブラウザで作ります");
    expect(said["保存と暗号化"]).toContain("開いた鍵は、そのタブの中にだけ置きます");
    expect(said["バックアップ"]).toContain("最大 7 日間");
    const unsealed = findAll(part, (n) => n.tag === "li").map((li) => textOf(li).split("。")[0]);
    expect(unsealed).toEqual(["荷物の情報と、根拠の行・読み取りメモ", "差出人のドメイン、メールごとの識別子、Gmail の転送の確認メールにある承認リンク", "読み取る前のメール", "Otodoke が暗号化を始める前に読み取ったメール"]);
    // A mail read once sealing began while the user has no key, that is before their first password
    // sign-in: not kept (src/lib/mail-seal.ts, "dropped").
    const noKey = said["パスワードでログインする前と、忘れたとき"];
    expect(noKey).toContain("Otodoke が暗号化を始めた後、パスワードでログインする前に読み取ったメールは、件名・差出人・本文を残しません");
    // A reset loses the mail sealed before; a change keeps it (decision 3).
    expect(noKey).toContain(`パスワードを忘れたときは、メールで再設定できます。${RESET_LOSES_MAIL}パスワードを変えるだけなら、前のメールもそのまま開けます。`);
    // Decision 7, told as the settings tell it.
    expect(textOf(findAll(part, (n) => n.tag === "li")[3])).toContain(PLAINTEXT_DROP_NOTICE);
  });

  it("names each outside service, what it does, and where its data is", async () => {
    const list = terms(section(await render(), "外部のサービスと置き場所"));
    expect(list.map(([name]) => name)).toEqual(["Supabase", "Vercel", "Resend", "Anthropic", "Cloudflare"]);
    const said = Object.fromEntries(list);
    expect(said.Supabase).toContain("東京に保存されます");
    expect(said.Vercel).toContain("東京で行います");
    expect(said.Resend).toContain("米国に保存されます");
    // It sends the confirmation and reset mails (and the iOS app's code mail): no login link.
    expect(said.Resend).toContain("メールの受信と、確認・再設定などのメールの送信です");
    expect(said.Anthropic).toContain("米国に保存され");
    expect(said.Anthropic).toContain("既定では学習に使わず、30 日以内に消す");
    expect(said.Cloudflare).toContain("ロボットの判定");
    // Turnstile's token goes with signUp, signInWithPassword and resetPasswordForEmail.
    expect(said.Cloudflare).toContain("Turnstile で、ログイン・アカウント作成・再設定の画面の操作がロボットでないかを確かめます");
    // The owner's decision (2026-11-06): no promise about handing data to others on this page.
    expect(textOf(await render())).not.toContain("渡したり売ったり");
  });

  it("tells how to delete in the settings' own words, and what can stay afterwards", async () => {
    const text = textOf(section(await render(), "保存の期間と消し方"));
    expect(text).toContain("設定の「すべての荷物を消す」で");
    // clearAllParcels (settings/actions.ts) removes parcels and mail; user_keys stays.
    expect(text).toContain("アカウント、転送先アドレス、メールの鍵と、読まなかったメール・Claude を使った回数の記録は残ります");
    expect(text).toContain("設定の「アカウントを削除」で");
    expect(text).toContain("同じアドレスがほかの人に渡らないように、アドレスの文字と作った日時だけは残します");
    // Review R3-1: a deleted account's calls stay in the day's count, with no user (20261106190000).
    expect(text).toContain("1 日の上限を守るために、Claude を使った回数も、誰のものか分からない形で日ごとに残します");
    expect(text).toContain("メールの自動転送の設定も外してください");
    expect(text).toContain("消したデータも、データベースのバックアップと接続の記録に、最大 7 日間残ります。Resend や Anthropic など各社に渡ったデータは、各社の期間が過ぎるまで残ります。");
  });

  it("the longest a deleted account stays in the logs is the longest period 接続の記録 names (R3-20)", async () => {
    const logs = Object.fromEntries(terms(section(await render(), "集める情報と使い道")))["接続の記録"];
    const days = [...logs.matchAll(/(Supabase|Vercel) は (\d+) 日/g)].map((m) => Number(m[2]));
    expect(days).toHaveLength(2);
    const stays = textOf(section(await render(), "保存の期間と消し方")).match(/バックアップと接続の記録に、最大 (\d+) 日間残ります/);
    expect(stays).not.toBeNull();
    expect(Number(stays![1])).toBe(Math.max(...days));
  });

  it("sums up the safety measures, with a link to the public code", async () => {
    const part = section(await render(), "安全の対策");
    const text = textOf(part);
    expect(text).toContain("利用者が自分のデータだけを読める設定にしています");
    expect(text).toContain("Resend の署名を確かめてから受け取ります");
    expect(text).toContain("コードはすべて GitHub で公開しています");
    expect(findAll(part, (n) => n.tag === "a").map((a) => [a.attrs.href, a.attrs.target, a.attrs.rel])).toEqual([["https://github.com/iwaki-syogo/otodoke", "_blank", "noopener noreferrer"]]);
  });

  it("names the same periods, decision 7 and what a reset costs as the settings' 「あなたのメールの扱い」", async () => {
    const { MailHandling } = await import("@/app/app/settings/mail-handling");
    const settings = textOf(parseHtml(renderToStaticMarkup(createElement(MailHandling))));
    const policy = textOf(await render());
    for (const said of ["14 日", "最大 7 日間", PLAINTEXT_DROP_NOTICE, RESET_LOSES_MAIL]) {
      expect(settings, said).toContain(said);
      expect(policy, said).toContain(said);
    }
  });

  it("decision 7 is the coordinator's sentence of 2026-11-06 22:40, ending in the notice the screens have said since that morning", () => {
    expect(PLAINTEXT_DROP_NOTICE).toBe("パスワードでログインしていない場合は、11 月 14 日に件名・差出人・本文を消します。荷物は残ります。");
    expect(PLAINTEXT_DROP_NOTICE.endsWith("11 月 14 日に件名・差出人・本文を消します。荷物は残ります。")).toBe(true);
    // The owner's rule: no brackets.
    expect(wordingProblems([PLAINTEXT_DROP_NOTICE, RESET_LOSES_MAIL])).toEqual([]);
  });
});

describe("/privacy: what it says matches the code it describes", () => {
  it("「Gmail など多くの人が使うドメインは覚えません」: such a domain is not remembered, a shop's is", async () => {
    const { isRememberableDomain, SHARED_MAIL_DOMAINS } = await import("@/lib/screen-senders");
    expect(SHARED_MAIL_DOMAINS).toContain("gmail.com");
    expect(isRememberableDomain("gmail.com")).toBe(false);
    expect(isRememberableDomain("shop.example.test")).toBe(true);
  });

  it("「ログインの状態を保つ cookie は、Supabase のログインの仕組みが使います」: no other code sets a cookie", () => {
    const setsCookie = (source: string) => /\.cookies\.set\(|cookieStore\.set\(|\(await cookies\(\)\)\.set\(|document\.cookie\s*=/.test(withoutComments(source));
    const found = appSourceFiles()
      .filter((file) => setsCookie(readSource(file)))
      .map((file) => path.relative(process.cwd(), file))
      .sort();
    // The two Supabase clients pass on the cookies Supabase asks for (setAll).
    // 🚨 src/lib/login-email-cookie.ts is the login screen's address cookie, removed by the
    // password sign-in's server side (B). Until that merge it is still here; once it is gone, take it
    // off this list: then the list is exactly the policy's one cookie.
    expect(found).toEqual(["src/lib/login-email-cookie.ts", "src/lib/supabase/server.ts", "src/proxy.ts"]);
    // Negative control: a planted cookie of the app's own is caught.
    expect(setsCookie('(await cookies()).set("seen", "1");')).toBe(true);
    expect(setsCookie('// (await cookies()).set("seen", "1");')).toBe(false);
  });

  it("「1 時間を過ぎた記録は、次に送るときに消します」: login_mail_sends keeps two hashes and the time, pruned after an hour", () => {
    const migration = withoutComments(readFileSync(path.join(process.cwd(), "supabase/migrations/20261106100000_login_mail_limit.sql"), "utf8"));
    const table = migration.match(/create table public\.login_mail_sends \(([\s\S]*?)\n\);/);
    expect(table).not.toBeNull();
    const columns = table![1]
      .split("\n")
      .map((line) => line.trim().split(/\s+/)[0])
      .filter(Boolean);
    expect(columns).toEqual(["id", "email_hash", "ip_hash", "sent_at"]);
    expect(migration).toMatch(/delete from public\.login_mail_sends[\s\S]*?sent_at < v_now - interval '1 hour'/);
  });

  it("「アドレスの文字と作った日時だけは残します」: the registry of given-out addresses has those two columns", () => {
    const migration = readFileSync(path.join(process.cwd(), "supabase/migrations/20261106170000_issued_inbox_local_parts.sql"), "utf8");
    const table = migration.match(/create table public\.issued_inbox_local_parts \(([\s\S]*?)\n\);/);
    expect(table).not.toBeNull();
    const columns = table![1]
      .split(",")
      .map((line) => line.trim().split(/\s+/)[0])
      .filter(Boolean);
    expect(columns).toEqual(["local_part", "issued_at"]);
  });
});

describe("/privacy: the owner's wording rules", () => {
  it("never 「絶対」「知り得ない」「転送するだけ」, no brackets, and 「読めません」 only of sealed mail", async () => {
    const lines = sentences(await render());
    expect(lines.length).toBeGreaterThan(40);
    expect(wordingProblems(lines)).toEqual([]);
  });

  it("negative control: the check catches each rule", () => {
    expect(wordingProblems(["絶対に安全です"])).toHaveLength(1);
    expect(wordingProblems(["運営者には知り得ません"])).toHaveLength(1);
    expect(wordingProblems(["メールを転送するだけで使えます"])).toHaveLength(1);
    expect(wordingProblems(["荷物（品名）を保存します"])).toHaveLength(2);
    expect(wordingProblems(["運営者もデータベースからは読めません"])).toHaveLength(1);
    expect(wordingProblems(["暗号化したメールは、運営者もデータベースからは読めません"])).toEqual([]);
  });
});

describe("/privacy: the contact address and the page's source", () => {
  it("shows CONTACT_EMAIL as a mail link: whatever the constant says", async () => {
    const part = section(await render(), "問い合わせ先");
    const links = findAll(part, (n) => n.tag === "a");
    expect(links.map((a) => [a.attrs.href, textOf(a)])).toEqual([[`mailto:${probe.contact}`, probe.contact]]);
  });

  it("is Otodoke's support address, kept in contact.ts only", async () => {
    const actual = await vi.importActual<typeof import("@/app/privacy/contact")>("@/app/privacy/contact");
    expect(actual.CONTACT_EMAIL).toBe("support@otodoke.app");
    expect(readFileSync(PAGE_SOURCE, "utf8")).not.toContain(actual.CONTACT_EMAIL);
    // No placeholder left behind.
    expect(readFileSync(CONTACT_SOURCE, "utf8")).not.toMatch(/TODO|example\.com/);
  });

  it("is static: no database, cookies, request or client code", () => {
    const source = readFileSync(PAGE_SOURCE, "utf8");
    for (const dynamic of ["@/lib/supabase", "cookies(", "headers(", "searchParams", "connection(", '"use client"']) expect(source, dynamic).not.toContain(dynamic);
  });
});
