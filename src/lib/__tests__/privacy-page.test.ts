import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { findAll, parseHtml, textOf, type HtmlNode } from "./html-tree";

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
 * - Where a sentence states what other code does (「これは荷物」, the cookies, 11 月 14 日, what
 *   account deletion leaves), a test here reads that code too, so the two cannot drift apart unseen.
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

/** Decision 7, in the words 設定「あなたのメールの扱い」 uses (mail-handling.tsx). */
const DECISION_7 = "合言葉を決めていない場合は、11 月 14 日に件名・差出人・本文を消します。荷物は残ります。";

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
      "転送されたメール",
      "荷物の情報と根拠の行",
      "読まなかったメールの件名と差出人のドメイン",
      "「これは荷物」で覚えた差出人",
      "ログインのリンクを送った記録",
      "Claude を使った回数",
      "接続の記録",
      "cookie",
    ]);
    const said = Object.fromEntries(list);
    expect(said["読まなかったメールの件名と差出人のドメイン"]).toContain("14 日で消します");
    // What login_mail_sends keeps (migration 20261106100000): hashes and the time, pruned after an hour.
    expect(said["ログインのリンクを送った記録"]).toContain("ハッシュ値に変えて");
    expect(said["ログインのリンクを送った記録"]).toContain("どちらのアドレスも、そのままでは記録しません");
    expect(said["ログインのリンクを送った記録"]).toContain("1 時間を過ぎた記録");
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

  it("names both cookies: Supabase's login state, and the login screen's address for an hour", async () => {
    const cookie = Object.fromEntries(terms(section(await render(), "集める情報と使い道"))).cookie;
    expect(cookie).toContain("ログインのためだけに使います");
    expect(cookie).toContain("広告やアクセス解析のための cookie は使いません");
    expect(cookie).toContain("ログインの状態を保つ cookie は、Supabase のログインの仕組みが使います。ログアウトしたときと、アカウントを削除したときに消えます");
    // The hour first: a sign-in on another device leaves the sending browser its cookie (R3-22).
    expect(cookie).toContain("ログインのメールを送るとき、入れたアドレスと送った時刻を、ログインの画面でだけ使う cookie に入れます。1 時間で消えます。この端末でログインしたとき・ログアウトしたとき・アカウントを削除したときにも消します。");
    expect(cookie.match(/1 時間/g)).toHaveLength(1);
    // The old claim, untrue next to the login screen's cookie.
    expect(cookie).not.toContain("ログインの状態を保つためだけに使います");
  });

  it("tells how a mail is screened, read, sealed and backed up, and what is not sealed", async () => {
    const part = section(await render(), "メールの扱い");
    const said = Object.fromEntries(terms(part));
    expect(said["ふるい"]).toContain("迷うメールと、「これは荷物」で覚えた差出人のメールだけ、件名と本文の初めの部分を Claude Haiku に送って確かめます");
    expect(said["Claude での読み取り"]).toContain("読み取る数秒のあいだ、サーバーと Claude API がメールの中身を扱います");
    expect(said["保存と暗号化"]).toContain("暗号化したメールは、運営者もデータベースからは読めません");
    expect(said["保存と暗号化"]).toContain("合言葉そのものは、サーバーに送りません");
    expect(said["バックアップ"]).toContain("最大 7 日間");
    const unsealed = findAll(part, (n) => n.tag === "li").map((li) => textOf(li).split("。")[0]);
    expect(unsealed).toEqual(["荷物の情報と、根拠の行・読み取りメモ", "差出人のドメイン、メールごとの識別子、Gmail の転送の確認メールにある承認リンク", "読み取る前のメール", "Otodoke が暗号化を始める前に読み取ったメール"]);
    // A mail read once sealing began but before the passphrase: not kept (src/lib/mail-seal.ts, "dropped").
    expect(said["合言葉を決める前と、忘れたとき"]).toContain("Otodoke が暗号化を始めた後、合言葉を決める前に読み取ったメールは、件名・差出人・本文を残しません");
    // Decision 7, told as the settings tell it.
    expect(textOf(findAll(part, (n) => n.tag === "li")[3])).toContain(DECISION_7);
  });

  it("names each outside service, what it does, and where its data is", async () => {
    const list = terms(section(await render(), "外部のサービスと置き場所"));
    expect(list.map(([name]) => name)).toEqual(["Supabase", "Vercel", "Resend", "Anthropic", "Cloudflare"]);
    const said = Object.fromEntries(list);
    expect(said.Supabase).toContain("東京に保存されます");
    expect(said.Vercel).toContain("東京で行います");
    expect(said.Resend).toContain("米国に保存されます");
    expect(said.Anthropic).toContain("米国に保存され");
    expect(said.Anthropic).toContain("既定では学習に使わず、30 日以内に消す");
    expect(said.Cloudflare).toContain("ロボットの判定");
    // The owner's decision (2026-11-06): no promise about handing data to others on this page.
    expect(textOf(await render())).not.toContain("渡したり売ったり");
  });

  it("tells how to delete in the settings' own words, and what can stay afterwards", async () => {
    const text = textOf(section(await render(), "保存の期間と消し方"));
    expect(text).toContain("設定の「すべての荷物を消す」で");
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

  it("names the same periods as the settings' 「あなたのメールの扱い」", async () => {
    const { MailHandling } = await import("@/app/app/settings/mail-handling");
    const settings = textOf(parseHtml(renderToStaticMarkup(createElement(MailHandling))));
    const policy = textOf(await render());
    for (const period of ["14 日", "最大 7 日間", DECISION_7]) {
      expect(settings, period).toContain(period);
      expect(policy, period).toContain(period);
    }
  });
});

describe("/privacy: what it says matches the code it describes", () => {
  it("「Gmail など多くの人が使うドメインは覚えません」: such a domain is not remembered, a shop's is", async () => {
    const { isRememberableDomain, SHARED_MAIL_DOMAINS } = await import("@/lib/screen-senders");
    expect(SHARED_MAIL_DOMAINS).toContain("gmail.com");
    expect(isRememberableDomain("gmail.com")).toBe(false);
    expect(isRememberableDomain("shop.example.test")).toBe(true);
  });

  it("the login screen's cookie: one hour, sent to the login page only", async () => {
    const { LOGIN_EMAIL_COOKIE_PATH, LOGIN_EMAIL_MAX_AGE } = await import("@/lib/login-email-cookie");
    expect(LOGIN_EMAIL_MAX_AGE).toBe(60 * 60);
    expect(LOGIN_EMAIL_COOKIE_PATH).toBe("/login");
  });

  it("「この端末でログインしたとき・ログアウトしたとき・アカウントを削除したときにも消します」: each of those removes it", () => {
    const read = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");
    const login = read("src/app/login/actions.ts");
    const sending = login.slice(login.indexOf("export async function sendMagicLink"), login.indexOf("export async function verifyLoginCode"));
    expect(sending).toContain("await rememberLogin(");
    // Signing in by the code, by the link, signing out, deleting the account.
    expect(login.slice(login.indexOf("export async function verifyLoginCode"))).toContain("await forgetLogin();");
    for (const file of ["src/app/auth/confirm/route.ts", "src/app/auth/signout/route.ts", "src/app/app/settings/account-actions.ts"]) {
      expect(read(file), file).toContain("await forgetLogin();");
    }
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
