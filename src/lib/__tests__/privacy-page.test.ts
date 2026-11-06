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
 * - The contact address comes from one constant, CONTACT_EMAIL (a placeholder until the dedicated
 *   address exists). The page is rendered with a probe value in its place, so a hard-coded address fails.
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
      "ログインのリンクを送った記録",
      "Claude を使った回数",
      "接続の記録",
      "cookie",
    ]);
    const said = Object.fromEntries(list);
    expect(said["読まなかったメールの件名と差出人のドメイン"]).toContain("14 日で消します");
    expect(said["読まなかったメールの件名と差出人のドメイン"]).toContain("「これは荷物」と押したものは、次から読むために消さずに残します");
    // What login_mail_sends keeps (migration 20261106100000): hashes and the time, pruned after an hour.
    expect(said["ログインのリンクを送った記録"]).toContain("ハッシュ値に変えて");
    expect(said["ログインのリンクを送った記録"]).toContain("どちらのアドレスも、そのままでは記録しません");
    expect(said["ログインのリンクを送った記録"]).toContain("1 時間を過ぎた記録");
    expect(said["cookie"]).toContain("ログインの状態を保つためだけに使います");
    expect(said["cookie"]).toContain("広告やアクセス解析のための cookie は使いません");
  });

  it("tells how a mail is screened, read, sealed and backed up, and what is not sealed", async () => {
    const part = section(await render(), "メールの扱い");
    const said = Object.fromEntries(terms(part));
    expect(said["ふるい"]).toContain("迷うメールだけ、件名と本文の初めの部分を Claude Haiku に送って確かめます");
    expect(said["Claude での読み取り"]).toContain("読み取る数秒のあいだ、サーバーと Claude API がメールの中身を扱います");
    expect(said["保存と暗号化"]).toContain("暗号化したメールは、運営者もデータベースからは読めません");
    expect(said["保存と暗号化"]).toContain("合言葉そのものは、サーバーに送りません");
    expect(said["バックアップ"]).toContain("最大 7 日間");
    const unsealed = findAll(part, (n) => n.tag === "li").map((li) => textOf(li).split("。")[0]);
    expect(unsealed).toEqual(["荷物の情報と、根拠の行・読み取りメモ", "差出人のドメイン、メールごとの識別子、Gmail の転送の確認メールにある承認リンク", "読み取る前のメール", "Otodoke が暗号化を始める前に読み取ったメール"]);
    // A mail read once sealing began but before the passphrase: not kept (src/lib/mail-seal.ts, "dropped").
    expect(said["合言葉を決める前と、忘れたとき"]).toContain("Otodoke が暗号化を始めた後、合言葉を決める前に読み取ったメールは、件名・差出人・本文を残しません");
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
  });

  it("tells how to delete in the settings' own words, and what can stay afterwards", async () => {
    const text = textOf(section(await render(), "保存の期間と消し方"));
    expect(text).toContain("設定の「すべての荷物を消す」で");
    expect(text).toContain("設定の「アカウントを削除」で");
    expect(text).toContain("メールの自動転送の設定も外してください");
    expect(text).toContain("データベースのバックアップに最大 7 日間残ります");
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
    for (const period of ["14 日", "最大 7 日間"]) {
      expect(settings, period).toContain(period);
      expect(policy, period).toContain(period);
    }
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

  it("keeps the address in contact.ts only, marked to be replaced before release", async () => {
    const actual = await vi.importActual<typeof import("@/app/privacy/contact")>("@/app/privacy/contact");
    expect(actual.CONTACT_EMAIL).toMatch(/^[^\s@]+@[^\s@]+\.[^\s@]+$/);
    expect(readFileSync(PAGE_SOURCE, "utf8")).not.toContain(actual.CONTACT_EMAIL);
    expect(readFileSync(CONTACT_SOURCE, "utf8")).toContain("TODO(before release)");
  });

  it("is static: no database, cookies, request or client code", () => {
    const source = readFileSync(PAGE_SOURCE, "utf8");
    for (const dynamic of ["@/lib/supabase", "cookies(", "headers(", "searchParams", "connection(", '"use client"']) expect(source, dynamic).not.toContain(dynamic);
  });
});
