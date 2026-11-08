import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Where the iOS app still sends the user to the Web. Everything that can finish in the app does (the sample, 「読み取る」,
 * 「これは荷物」 and 「荷物を登録する」, the key as signing in again). What may still open Safari is this list and no more:
 * changing the password, deleting the account, the privacy policy, 「Web で開く」, 「パスワードを忘れた」, a parcel's tracking
 * page, the forwarding guide's video and links, the Gmail approval link, and 「Web でログイン」 when the key does not open.
 */
const ROOT = path.resolve(__dirname, "../../..");
const APP = path.join(ROOT, "ios/Otodoke");
const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"])\/\/.*$/gm, "$1");

function swiftFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...swiftFiles(full));
    else if (name.endsWith(".swift")) out.push(full);
  }
  return out;
}

const SOURCES = swiftFiles(APP).map((f) => ({ file: path.relative(ROOT, f), src: stripComments(readFileSync(f, "utf8")) }));
const read = (p: string) => (existsSync(path.join(ROOT, p)) ? stripComments(readFileSync(path.join(ROOT, p), "utf8")) : "");

/** The WebLink members used outside OpenWeb.swift. */
function webLinksUsed(sources: { file: string; src: string }[]): string[] {
  const used = new Set<string>();
  for (const { file, src } of sources) {
    if (file.endsWith("Screens/Shared/OpenWeb.swift")) continue;
    for (const m of src.matchAll(/\bWebLink\.(\w+)/g)) used.add(m[1]);
  }
  return [...used].sort();
}

/** The calls that open a URL: openURL(...), SettingsWeb.open..., a SwiftUI Link, UIApplication's open, a Safari view, a share sheet. */
const OPENS_A_URL = /\bopenURL\(|\bSettingsWeb\.open(Page)?\(|\bLink\(destination:|\bUIApplication\.shared\.open\(|\bSFSafariViewController\b|\bShareLink\b/;

/** The files that open a URL. */
function openers(sources: { file: string; src: string }[]): string[] {
  return sources
    .filter(({ src }) => OPENS_A_URL.test(src))
    .map(({ file }) => file.replace("ios/Otodoke/", ""))
    .sort();
}

const ALLOWED_WEBLINKS = ["app", "base", "privacy", "settingsDelete", "settingsPassword"];
const ALLOWED_OPENERS = [
  "Auth/LoginView.swift", // 「パスワードを忘れた」
  "Auth/TurnstileView.swift", // UIApplication.shared.open: the page the Turnstile check asks to open in a new window
  "Screens/Detail/ParcelDetailView.swift", // Link(destination: amazon): the Amazon order page, a kind of tracking page
  "Screens/Detail/TrackingLinkView.swift", // the carrier's tracking page
  "Screens/Settings/ForwardingGuideView.swift", // the guide's video and links
  "Screens/Settings/SettingsKeyPage.swift", // 「パスワードを変える」
  "Screens/Settings/SettingsPages.swift", // the privacy policy, the Gmail approval link
  "Screens/Settings/SettingsParts.swift", // SettingsWeb itself (the one place a settings button hands a page to openURL)
  "Screens/Settings/SettingsStatusRows.swift", // the Gmail approval link
  "Screens/Settings/SettingsView.swift", // 「Web で開く」, privacy, 「アカウントの削除」
  "Screens/Shared/UnlockView.swift", // 「Web でログイン」 when the key does not open
].sort();

describe("the iOS app opens the Web only for the things that must be there", () => {
  it("only the allowed WebLink members are used", () => {
    expect(webLinksUsed(SOURCES).length).toBeGreaterThan(0);
    for (const name of webLinksUsed(SOURCES)) expect(ALLOWED_WEBLINKS, name).toContain(name);
  });

  it("the settings actions that open the Web are exactly the four", () => {
    const model = read("ios/Otodoke/Screens/Settings/SettingsModel.swift");
    const enumBody = model.match(/enum SettingsWebAction[^{]*\{([\s\S]*?)\n\}/)?.[1] ?? "";
    expect([...enumBody.matchAll(/\bcase (\w+)/g)].map((m) => m[1]).sort()).toEqual(["changePassphrase", "deleteAccount", "openWeb", "privacy"]);
  });

  it("only the allowed files open a URL", () => {
    expect(openers(SOURCES)).toEqual(ALLOWED_OPENERS);
  });

  it("negative control: a new WebLink, or a new file that opens a URL, is caught", () => {
    const added = [...SOURCES, { file: "ios/Otodoke/Screens/Parcels/ParcelListView.swift", src: "openURL(WebLink.settingsDemo)" }];
    expect(webLinksUsed(added)).toContain("settingsDemo");
    expect(ALLOWED_WEBLINKS).not.toContain("settingsDemo");
    expect(openers(added)).not.toEqual(ALLOWED_OPENERS);
    expect(openers([...SOURCES, { file: "ios/Otodoke/Screens/Detail/Other.swift", src: "SettingsWeb.open(.privacy, openURL)" }])).not.toEqual(ALLOWED_OPENERS);
    expect(webLinksUsed([{ file: "ios/Otodoke/Screens/Shared/OpenWeb.swift", src: "WebLink.anything" }])).toEqual([]);
  });

  it("negative control: a SwiftUI Link, UIApplication's open, a Safari view or a ShareLink in another file is caught", () => {
    const calls = ["Link(destination: url) { Text(x) }", "UIApplication.shared.open(url)", "SFSafariViewController(url: url)", "ShareLink(item: url)"];
    for (const src of calls) {
      expect(openers([...SOURCES, { file: "ios/Otodoke/Screens/Spend/SpendView.swift", src }]), src).not.toEqual(ALLOWED_OPENERS);
    }
  });
});

describe("「荷物を登録する」 under 「これは荷物」 opens the form in the app", () => {
  const pages = read("ios/Otodoke/Screens/Settings/SettingsPages.swift");
  const dropped = pages.match(/struct SettingsDroppedPage[\s\S]*?\n\}\n/)?.[0] ?? "";
  const view = read("ios/Otodoke/Screens/Settings/SettingsView.swift");
  const tabs = read("ios/Otodoke/Screens/MainTabView.swift");
  const problems = (src: string) => {
    const out: string[] = [];
    if (src.includes("WebLink.newParcel") || /newParcel/.test(src)) out.push("goes to the Web's new-parcel page");
    if (!/let register: \(\) -> Void/.test(src)) out.push("register is optional or missing");
    if (/register: \(\(\) -> Void\)\?/.test(src)) out.push("register can be nil");
    return out;
  };

  it("SettingsPages.swift has no WebLink.newParcel and register is not optional", () => {
    expect(dropped).not.toBe("");
    expect(pages).not.toContain("WebLink.newParcel");
    expect(problems(dropped)).toEqual([]);
  });

  it("the tabs open the form of a typed-in parcel as a sheet, and the settings hand it down", () => {
    expect(view).toMatch(/SettingsDroppedPage\(model: model, expanded: expands, register: register\)/);
    expect(tabs).toMatch(/register: \{ manualForm = ManualParcelModel\.live\(list: screens\.list\) \}/);
    expect(tabs).toMatch(/\.sheet\(item: \$manualForm\) \{ form in\s*ManualParcelView\(model: form\)/);
  });

  it("the head comment of SettingsView no longer says 「読み取る」 or 「これは荷物」 open the Web", () => {
    const head = readFileSync(path.join(ROOT, "ios/Otodoke/Screens/Settings/SettingsView.swift"), "utf8").split("\nimport SwiftUI")[0];
    expect(head).not.toMatch(/「読み取る」 and 「これは荷物」 open the Web/);
    expect(head).toContain("finish in the app");
  });

  it("negative control: a nil register, or the Web's page, is caught", () => {
    expect(problems(dropped.replace("let register: () -> Void", "var register: (() -> Void)?"))).toEqual(expect.arrayContaining(["register can be nil"]));
    expect(problems(dropped.replace("register()", "SettingsWeb.openPage(WebLink.newParcel, openURL)"))).toContain("goes to the Web's new-parcel page");
  });
});
