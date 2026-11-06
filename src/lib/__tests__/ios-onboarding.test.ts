import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * [iOS onboarding] From making an account to the forwarding setup:
 *  - the words: every OnboardingText constant is the sentence of the owner's wording file
 *    (docs/ux-redo/onboarding-wording.md, outside this repo). The Web's constants are not in src yet, so the
 *    comparison is with WORDING below, a copy of that file's sentences (when the Web's constants land, compare with
 *    them instead). The Swift side is pinned both ways: no constant without a copy, no copy without a constant;
 *  - the views hold none of those words as literals; the waiting screen and the guide read OnboardingText;
 *  - the password is held in memory only (no Keychain, UserDefaults or file in LoginModel);
 *  - the guide is gated on KeySetupOutcome.created; the empty list's button opens 「メールの転送」.
 */

const ROOT = path.resolve(__dirname, "../../..");
const APP = path.join(ROOT, "ios/Otodoke");
const read = (p: string) => (existsSync(path.join(ROOT, p)) ? readFileSync(path.join(ROOT, p), "utf8") : "");
const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"])\/\/.*$/gm, "$1");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

/** Every `static let <name> = "<literal>"` of a Swift text. */
function swiftConstants(src: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of src.matchAll(/^\s*static let (\w+)(?:\s*:\s*\w+)?\s*=\s*"([^"\\]*)"/gm)) out.set(m[1], m[2]);
  return out;
}

/** A copy of onboarding-wording.md (2026-11-07), by OnboardingText name. */
const WORDING: Record<string, string> = {
  // screen 1
  waitingTitle: "確認のメールを送りました",
  waitingLead: "メールのリンクを押してこの画面に戻ると、自動で次へ進みます。",
  confirmedButton: "確認しました",
  resendButton: "メールを送り直す",
  notConfirmedYet: "まだ確認できていません。メールのリンクを押しましたか？",
  resent: "送り直しました",
  // screen 3
  guideTitle: "最後に、メールの自動転送を設定しますか？",
  guideLead: "設定は最初の 1 回だけです。",
  step1Heading: "1. 転送先アドレスをコピー",
  step2Heading: "2. お使いのメールで設定",
  doneButton: "設定しました",
  laterButton: "あとで",
};

/** Not in the wording file: the app's way out of the wait, and the words copied from 「メールの転送」. */
const SAME_AS_FORWARD_PAGE: Record<string, string> = {
  addressNoKey: "鍵ができると、ここに出ます。サンプルは鍵なしで試せます。",
  addressKeyFailed: "鍵を読み込めなかったので、アドレスを出せませんでした。ページを読み込み直してください。",
};
const APP_ONLY: Record<string, string> = { startOver: "別のアドレスでやり直す" };

describe("the words", () => {
  const swift = () => swiftConstants(stripComments(read("ios/Otodoke/Auth/OnboardingText.swift")));

  it("every constant is the wording file's sentence, character for character", () => {
    const all = swift();
    for (const [name, words] of Object.entries(WORDING)) expect(all.get(name), `OnboardingText.${name}`).toBe(words);
  });

  it("the address words are 「メールの転送」's", () => {
    const all = swift();
    for (const [name, words] of Object.entries(SAME_AS_FORWARD_PAGE)) expect(all.get(name), name).toBe(words);
    const page = read("ios/Otodoke/Screens/Settings/SettingsPages.swift");
    for (const words of Object.values(SAME_AS_FORWARD_PAGE)) expect(page, words).toContain(words);
  });

  it("OnboardingText has these constants and the listed app-only one, nothing else", () => {
    const names = [...swift().keys()].sort();
    expect(names).toEqual([...Object.keys(WORDING), ...Object.keys(SAME_AS_FORWARD_PAGE), ...Object.keys(APP_ONLY)].sort());
    expect(Object.fromEntries([...swift()].filter(([n]) => n in APP_ONLY))).toEqual(APP_ONLY);
  });

  it("the sentences follow the wording file's rules: no 「転送するだけ」, no 「このアプリ」, no shop or domain", () => {
    for (const words of [...Object.values(WORDING), ...Object.values(APP_ONLY)]) {
      expect(words).not.toMatch(/転送するだけ|このアプリ|\.com|\.jp|Amazon|楽天/);
    }
  });

  it("negative control: one changed character, or an added constant, is caught", () => {
    const src = 'enum OnboardingText {\n    static let resent = "送り直しました"\n}';
    expect(swiftConstants(src).get("resent")).toBe(WORDING.resent);
    expect(swiftConstants(src.replace("送り直しました", "送り直しました。")).get("resent")).not.toBe(WORDING.resent);
    expect([...swiftConstants(src.replace("}", '    static let extra = "あ"\n}')).keys()]).toEqual(["resent", "extra"]);
  });
});

describe("the views", () => {
  const JA = /[\u3040-\u30ff\u3400-\u9fff\uff00-\uffef]/;
  const literals = (src: string) => [...stripComments(src).matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]).filter((s) => JA.test(s));

  it("the guide has no Japanese literal and reads OnboardingText", () => {
    const src = read("ios/Otodoke/Screens/Onboarding/OnboardingView.swift");
    expect(literals(src)).toEqual([]);
    for (const name of ["guideTitle", "guideLead", "step1Heading", "step2Heading", "doneButton", "laterButton"]) expect(src, name).toContain(`OnboardingText.${name}`);
  });

  it("the waiting screen reads OnboardingText (LoginView keeps no Japanese literal)", () => {
    const src = read("ios/Otodoke/Auth/LoginView.swift");
    expect(literals(src)).toEqual([]);
    for (const name of ["waitingTitle", "waitingLead", "confirmedButton", "resendButton", "startOver"]) expect(src, name).toContain(`OnboardingText.${name}`);
    const model = read("ios/Otodoke/Auth/LoginModel.swift");
    expect(model).toContain("OnboardingText.notConfirmedYet");
    expect(model).toContain("OnboardingText.resent");
  });

  it("the guide shows the four services only, and no always-on note", () => {
    expect(stripComments(read("ios/Otodoke/Screens/Onboarding/OnboardingView.swift"))).toMatch(/ForwardingGuideView\(servicesOnly: true\)/);
  });
});

describe("the password is in memory only", () => {
  it("LoginModel and the waiting screen touch no Keychain, UserDefaults, file or log", () => {
    for (const file of ["ios/Otodoke/Auth/LoginModel.swift", "ios/Otodoke/Auth/LoginView.swift", "ios/Otodoke/Auth/OnboardingText.swift"]) {
      const src = stripComments(read(file));
      expect(src, file).not.toMatch(/Keychain|UserDefaults|AppStorage|SceneStorage|FileManager|\.write\(|SecItem|Logger|print\(/);
    }
  });

  it("the held password is not observed state and is dropped when the wait ends", () => {
    const src = stripComments(read("ios/Otodoke/Auth/LoginModel.swift"));
    expect(src).toMatch(/@ObservationIgnored private var heldPassword: String\?/);
    expect(src).toMatch(/private func dropWait\(\)\s*\{[^}]*heldPassword = nil/);
  });

  it("negative control: a planted Keychain use is caught", () => {
    expect("let q = SecItemAdd(x)").toMatch(/Keychain|UserDefaults|SecItem/);
  });
});

describe("the wiring", () => {
  it("the guide is shown when the key step made the key, over the tabs, and both buttons close it onto 荷物", () => {
    const gate = stripComments(read("ios/Otodoke/Screens/Onboarding/OnboardingView.swift"));
    expect(gate).toMatch(/if case \.created\? = outcome \{ return true \}/);
    const tabs = stripComments(read("ios/Otodoke/Screens/MainTabView.swift"));
    expect(tabs).toMatch(/fullScreenCover\(isPresented:/);
    expect(tabs).toMatch(/OnboardingGate\.shouldShow\(after: screens\.keySetup\?\.lastOutcome\)/);
    expect(tabs).toMatch(/route\.tab = \.parcels/);
  });

  it("the sign-in after the mail's link is the existing one (AuthService.signIn), not a new route", () => {
    const model = stripComments(read("ios/Otodoke/Auth/LoginModel.swift"));
    const body = model.match(/func checkConfirmation\([\s\S]*?\n    \}\n/)?.[0] ?? "";
    expect(body).toMatch(/auth\.signIn\(email:/);
    expect(body).not.toMatch(/signInWith|verifyOTP|URLSession/);
  });

  it("coming back to the front tries once; there is no timer or loop", () => {
    const view = stripComments(read("ios/Otodoke/Auth/LoginView.swift"));
    expect(view).toMatch(/onChange\(of: scenePhase\)[\s\S]*checkConfirmation\(\)/);
    for (const f of walk(path.join(APP, "Auth")).filter((x) => x.endsWith(".swift"))) {
      expect(stripComments(readFileSync(f, "utf8")).match(/Timer\.|\.publish\(every/g) ?? [], f).toEqual([]);
    }
  });

  it("the empty list's button opens 「メールの転送」", () => {
    const tabs = stripComments(read("ios/Otodoke/Screens/MainTabView.swift"));
    expect(tabs).toMatch(/openForwarding:\s*\{\s*route\.showForwarding\(\)\s*\}/);
    expect(tabs).toMatch(/settingsPath = \[\.forward\]/);
    const list = stripComments(read("ios/Otodoke/Screens/Parcels/ParcelListView.swift"));
    expect(list).toMatch(/EmptyParcels\(openSettings: openForwarding \?\? openSettings/);
  });
});

describe("the settings list", () => {
  it("the key row's badge for no key is the Web's 「未設定」", () => {
    const menu = stripComments(read("ios/Otodoke/Screens/Settings/SettingsMenuText.swift"));
    expect(swiftConstants(menu).get("keyNoneBadge")).toBe("未設定");
  });
});
