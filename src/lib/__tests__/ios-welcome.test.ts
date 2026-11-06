import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The iOS first screen (ios/Otodoke/Auth/WelcomeView.swift): the headline and the sentence under it are the Web
 * top page's (src/app/page.tsx), word for word; the view has no Japanese literal (every word comes from
 * WelcomeText); the two buttons carry the identifiers the UI tests press.
 */

const ROOT = path.resolve(__dirname, "../../..");
const read = (p: string) => (existsSync(path.join(ROOT, p)) ? readFileSync(path.join(ROOT, p), "utf8") : "");
const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"])\/\/.*$/gm, "$1");

function swiftConstant(src: string, name: string): string | null {
  const m = src.match(new RegExp(`^\\s*static let ${name}(?:\\s*:\\s*\\w+)?\\s*=\\s*"([^"\\\\]*)"`, "m"));
  return m ? m[1] : null;
}

/** The two lines of the top page's h1 (split by <br />) and the paragraph under it. */
function parseTopPage(src: string): { first: string; second: string; lede: string } | null {
  const h1 = src.match(/<h1[^>]*>([\s\S]*?)<\/h1>/)?.[1];
  const lede = src.match(/<\/h1>\s*<p[^>]*>([\s\S]*?)<\/p>/)?.[1];
  if (!h1 || !lede) return null;
  const lines = h1.split(/<br\s*\/?>/).map((s) => s.trim());
  if (lines.length !== 2) return null;
  return { first: lines[0], second: lines[1], lede: lede.trim() };
}

const JAPANESE = /[぀-ヿ㐀-鿿＀-￯]/;
/** The sign-up button opens the form in sign-up mode and the sign-in button in sign-in mode (not the other way round). */
const LOGIN_MODE_BY_DESTINATION = /LoginView\(auth: auth, startMode: destination == \.signUp \? \.signUp : \.signIn\)/;

describe("the iOS first screen", () => {
  const text = () => stripComments(read("ios/Otodoke/Auth/WelcomeText.swift"));
  const view = () => stripComments(read("ios/Otodoke/Auth/WelcomeView.swift"));

  it("the headline and the sentence are the Web top page's, word for word", () => {
    const web = parseTopPage(read("src/app/page.tsx"));
    expect(web, "src/app/page.tsx has an h1 of two lines and a paragraph").not.toBeNull();
    expect(swiftConstant(text(), "headlineFirst")).toBe(web!.first);
    expect(swiftConstant(text(), "headlineSecond")).toBe(web!.second);
    expect(swiftConstant(text(), "lede")).toBe(web!.lede);
  });

  it("negative control: the parser sees a changed word and a one-line h1", () => {
    const page = "<h1 className=\"x\">\n  あ、\n  <br />\n  い。\n</h1>\n<p className=\"y\">う。</p>";
    expect(parseTopPage(page)).toEqual({ first: "あ、", second: "い。", lede: "う。" });
    expect(parseTopPage(page.replace("い。", "え。"))).not.toEqual({ first: "あ、", second: "い。", lede: "う。" });
    expect(parseTopPage("<h1>あ</h1><p>い</p>")).toBeNull();
  });

  it("the buttons' words are the ones the owner chose", () => {
    expect(swiftConstant(text(), "newHere")).toBe("はじめての方");
    expect(swiftConstant(text(), "newHereNote")).toBe("アカウントを作る");
    expect(swiftConstant(text(), "signIn")).toBe("ログイン");
  });

  it("every word comes from WelcomeText (no Japanese literal in the view)", () => {
    const literals = [...view().matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]);
    expect(literals.filter((s) => JAPANESE.test(s))).toEqual([]);
    expect(view()).toMatch(/WelcomeText\./);
  });

  it("negative control: a Japanese literal in a view is caught", () => {
    const literals = [...'Text("はじめての方")\nText(WelcomeText.signIn)'.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]);
    expect(literals.filter((s) => JAPANESE.test(s))).toEqual(["はじめての方"]);
  });

  it("the two buttons carry welcome.signUp and welcome.signIn, and open the login form in its two modes", () => {
    const src = view();
    expect(src).toMatch(/accessibilityIdentifier\("welcome\.signUp"\)/);
    expect(src).toMatch(/accessibilityIdentifier\("welcome\.signIn"\)/);
    expect(src).toMatch(LOGIN_MODE_BY_DESTINATION);
  });

  it("negative control: the two modes swapped, or one dropped, are caught", () => {
    expect("LoginView(auth: auth, startMode: destination == .signUp ? .signUp : .signIn)").toMatch(LOGIN_MODE_BY_DESTINATION);
    expect("LoginView(auth: auth, startMode: destination == .signUp ? .signIn : .signUp)").not.toMatch(LOGIN_MODE_BY_DESTINATION);
    expect("LoginView(auth: auth, startMode: .signIn)").not.toMatch(LOGIN_MODE_BY_DESTINATION);
    expect("LoginView(auth: auth, startMode: destination == .signIn ? .signUp : .signIn)").not.toMatch(LOGIN_MODE_BY_DESTINATION);
  });

  it("RootView shows the first screen, not the login form, when signed out", () => {
    const src = stripComments(read("ios/Otodoke/App/RootView.swift"));
    expect(src).toMatch(/case \.login:\s*WelcomeView\(auth: auth\)/);
  });
});
