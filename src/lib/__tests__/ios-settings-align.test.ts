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

/**
 * The iOS constant and the Web file whose source holds the same sentence. `around` is for a short word that a bare
 * substring search would find anywhere (「メール」 is in half the file): it is looked for in its own place, between the
 * pieces the Web writes around it, so a changed iOS word is caught.
 */
const WEB_SOURCES: { name: string; file: string; around?: [string, string] }[] = [
  { name: "mailGroup", file: `${WEB}/(list)/page.tsx`, around: ['label: "', '", rows: orderRows(mailRows)'] },
  { name: "accountGroup", file: `${WEB}/(list)/page.tsx`, around: ['label: "', '", rows: accountRows'] },
  { name: "privacyTitle", file: `${WEB}/(list)/page.tsx`, around: ['id: "privacy", href: "/privacy", icon: "privacy", title: "', '"'] },
  { name: "deleteTitle", file: `${WEB}/(list)/page.tsx`, around: ['id: "delete", href: "/app/settings/delete", icon: "delete", title: "', '"'] },
  { name: "keyReadFailed", file: `${WEB}/forwarding/page.tsx` },
  { name: "keyNotMade", file: `${WEB}/forwarding/page.tsx` },
  { name: "noInboundDomain", file: `${WEB}/forwarding/page.tsx` },
  // The failures that say what could not be read (L3).
  { name: "approvalReadFailed", file: `${WEB}/forwarding/page.tsx` },
  { name: "passwordKeyReadFailed", file: `${WEB}/password/page.tsx` },
  { name: "oldKeyCountFailed", file: `${WEB}/password/page.tsx` },
  { name: "unreadCountFailed", file: `${WEB}/trouble/page.tsx` },
  { name: "droppedLead", file: `${WEB}/dropped/page.tsx` },
  // The Web moved it to NO_SUBJECT_TEXT of src/lib/mail-notices.ts (dev bbea688).
  { name: "noSubject", file: "src/lib/mail-notices.ts" },
  { name: "makeKeyHeading", file: `${WEB}/password-panel.tsx` },
  { name: "makeKeyLead", file: `${WEB}/password-panel.tsx` },
  { name: "plainDropNotice", file: "src/lib/mail-notices.ts" },
  { name: "timePrefix", file: "src/components/forwarding-steps.tsx", around: ['<p className="mt-1 text-xs text-neutral-500">', "{guide.time}</p>"] },
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
      const wanted = w.around ? w.around[0] + ios! + w.around[1] : ios!;
      expect(web.includes(wanted), `${w.name} in ${w.file}`).toBe(true);
    }
  });

  it("the sentence with a number in the Web order (the dropped summary), and the note under makeKeyLead is the Web PLAINTEXT_DROP_NOTICE alone", () => {
    const summary = src.match(/droppedSummary[\s\S]*?\{\s*"([^"]+)"/)?.[1] ?? "";
    expect(pieces(summary).length).toBe(2);
    expect(hasInOrder(stripTsx(read(`${WEB}/dropped/page.tsx`)), pieces(summary))).toBe(true);
    // The iOS encrypt card is gone, so the per-count wrapper must not come back; plainDropNotice itself is checked against the Web above.
    expect(src).not.toContain("plainMailNote");
    expect(src).toContain("static let plainDropNotice");
    expect(stripTsx(read(`${WEB}/password-panel.tsx`))).toContain("{PLAINTEXT_DROP_NOTICE}");
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
    for (const n of ["makeKeyHeading"]) expect(key, n).toContain(`SettingsWebText.${n}`);
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

  it("the privacy link on the handling page says it opens Safari and does not cancel the parent's spacing; the deletion row has no note", () => {
    const pages = stripComments(read(`${SETTINGS}/SettingsPages.swift`));
    const handling = pages.match(/struct SettingsHandlingPage[\s\S]*?\n\}\n/)?.[0] ?? "";
    expect(handling).toContain("SettingsMenuText.webHint");
    expect(handling).not.toMatch(/padding\(\.top, -/);
    // The deletion has its own page now (/app/settings/delete): the row says nothing about where it is.
    expect(stripComments(read(`${SETTINGS}/SettingsMenuText.swift`))).not.toContain("deleteSubtitle");
    expect(stripComments(read(`${SETTINGS}/SettingsView.swift`))).not.toContain("deleteSubtitle");
  });

  it("the privacy link sits under 「あなたのメールの扱い」", () => {
    expect(stripComments(read(`${SETTINGS}/SettingsPages.swift`))).toMatch(/SettingsHandlingPage[\s\S]*?SettingsWeb\.open\(\.privacy/);
  });

  it("the badge on the forwarding row is the Web's 「承認待ち」, and the rows draw the new failure sentences through the constants", () => {
    expect(constant(stripComments(read(`${SETTINGS}/SettingsMenuText.swift`)), "approvalBadge")).toBe("承認待ち");
    expect(stripTsx(read(`${WEB}/(list)/page.tsx`))).toContain('text: "承認待ち"');
    const model = stripComments(read(`${SETTINGS}/SettingsModel.swift`));
    for (const n of ["unreadCountFailed", "oldKeyCountFailed", "approvalReadFailed"]) expect(model, n).toContain(`SettingsWebText.${n}`);
    expect(stripComments(read(`${SETTINGS}/SettingsKeyPage.swift`))).toContain("SettingsWebText.passwordKeyReadFailed");
    expect(stripComments(read(`${SETTINGS}/SettingsStatusRows.swift`))).toContain("SettingsWebText.unreadCountFailed");
  });

  it("negative control: the earlier bare 「読み込めませんでした」 is not what these rows say", () => {
    expect(constant(src, "unreadCountFailed")).not.toBe("読み込めませんでした");
    expect(constant(src.replace("未読のメールの数を", "未読の数を"), "unreadCountFailed")).not.toBe(constant(src, "unreadCountFailed"));
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
    // A short word is looked for in its place: a changed iOS word is caught where a bare search would pass.
    const listWeb = stripTsx(read(`${WEB}/(list)/page.tsx`));
    const group = WEB_SOURCES.find((w) => w.name === "mailGroup")!;
    const word = constant(src, "mailGroup")!;
    expect(listWeb.includes(word)).toBe(true);
    expect(listWeb.includes(group.around![0] + word + group.around![1])).toBe(true);
    // The word 「メ」 is found by a bare search (it is in 「メールの転送」), but not between the Web's own pieces.
    expect(listWeb.includes("メ")).toBe(true);
    for (const changed of ["メ", "ール", "メールX"]) expect(listWeb.includes(group.around![0] + changed + group.around![1]), `placed search for ${changed}`).toBe(false);
    // Pieces out of order are not found.
    expect(hasInOrder("<s>前{n}後</s>", ["前", "後"])).toBe(true);
    expect(hasInOrder("<s>後{n}前</s>", ["前", "後"])).toBe(false);
  });
});
