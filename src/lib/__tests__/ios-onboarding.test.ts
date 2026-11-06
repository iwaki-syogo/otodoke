import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { TURNSTILE_TOKEN_STALE_MS } from "../turnstile";
import { AUTO_SIGN_IN_AFTER_FAILURE_MS, AUTO_SIGN_IN_GAP_MS, AUTO_SIGN_IN_MAX, CONFIRM_WAIT, WELCOME } from "../onboarding";

/**
 * [iOS onboarding] From making an account to the forwarding setup:
 *  - the words: every OnboardingText constant is the same sentence as the Web's src/lib/onboarding.ts
 *    (CONFIRM_WAIT, WELCOME): the comparison is with those exports. No constant without a Web sentence and no Web
 *    sentence without a constant;
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

/** The Web's constants (src/lib/onboarding.ts), by OnboardingText name. */
const WORDING: Record<string, string> = {
  // screen 1
  waitingTitle: CONFIRM_WAIT.title,
  waitingLead: CONFIRM_WAIT.body,
  confirmedButton: CONFIRM_WAIT.done,
  resendButton: CONFIRM_WAIT.resend,
  notConfirmedYet: CONFIRM_WAIT.notYet,
  resent: CONFIRM_WAIT.resent,
  startOver: CONFIRM_WAIT.restart,
  // screen 3
  guideTitle: WELCOME.title,
  guideLead: WELCOME.body,
  step1Heading: WELCOME.copyStep,
  step2Heading: WELCOME.setUpStep,
  doneButton: WELCOME.done,
  laterButton: WELCOME.later,
};

const APP_ONLY: Record<string, string> = {};

describe("the words", () => {
  const swift = () => swiftConstants(stripComments(read("ios/Otodoke/Auth/OnboardingText.swift")));

  it("every constant is the wording file's sentence, character for character", () => {
    const all = swift();
    for (const [name, words] of Object.entries(WORDING)) expect(all.get(name), `OnboardingText.${name}`).toBe(words);
  });

  it("the address words (no key, key not read) are 「メールの転送」's: the guide reads the same SettingsWebText constants", () => {
    const guide = stripComments(read("ios/Otodoke/Screens/Onboarding/OnboardingView.swift"));
    const page = stripComments(read("ios/Otodoke/Screens/Settings/SettingsPages.swift"));
    for (const name of ["keyReadFailed", "keyNotMade"]) {
      expect(guide, name).toContain(`SettingsWebText.${name}`);
      expect(page, name).toContain(`SettingsWebText.${name}`);
    }
    // No sentence of its own about the address in OnboardingText.
    expect([...swift().keys()]).not.toContain("addressNoKey");
  });

  it("OnboardingText has these constants, nothing else", () => {
    const names = [...swift().keys()].sort();
    expect(names).toEqual([...Object.keys(WORDING), ...Object.keys(APP_ONLY)].sort());
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

describe("the tries by itself are rationed with the Web's numbers", () => {
  const swiftAuto = () => read("ios/Otodoke/Auth/AutoSignIn.swift");
  const num = (src: string, name: string) => Number(src.match(new RegExp(`static let ${name} = ([0-9_]+)`))?.[1]?.replace(/_/g, ""));

  it("the iOS constants are onboarding.ts's AUTO_SIGN_IN_GAP_MS, AUTO_SIGN_IN_AFTER_FAILURE_MS and AUTO_SIGN_IN_MAX", () => {
    const src = stripComments(swiftAuto());
    expect(num(src, "gapMs")).toBe(AUTO_SIGN_IN_GAP_MS);
    expect(num(src, "afterFailureMs")).toBe(AUTO_SIGN_IN_AFTER_FAILURE_MS);
    expect(num(src, "max")).toBe(AUTO_SIGN_IN_MAX);
  });

  it("negative control: a changed number is caught", () => {
    const src = stripComments(swiftAuto()).replace("20_000", "10_000");
    expect(num(src, "gapMs")).not.toBe(AUTO_SIGN_IN_GAP_MS);
  });

  it("only the try by itself is rationed: the pressed button skips the gate; the front-return path goes through it", () => {
    const model = stripComments(read("ios/Otodoke/Auth/LoginModel.swift"));
    expect(model).toMatch(/\} else \{\s*guard autoGate\.allows\(now: now\(\)\) else \{\s*if !catchUp \{ scheduleCatchUp\(\) \}\s*return\s*\}/);
    expect(model).toMatch(/autoGate\.countSend\(\)/);
    expect(model).toMatch(/autoGate\.refused\(now: now\(\)\)/);
  });

  it("the stale limit of a Turnstile token is the Web's TURNSTILE_TOKEN_STALE_MS", () => {
    const src = stripComments(read("ios/Otodoke/Auth/TurnstileView.swift"));
    expect(Number(src.match(/static let tokenStaleMs = ([0-9_]+)/)?.[1]?.replace(/_/g, ""))).toBe(TURNSTILE_TOKEN_STALE_MS);
  });

  it("a try by itself never waits for a token and sends none without one; the tap that brings a token tries on its own", () => {
    const model = stripComments(read("ios/Otodoke/Auth/LoginModel.swift"));
    const auto = model.match(/private func takeTokenForAutoTry\(\)[\s\S]*?\n    \}\n/)?.[0] ?? "";
    expect(auto).toContain("dropIfStale()");
    expect(auto).not.toMatch(/await|waitUntilSettled/);
    expect(auto).toMatch(/return \(false, nil\)/);
    const view = stripComments(read("ios/Otodoke/Auth/LoginView.swift"));
    expect(view).toMatch(/onChange\(of: model\.turnstile\?\.hasToken \?\? false\)[\s\S]*?checkConfirmation\(\)/);
  });

  it("「送り直しました」 is a toast that goes by itself (ToastBanner over the screen, the model clears it), not a box", () => {
    const view = stripComments(read("ios/Otodoke/Auth/LoginView.swift"));
    expect(view).toMatch(/if let toast = model\.toast \{\s*ToastBanner\(text: toast\)/);
    const model = stripComments(read("ios/Otodoke/Auth/LoginModel.swift"));
    expect(model).toMatch(/showToast\(OnboardingText\.resent\)/);
    expect(model).not.toMatch(/notice = OnboardingText\.resent/);
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
  it("the landing is decided before the tabs are seen: held while the key step runs, the guide covers the tabs without a slide", () => {
    const gate = stripComments(read("ios/Otodoke/Screens/Onboarding/OnboardingView.swift"));
    expect(gate).toMatch(/if case \.created\? = outcome \{ return true \}/);
    expect(gate).toMatch(/if deciding \{ return \.waiting \}/);
    const tabs = stripComments(read("ios/Otodoke/Screens/MainTabView.swift"));
    expect(tabs).not.toMatch(/fullScreenCover/);
    expect(tabs).toMatch(/Landing\.of\(deciding: screens\.keySetup\?\.isDeciding == true, outcome: screens\.keySetup\?\.lastOutcome/);
    expect(tabs).toMatch(/\.opacity\(landing == \.tabs \? 1 : 0\)/);
    expect(tabs).toMatch(/\.transition\(\.identity\)/);
    expect(tabs).toMatch(/route\.tab = \.parcels/);
    // The tabs are not built conditionally (their lists read while the landing is held).
    expect(tabs).not.toMatch(/if landing[^\n]*\{\s*TabView/);
    const keys = stripComments(read("ios/Otodoke/Screens/MainScreens+Keys.swift"));
    expect(keys).toMatch(/setup\.holdLanding\(\)[\s\S]*await setup\.run\(signIn\)\s*setup\.releaseLanding\(\)/);
  });

  it("the sign-in after the mail's link is the existing one (AuthService.signIn), not a new route", () => {
    const model = stripComments(read("ios/Otodoke/Auth/LoginModel.swift"));
    expect(model).toMatch(/auth\.signIn\(email: address, password: typed/);
    const body = model.match(/func checkConfirmation\([\s\S]*?\n    \}\n/)?.[0] ?? "";
    expect(body).toMatch(/signInOnce\(/);
    expect(model).not.toMatch(/signInWith|verifyOTP|URLSession/);
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
