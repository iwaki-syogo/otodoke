import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The settings words iOS copied from the Web (src/app/app/settings/ and src/lib/mail-notices.ts, merged from
 * origin/dev). Each iOS constant is read from SettingsWebText.swift and looked for in the Web file named in
 * WEB_SOURCES (comments stripped), so iOS is compared with the Web's own source and not pinned to a copy in this test.
 * The two sentences with a number are looked for piece by piece, in order, with the Web's `{...}` between the pieces.
 */

const ROOT = path.resolve(__dirname, "../../..");
const read = (p: string) => (existsSync(path.join(ROOT, p)) ? readFileSync(path.join(ROOT, p), "utf8") : "");
const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"])\/\/.*$/gm, "$1");

const SETTINGS = "ios/Otodoke/Screens/Settings";
const WORDS = `${SETTINGS}/SettingsWebText.swift`;

const WEB = "src/app/app/settings";

/** The iOS constant and the Web file whose source holds the same sentence. */
const WEB_SOURCES: { name: string; file: string }[] = [
  { name: "mailGroup", file: `${WEB}/(list)/page.tsx` },
  { name: "accountGroup", file: `${WEB}/(list)/page.tsx` },
  { name: "privacyTitle", file: `${WEB}/(list)/page.tsx` },
  { name: "deleteTitle", file: `${WEB}/(list)/page.tsx` },
  { name: "keyReadFailed", file: `${WEB}/forwarding/page.tsx` },
  { name: "keyNotMade", file: `${WEB}/forwarding/page.tsx` },
  { name: "noInboundDomain", file: `${WEB}/forwarding/page.tsx` },
  { name: "droppedLead", file: `${WEB}/dropped/page.tsx` },
  // The Web moved it to NO_SUBJECT_TEXT of src/lib/mail-notices.ts (dev bbea688).
  { name: "noSubject", file: "src/lib/mail-notices.ts" },
  { name: "makeKeyHeading", file: `${WEB}/password-panel.tsx` },
  { name: "makeKeyLead", file: `${WEB}/password-panel.tsx` },
  { name: "plainDropNotice", file: "src/lib/mail-notices.ts" },
  { name: "timePrefix", file: `${WEB}/forwarding-guide.tsx` },
];

/** A TSX / TS source without its comments (a sentence that only stands in a comment is not the Web's). */
const stripTsx = (src: string) => src.replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

/** The pieces appear in this order in the source, whatever sits between them (a `{...}` of the Web's). */
const hasInOrder = (src: string, pieces: string[]) => {
  let at = 0;
  for (const piece of pieces) {
    const i = src.indexOf(piece, at);
    if (i < 0) return false;
    at = i + piece.length;
  }
  return true;
};

/** The iOS sentence with a number, cut at its `\\(n)` into the pieces the Web draws around its own `{...}`. */
const pieces = (swiftLiteral: string) => swiftLiteral.split(/\\\(\w+\)/);

const constant = (src: string, name: string) => src.match(new RegExp(`static let ${name} = "([^"\\\\]*)"`))?.[1];

describe("the settings words copied from the Web's dev branch", () => {
  const src = stripComments(read(WORDS));

  it("each constant is the Web's sentence, found in the Web's own source (character for character)", () => {
    expect(src).not.toBe("");
    for (const w of WEB_SOURCES) {
      const ios = constant(src, w.name);
      expect(ios, `SettingsWebText.${w.name}`).toBeTruthy();
      const web = stripTsx(read(w.file));
      expect(web, w.file).not.toBe("");
      expect(web.includes(ios!), `${w.name} in ${w.file}`).toBe(true);
    }
  });

  it("the two sentences with a number, piece by piece in the Web's order: the dropped summary and the note about mail not encrypted yet", () => {
    const summary = src.match(/droppedSummary[\s\S]*?\{\s*"([^"]+)"/)?.[1] ?? "";
    expect(pieces(summary).length).toBe(2);
    expect(hasInOrder(stripTsx(read(`${WEB}/dropped/page.tsx`)), pieces(summary))).toBe(true);
    const note = src.match(/plainMailNote[\s\S]*?\{\s*"([^"]+)"/)?.[1] ?? "";
    expect(pieces(note).length).toBe(2);
    expect(hasInOrder(stripTsx(read(`${WEB}/password-panel.tsx`)), pieces(note))).toBe(true);
    // PLAINTEXT_DROP_NOTICE follows with no space (the Web's `{PLAINTEXT_DROP_NOTICE}` right after the sentence).
    expect(src).toMatch(/plainMailNote[\s\S]*?\+ plainDropNotice/);
    expect(stripTsx(read(`${WEB}/password-panel.tsx`))).toMatch(/それまでは運営者が読める形です。\{PLAINTEXT_DROP_NOTICE\}/);
  });

  it("the key badge is 未設定, the one on the Web's list page", () => {
    const badge = constant(stripComments(read(`${SETTINGS}/SettingsMenuText.swift`)), "keyNoneBadge");
    expect(badge).toBe("未設定");
    expect(stripTsx(read(`${WEB}/(list)/page.tsx`))).toContain(`"${badge}"`);
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

  it("the privacy link on the handling page says it opens Safari and does not cancel the parent's spacing; the deletion row says where it is", () => {
    const pages = stripComments(read(`${SETTINGS}/SettingsPages.swift`));
    const handling = pages.match(/struct SettingsHandlingPage[\s\S]*?\n\}\n/)?.[0] ?? "";
    expect(handling).toContain("SettingsMenuText.webHint");
    expect(handling).not.toMatch(/padding\(\.top, -/);
    expect(constant(stripComments(read(`${SETTINGS}/SettingsMenuText.swift`)), "deleteSubtitle")).toBe("Web の設定の一番下にあります");
    expect(stripComments(read(`${SETTINGS}/SettingsView.swift`))).toContain("SettingsMenuText.deleteSubtitle");
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

  it("negative control: a changed iOS sentence, a sentence only in a Web comment, and a swapped piece order are all caught", () => {
    const web = stripTsx(read(`${WEB}/dropped/page.tsx`));
    const lead = constant(src, "droppedLead")!;
    expect(web.includes(lead)).toBe(true);
    const changed = constant(src.replace("件名と差出人のドメインだけ", "件名だけ"), "droppedLead")!;
    expect(web.includes(changed)).toBe(false);
    // A sentence standing only in a comment is not the Web's.
    expect(stripTsx(`// ${lead}\nconst a = 1;`).includes(lead)).toBe(false);
    expect(stripTsx(`{/* ${lead} */}\n<p/>`).includes(lead)).toBe(false);
    expect(stripTsx(`<p>${lead}</p>`).includes(lead)).toBe(true);
    // Pieces out of order are not found.
    expect(hasInOrder("<s>前{n}後</s>", ["前", "後"])).toBe(true);
    expect(hasInOrder("<s>後{n}前</s>", ["前", "後"])).toBe(false);
  });
});
