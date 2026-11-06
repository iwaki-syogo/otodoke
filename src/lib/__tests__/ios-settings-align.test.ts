import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The settings words iOS copied from the Web's dev branch (origin/dev 173667c, src/app/app/settings/ and
 * src/lib/mail-notices.ts), pinned here. Those Web files are not in this branch yet, so this test fixes the
 * iOS constants to the sentences as they stand on dev. WHEN dev IS MERGED into this branch: replace WORDS
 * below by reading each sentence from the Web file named in `web` (and drop the literals), so that iOS and
 * the Web are compared and not just pinned.
 */

const ROOT = path.resolve(__dirname, "../../..");
const read = (p: string) => (existsSync(path.join(ROOT, p)) ? readFileSync(path.join(ROOT, p), "utf8") : "");
const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"])\/\/.*$/gm, "$1");

const SETTINGS = "ios/Otodoke/Screens/Settings";
const WORDS = `${SETTINGS}/SettingsWebText.swift`;

/** The iOS constant, the sentence, and where it stands on the Web (file:line on origin/dev, under src/app/app/settings/). */
const WORDS_TABLE: { name: string; text: string; web: string }[] = [
  { name: "mailGroup", text: "メール", web: "(list)/page.tsx:73" },
  { name: "accountGroup", text: "アカウント", web: "(list)/page.tsx:74" },
  { name: "privacyTitle", text: "プライバシーポリシー", web: "(list)/page.tsx:68" },
  { name: "deleteTitle", text: "アカウントの削除", web: "(list)/page.tsx:69" },
  { name: "keyReadFailed", text: "メールの鍵を読み込めなかったので、アドレスを出せませんでした。ページを読み込み直してください。", web: "forwarding/page.tsx:24" },
  { name: "keyNotMade", text: "メールの鍵を作ると、ここに出ます。サンプルは鍵なしで試せます。", web: "forwarding/page.tsx:41" },
  { name: "noInboundDomain", text: "受信ドメインがまだ設定されていません。", web: "forwarding/page.tsx:35" },
  { name: "droppedLead", text: "広告など、買い物に関係なさそうなメールです。本文は保存せず、件名と差出人のドメインだけ 14 日間残します。", web: "dropped/page.tsx:68" },
  { name: "noSubject", text: "件名はありません。", web: "dropped/page.tsx:89" },
  { name: "makeKeyHeading", text: "メールの鍵を作る", web: "password-panel.tsx:62" },
  { name: "makeKeyLead", text: "読み取った後のメールの件名・差出人・本文は、あなたのパスワードでしか開けない形で保存します。", web: "password-panel.tsx:63" },
  { name: "plainDropNotice", text: "パスワードでログインしていない場合は、11 月 14 日に件名・差出人・本文を消します。荷物は残ります。", web: "src/lib/mail-notices.ts:35" },
  { name: "timePrefix", text: "目安: ", web: "forwarding-guide.tsx:15" },
];

const constant = (src: string, name: string) => src.match(new RegExp(`static let ${name} = "([^"\\\\]*)"`))?.[1];

describe("the settings words copied from the Web's dev branch", () => {
  const src = stripComments(read(WORDS));

  it("each constant is the Web's sentence, character for character", () => {
    expect(src).not.toBe("");
    for (const w of WORDS_TABLE) expect(constant(src, w.name), `${w.name} (${w.web})`).toBe(w.text);
  });

  it("the two sentences with a number: the dropped summary and the note about mail not encrypted yet", () => {
    expect(src).toContain('"荷物のメールが混ざっていないか、\\(n) 通を見る"'); // dropped/page.tsx:84
    expect(src).toContain('"暗号化されていない保存済みのメール \\(n) 通も、鍵を作ったあとに暗号化できます。それまでは運営者が読める形です。"');// password-panel.tsx:66
    expect(src).toMatch(/plainMailNote[\s\S]*?\+ plainDropNotice/); // PLAINTEXT_DROP_NOTICE follows with no space
  });

  it("the key badge is 未設定 (the list page's badge, (list)/page.tsx:40)", () => {
    expect(constant(stripComments(read(`${SETTINGS}/SettingsMenuText.swift`)), "keyNoneBadge")).toBe("未設定");
  });

  it("the views use the constants: none of the old sentences is left anywhere in ios/", () => {
    const old = [
      "件名だけ 14 日間残します",
      "（件名なし）",
      "荷物のメールが混ざっていないか見る",
      "鍵ができると、ここに出ます",
      "「鍵を読み込めなかったので",
      "（受信ドメイン設定前）",
      "運営者もデータベースからは読めません。\")",
      "決めたあとに暗号化できます",
      "何も設定せずにログアウトしてください",
      "\"鍵なし\"",
    ];
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
        const rel = `${dir}/${e.name}`;
        if (e.isDirectory()) walk(rel);
        else if (e.name.endsWith(".swift") && !rel.includes("/OtodokeTests/") && !rel.includes("/OtodokeUITests/")) files.push(rel);
      }
    };
    walk("ios/Otodoke");
    expect(files.length).toBeGreaterThan(20);
    const all = files.map((f) => stripComments(read(f))).join("\n");
    for (const s of old) expect(all, s).not.toContain(s);
  });

  it("the pages draw these words through the constants", () => {
    const pages = stripComments(read(`${SETTINGS}/SettingsPages.swift`));
    for (const n of ["keyReadFailed", "keyNotMade", "droppedLead", "droppedSummary", "noSubject", "privacyTitle"]) expect(pages, n).toContain(`SettingsWebText.${n}`);
    const key = stripComments(read(`${SETTINGS}/SettingsKeyPage.swift`));
    for (const n of ["makeKeyHeading", "makeKeyLead", "plainMailNote"]) expect(key, n).toContain(`SettingsWebText.${n}`);
    expect(key).toMatch(/if case \.failed = plainCount \{\s*SettingsParts\.errorBox\(SettingsModel\.plainCountFailedText\)/);
    expect(stripComments(read(`${SETTINGS}/SettingsModel.swift`))).toContain("SettingsWebText.noInboundDomain");
    const view = stripComments(read(`${SETTINGS}/SettingsView.swift`));
    for (const n of ["mailGroup", "accountGroup", "privacyTitle", "deleteTitle"]) expect(view, n).toContain(`SettingsWebText.${n}`);
  });

  it("the list: メール holds the samples, アカウント holds privacy, deletion and the Web, and the footer has no bracketed note", () => {
    const view = stripComments(read(`${SETTINGS}/SettingsView.swift`));
    expect(view).toMatch(/section\(SettingsWebText\.mailGroup\)[\s\S]*?\.delivery, \.sample\]/);
    expect(view).toMatch(/section\(SettingsWebText\.accountGroup\)[\s\S]*?\.privacy[\s\S]*?\.deleteAccount[\s\S]*?\.openWeb/);
    expect(view).not.toContain("ログアウトしてください");
  });

  it("the privacy link sits under 「あなたのメールの扱い」, and the deletion goes to /app/settings for now with its future page in a comment", () => {
    expect(stripComments(read(`${SETTINGS}/SettingsPages.swift`))).toMatch(/SettingsHandlingPage[\s\S]*?SettingsWeb\.open\(\.privacy/);
    const web = read("ios/Otodoke/Screens/Shared/OpenWeb.swift");
    expect(stripComments(web)).toContain('static let accountDeletion = page("/app/settings")');
    expect(stripComments(web)).toContain('static let privacy = page("/privacy")');
    for (const dest of ["/app/settings/password", "/app/settings/trouble", "/app/settings/dropped", "/app/settings/demo", "/app/settings/delete"]) {
      expect(web, dest).toContain(dest);
    }
  });

  it("negative control: a changed sentence is caught", () => {
    const changed = src.replace("件名と差出人のドメインだけ", "件名だけ");
    expect(constant(changed, "droppedLead")).not.toBe(WORDS_TABLE.find((w) => w.name === "droppedLead")!.text);
  });
});
