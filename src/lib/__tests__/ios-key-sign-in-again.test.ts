import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 「パスワードとメールの鍵」 with no key: the words are LoginText.noKeyYet, the button is LoginText.signInAgain and it signs out
 * (the login screen follows, and the next password sign-in makes the key, as the unlock's 「ログインし直す」). It does not open the
 * Web. A file that cannot be read is a failure, not a pass.
 */
const ROOT = path.resolve(__dirname, "../../..");
const read = (p: string) => (existsSync(path.join(ROOT, p)) ? readFileSync(path.join(ROOT, p), "utf8") : "");
const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"])\/\/.*$/gm, "$1");

const KEY = "ios/Otodoke/Screens/Settings/SettingsKeyPage.swift";
const MODEL = "ios/Otodoke/Screens/Settings/SettingsModel.swift";
const LOGIN = "ios/Otodoke/Auth/LoginText.swift";

/** The `case .none?:` card of the key page. */
function noKeyCard(src: string): string {
  const at = src.indexOf("case .none?:");
  const end = src.indexOf("case .present?:", at);
  return at < 0 || end < 0 ? "" : src.slice(at, end);
}

function problems(key: string, model: string): string[] {
  const card = noKeyCard(stripComments(key));
  if (!card) return ["card not found"];
  const out: string[] = [];
  if (!card.includes("Text(LoginText.noKeyYet)")) out.push("words missing");
  if (!/primaryButton\(LoginText\.signInAgain\) \{ Task \{ await model\.signOut\(\) \} \}/.test(card)) out.push("button does not sign out");
  if (/openURL|SettingsWeb\.|WebLink|createPassphrase|"鍵を作る"/.test(card)) out.push("opens the Web or still says 鍵を作る");
  if (/createPassphrase/.test(stripComments(model))) out.push("createPassphrase still listed");
  return out;
}

describe("the key page with no key signs in again inside the app", () => {
  const key = read(KEY);
  const model = read(MODEL);

  it("uses the login's words and sign-out, and never the Web", () => {
    expect(problems(key, model)).toEqual([]);
    const login = stripComments(read(LOGIN));
    expect(login).toContain('static let noKeyYet = "メールの鍵がまだできていません。ログインし直すと作れます。"');
    expect(login).toContain('static let signInAgain = "ログインし直す"');
  });

  it("changing the password still opens the Web", () => {
    expect(stripComments(key)).toContain('SettingsWeb.open(.changePassphrase, openURL)');
    expect(stripComments(model)).toMatch(/case \.changePassphrase: WebLink\.settingsPassword/);
  });

  it("negative control: the Web button, other words, no sign-out or a missing card is caught", () => {
    expect(problems(key.replace("primaryButton(LoginText.signInAgain) { Task { await model.signOut() } }", 'primaryButton("鍵を作る") { SettingsWeb.open(.createPassphrase, openURL) }'), model)).toEqual(
      expect.arrayContaining(["button does not sign out", "opens the Web or still says 鍵を作る"]),
    );
    expect(problems(key.replace("Text(LoginText.noKeyYet)", 'Text("別の文")'), model)).toContain("words missing");
    expect(problems(key.replace("await model.signOut()", "await model.pageShown()"), model)).toContain("button does not sign out");
    expect(problems(key, model.replace("case changePassphrase", "case createPassphrase\n    case changePassphrase"))).toContain("createPassphrase still listed");
    expect(problems(key.replace("case .none?:", "case .xx?:"), model)).toEqual(["card not found"]);
  });
});
