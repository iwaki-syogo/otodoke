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
    expect(page).toMatch(/SettingsParts\.page\(spacing: 16\) \{\s*SettingsStatusRows\(model: model(?:, register: register)?\)/);
    expect(WEB_TROUBLE).toContain("未読のメールはありません。");
    expect(WORDS).toContain('static let unreadNone = "未読のメールはありません。"');
    expect(ROWS).toContain("SettingsWebText.unreadNone");
    expect(ROWS).toContain("ReadWaitingButton(model: model.mailActions)");
    expect(LIST).toContain("SettingsDeliveryHelpPage(model: model, register: register)");
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
    expect(back).not.toBe(LIST);
    expect(cardProblems(back)).toEqual(["a card is drawn on the list"]);
    const unread = LIST.replace("section(SettingsWebText.mailGroup) {", "unreadSection\n section(SettingsWebText.mailGroup) {");
    expect(unread).not.toBe(LIST);
    expect(cardProblems(unread)).toEqual(["a card is drawn on the list"]);
    const gone = deliveryPage(PAGES).replace("SettingsStatusRows(model: model, register: register)", "");
    expect(gone).not.toBe(deliveryPage(PAGES));
    expect(gone).not.toMatch(/SettingsStatusRows\(model: model(?:, register: register)?\)/);
    const nobadge = LIST.replace("Self.deliveryBadge(for: model)", "nil");
    expect(nobadge).not.toBe(LIST);
    expect(nobadge).not.toMatch(/case \.delivery: Self\.deliveryBadge/);
  });
});

describe("the account card is the Web's, in the Web's order", () => {
  /** The ids of the Web's accountRows, in the order they are written. */
  const webOrder = (src: string) => {
    const block = src.match(/const accountRows: Row\[\] = \[([\s\S]*?)\n  \];/)?.[1] ?? "";
    return [...block.matchAll(/id: "([a-z]+)"/g)].map((m) => m[1]);
  };
  /** What the iOS account section draws, in order (the Web's rows, with the full privacy policy in an app sheet). */
  const iosOrder = (src: string) => {
    const block = src.match(/section\(SettingsWebText\.accountGroup\) \{([\s\S]*?)\n                    \}\n/)?.[1] ?? "";
    const names: Record<string, string> = { loginRow: "login", logoutRow: "logout", privacyRow: "privacy", "row(.deleteAccount": "delete" };
    return [...block.matchAll(/loginRow|logoutRow|privacyRow|row\(\.deleteAccount/g)].map((m) => names[m[0]]);
  };

  it("the Web's order is read: ログイン中, ログアウト, プライバシーポリシー, アカウントの削除", () => {
    expect(webOrder(WEB_LIST)).toEqual(["login", "logout", "privacy", "delete"]);
  });

  it("iOS draws the same four, in one card, with native deletion", () => {
    expect(iosOrder(LIST)).toEqual(webOrder(WEB_LIST));
    expect(LIST).not.toContain("webRow(.openWeb");
    // One card: the section holds a single SettingsCard, and the old footer outside of it is gone.
    const block = LIST.match(/section\(SettingsWebText\.accountGroup\) \{([\s\S]*?)\n                    \}\n/)?.[1] ?? "";
    expect(block.match(/SettingsCard\(\)/g)?.length).toBe(1);
    expect(LIST).not.toMatch(/private var footer/);
    expect(LIST).not.toContain("Text(\"ログイン中:");
    expect(LIST).toContain("SettingsWebText.loginTitle");
    expect(LIST).toContain("SettingsWebText.logoutTitle");
    // The press is unchanged.
    expect(LIST).toMatch(/Task \{ await model\.signOut\(\) \}/);
  });

  it("negative control: the old order (the exits first, logout outside), or an unreadable block, is caught", () => {
    const swapped = LIST.replace("loginRow\n                            Divider().padding(.leading, 58)\n                            logoutRow", "logoutRow\n                            Divider().padding(.leading, 58)\n                            loginRow");
    expect(swapped).not.toBe(LIST);
    expect(iosOrder(swapped)).not.toEqual(iosOrder(LIST));
    expect(iosOrder(swapped)).toEqual(["logout", "login", "privacy", "delete"]);
    expect(LIST.replace("accountGroup", "other")).not.toBe(LIST);
    expect(iosOrder(LIST.replace("accountGroup", "other"))).toEqual([]);
    expect(WEB_LIST.replace("const accountRows", "const rows")).not.toBe(WEB_LIST);
    expect(webOrder(WEB_LIST.replace("const accountRows", "const rows"))).toEqual([]);
  });
});

describe("the badges of the 「メールの転送」 and key rows: each branch, in the Web's words and tones", () => {
  const fn = (name: string) => LIST.match(new RegExp(`static func ${name}\\(for model: SettingsModel\\) -> SettingsRow\\.Badge\\? \\{[\\s\\S]*?\\n    \\}\\n`))?.[0] ?? "";
  const forward = () => fn("forwardBadge");
  const key = () => fn("keyBadge");
  const FAILED = "if model.approvalBadgeFailed { return .init(text: SettingsMenuText.keyUnknownBadge, kind: .red) }";
  const WAITING = "if model.approvalWaiting { return .init(text: SettingsMenuText.approvalBadge, kind: .amber) }";

  it("the Web's two forwarding badges: 確認できません in red, 承認待ち in amber", () => {
    expect(WEB_LIST).toContain('const UNKNOWN: Badge = { text: "確認できません", tone: "red" }');
    expect(WEB_LIST).toContain('confirmation.failed ? UNKNOWN : confirmation.waiting ? { text: "承認待ち", tone: "amber" } : null');
    expect(MENU).toContain('static let keyUnknownBadge = "確認できません"');
    expect(MENU).toContain('static let approvalBadge = "承認待ち"');
  });

  it("forwardBadge: a failed read first (red), then waiting (amber), else none, in the Web's order", () => {
    const body = forward();
    expect(body).not.toBe("");
    expect(body).toContain(FAILED);
    expect(body).toContain(WAITING);
    expect(body.indexOf(FAILED)).toBeLessThan(body.indexOf(WAITING));
    expect(body).toMatch(/return nil\n    \}\n$/);
  });

  it("keyBadge: no key is amber 未設定, a count that could not be read is red, a key that is fine has none", () => {
    expect(WEB_LIST).toContain('keyFailed ? UNKNOWN : !key ? { text: "未設定", tone: "amber" } : null');
    const body = key();
    expect(body).not.toBe("");
    expect(body).toContain("return .init(text: SettingsMenuText.keyNoneBadge, kind: .amber)");
    expect(body).toContain("if case .failed = oldKeyCount { return .init(text: SettingsMenuText.keyUnknownBadge, kind: .red) }");
    expect(body).toMatch(/case \.failed\?, nil:\n\s+return nil/);
    expect(MENU).toContain('static let keyNoneBadge = "未設定"');
  });

  it("negative control: a swapped tone, a swapped order, a lost branch and an unreadable function are caught", () => {
    const body = forward();
    const tone = body.replace(FAILED, FAILED.replace("kind: .red", "kind: .amber"));
    expect(tone).not.toBe(body);
    expect(tone).not.toContain(FAILED);
    const swapped = body.replace(FAILED, "@@").replace(WAITING, FAILED).replace("@@", WAITING);
    expect(swapped).not.toBe(body);
    expect(swapped.indexOf(FAILED)).toBeGreaterThan(swapped.indexOf(WAITING));
    const lost = body.replace(WAITING, "");
    expect(lost).not.toBe(body);
    expect(lost).not.toContain(WAITING);
    const none = key().replace("kind: .amber", "kind: .red");
    expect(none).not.toBe(key());
    expect(none).not.toContain("keyNoneBadge, kind: .amber");
    const renamed = LIST.replace("static func forwardBadge", "static func forwardBadgeX");
    expect(renamed).not.toBe(LIST);
    expect(renamed.match(/static func forwardBadge\(/)).toBeNull();
  });
});
