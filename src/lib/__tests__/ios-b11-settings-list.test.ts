import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 1.0 (11), the settings list as the Web draws it (src/app/app/settings/(list)/page.tsx):
 * - no card above the list: the unread card lives in 「うまく届かないとき」, the approval card in 「メールの転送」,
 *   and the list says it with badges on the rows (承認待ち, 未読 N, a count that could not be read, the dropped count);
 * - the account card is 「ログイン中」, 「ログアウト」, the privacy policy, 「アカウントの削除」, in that order.
 */
const ROOT = path.resolve(__dirname, "../../..");
const read = (p: string) => (existsSync(path.join(ROOT, p)) ? readFileSync(path.join(ROOT, p), "utf8") : "");
const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"])\/\/.*$/gm, "$1");
const stripTsx = (src: string) => src.replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

const S = "ios/Otodoke/Screens/Settings";
const WEB_LIST = stripTsx(read("src/app/app/settings/(list)/page.tsx"));
const WEB_TROUBLE = stripTsx(read("src/app/app/settings/trouble/page.tsx"));
const LIST = stripComments(read(`${S}/SettingsView.swift`));
const PAGES = stripComments(read(`${S}/SettingsPages.swift`));
const ROWS = stripComments(read(`${S}/SettingsStatusRows.swift`));
const MENU = stripComments(read(`${S}/SettingsMenuText.swift`));
const WORDS = stripComments(read(`${S}/SettingsWebText.swift`));

/** The body of the list's `content` view: what is drawn on the list itself. */
const listContent = (src: string) => src.match(/private var content: some View \{[\s\S]*?\n    \}\n/)?.[0] ?? "";
const deliveryPage = (src: string) => src.match(/struct SettingsDeliveryHelpPage[\s\S]*?\n\}\n/)?.[0] ?? "";

/** What is wrong with a list: a card drawn above the rows. */
const cardProblems = (list: string) => {
  const out: string[] = [];
  if (/SettingsStatusRows|unreadSection|approvalSection/.test(listContent(list))) out.push("a card is drawn on the list");
  return out;
};

describe("the list draws no cards, the pages hold them", () => {
  it("the Web's list has badges only: the words and the rows they sit on", () => {
    expect(WEB_LIST).toContain('text: "承認待ち"');
    expect(WEB_LIST).toContain("`未読 ${waiting}`");
    expect(WEB_LIST).toContain('text: "確認できません"');
    expect(WEB_LIST).not.toContain("readWaitingMail");
  });

  it("iOS: no card on the list", () => {
    expect(listContent(LIST)).not.toBe("");
    expect(cardProblems(LIST)).toEqual([]);
  });

  it("iOS: the unread card is the first thing of 「うまく届かないとき」, as on the Web, with the none sentence", () => {
    const page = deliveryPage(PAGES);
    expect(page).not.toBe("");
    expect(page).toMatch(/SettingsParts\.page\(spacing: 16\) \{\s*SettingsStatusRows\(model: model\)/);
    expect(WEB_TROUBLE).toContain("未読のメールはありません。");
    expect(WORDS).toContain('static let unreadNone = "未読のメールはありません。"');
    expect(ROWS).toContain("SettingsWebText.unreadNone");
    expect(ROWS).toContain("ReadWaitingButton(model: model.mailActions)");
    expect(LIST).toContain("SettingsDeliveryHelpPage(model: model)");
  });

  it("iOS: the row badges say what the Web's say", () => {
    expect(MENU).toContain('static func unreadBadge(_ n: Int) -> String { "未読 \\(n)" }');
    expect(MENU).toContain('static let approvalBadge = "承認待ち"');
    expect(MENU).toContain('static let keyUnknownBadge = "確認できません"');
    expect(LIST).toMatch(/case \.dropped: Self\.droppedBadge\(for: model\)/);
    expect(LIST).toMatch(/case \.delivery: Self\.deliveryBadge\(for: model\)/);
    expect(LIST).toMatch(/case let \.loaded\(n\)\? where n > 0: \.init\(text: SettingsMenuText\.unreadBadge\(n\), kind: \.amber\)/);
    // A count that could not be read is red 確認できません, never 0 (the Web's UNKNOWN).
    expect(LIST).toMatch(/droppedBadge[\s\S]*?case \.failed\?: \.init\(text: SettingsMenuText\.keyUnknownBadge, kind: \.red\)/);
    expect(LIST).toMatch(/deliveryBadge[\s\S]*?case \.failed\?: \.init\(text: SettingsMenuText\.keyUnknownBadge, kind: \.red\)/);
  });

  it("negative control: a card put back on the list, or the card gone from the page, is caught", () => {
    const back = LIST.replace("section(SettingsWebText.mailGroup) {", "SettingsStatusRows(model: model)\n section(SettingsWebText.mailGroup) {");
    expect(cardProblems(back)).toEqual(["a card is drawn on the list"]);
    expect(cardProblems(LIST.replace("section(SettingsWebText.mailGroup) {", "unreadSection\n section(SettingsWebText.mailGroup) {"))).toEqual(["a card is drawn on the list"]);
    expect(deliveryPage(PAGES).replace("SettingsStatusRows(model: model)", "")).not.toMatch(/SettingsStatusRows\(model: model\)/);
    expect(LIST.replace("Self.deliveryBadge(for: model)", "nil")).not.toMatch(/case \.delivery: Self\.deliveryBadge/);
  });
});
