import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MailHandling } from "@/app/app/settings/mail-handling";
import { TURNSTILE_UNAVAILABLE_MESSAGE } from "@/lib/login-errors";
import { TURNSTILE_SCRIPT_URL, TURNSTILE_SITEKEY, TURNSTILE_TOKEN_MAX_LENGTH, TURNSTILE_WAIT_MS } from "@/lib/turnstile";
import { LOGIN_MESSAGES_COPY } from "./login-words-pw-int";

/**
 * [iOS batch 2, M1] Checks on ios/ that no Swift test can see:
 *  - task 2: the Turnstile constants and the captcha words equal the Web's (one Swift place each); the
 *    WebView keeps the default data store and user agent, loads the HTML with the agreed base URL, never
 *    opens a new window in the app, and isInspectable is true only in DEBUG; LoginView shows the widget;
 *  - task 6: the app's Supabase session is the one without a disk cache (iOS-10); only ParcelWriter
 *    publishes 「古くなった」 (CX1);
 *  - tasks 7, 8, 10: the new screens use the one fence type;
 *  - task 11: GMAIL_FILTER and 「あなたのメールの扱い」 word for word;
 *  - task 12: the tabs show the new screens and the front is wired.
 */

const ROOT = path.resolve(__dirname, "../../..");
const APP = path.join(ROOT, "ios/Otodoke");
const rel = (f: string) => path.relative(ROOT, f);

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const swiftFiles = () => walk(APP).filter((f) => f.endsWith(".swift"));
const read = (p: string) => (existsSync(path.join(ROOT, p)) ? readFileSync(path.join(ROOT, p), "utf8") : "");
const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

/** The string literal assigned to `static let <name>` (no escapes in these values). */
function swiftConstant(src: string, name: string): string | null {
  const m = stripComments(src).match(new RegExp(`static let ${name}(?:\\s*:\\s*\\w+)?\\s*=\\s*"([^"\\\\]*)"`));
  return m ? m[1] : null;
}

/** Line numbers inside `#if DEBUG` blocks (the #else part is outside). */
function debugOnlyLines(src: string): Set<number> {
  const inside = new Set<number>();
  const stack: boolean[] = [];
  src.split("\n").forEach((line, i) => {
    const t = line.trim();
    if (/^#if\b/.test(t)) stack.push(/^#if\s+DEBUG\b/.test(t));
    else if (/^#elseif\b/.test(t) || /^#else\b/.test(t)) stack[stack.length - 1] = false;
    else if (/^#endif\b/.test(t)) stack.pop();
    else if (stack.includes(true)) inside.add(i);
  });
  return inside;
}

describe("task 2: Turnstile", () => {
  const view = read("ios/Otodoke/Auth/TurnstileView.swift");

  it("the constants equal src/lib/turnstile.ts", () => {
    expect(swiftConstant(view, "sitekey")).toBe(TURNSTILE_SITEKEY);
    // Not through stripComments: it would cut the literal at "https://". Anchored at the line start
    // instead, so a commented-out line does not match.
    const script = view.match(/^\s*static let scriptURL\s*=\s*URL\(string:\s*"([^"]+)"\)/m);
    expect(script?.[1]).toBe(TURNSTILE_SCRIPT_URL);
    expect(stripComments(view)).toMatch(new RegExp(`static let tokenMaxLength\\s*=\\s*${TURNSTILE_TOKEN_MAX_LENGTH}\\b`));
    const wait = stripComments(view).match(/static let waitForToken(?:\s*:\s*Duration)?\s*=\s*\.(seconds|milliseconds)\((\d[\d_]*)\)/);
    expect(wait, "waitForToken as .seconds(n) or .milliseconds(n)").not.toBeNull();
    const ms = Number(wait![2].replace(/_/g, "")) * (wait![1] === "seconds" ? 1000 : 1);
    expect(ms).toBe(TURNSTILE_WAIT_MS);
    expect(swiftConstant(view, "unavailable")).toBe(TURNSTILE_UNAVAILABLE_MESSAGE);
  });

  it("the captcha words equal src/lib/login-errors.ts", () => {
    // password-v1: the Web's LOGIN_MESSAGES (integrate/password-v1, through its checked copy) has one sentence.
    const words = read("ios/Otodoke/Auth/LoginText.swift");
    expect(swiftConstant(words, "captcha")).toBe(LOGIN_MESSAGES_COPY.captcha);
    expect(swiftConstant(words, "captcha")).toBe("確認が切れました。もう一度お試しください。");
  });

  it("the WebView: default data store and user agent, the agreed base URL, no window of its own", () => {
    const src = stripComments(view);
    expect(src).toContain("WKWebView");
    expect(src).toMatch(/loadHTMLString\([^)]*baseURL:\s*Turnstile\.baseURL/);
    expect(src).not.toMatch(/nonPersistent\s*\(/);
    expect(src).not.toMatch(/customUserAgent|applicationNameForUserAgent/);
    expect(src).toMatch(/createWebViewWith/);
    expect(src).toMatch(/Turnstile\.externalURL\(forNewWindow:/);
    expect(src).toMatch(/decidePolicyFor/);
    expect(src).toMatch(/TurnstileNavigationPolicy/);
    expect(src).toMatch(/Turnstile\.notice\(/);
    expect(src).toMatch(/frameInfo\.isMainFrame/);
    expect(src).toMatch(/securityOrigin/);
  });

  it("isInspectable is set to true only inside #if DEBUG", () => {
    for (const f of swiftFiles()) {
      const src = readFileSync(f, "utf8");
      const inside = debugOnlyLines(src);
      src.split("\n").forEach((line, i) => {
        if (/isInspectable\s*=\s*true/.test(line.replace(/\/\/.*$/, ""))) {
          expect(inside.has(i), `${rel(f)}:${i + 1}`).toBe(true);
        }
      });
    }
  });

  it("LoginView shows the widget and gives the model its token", () => {
    const login = stripComments(read("ios/Otodoke/Auth/LoginView.swift"));
    expect(login).toContain("TurnstileView(");
    expect(login).toMatch(/turnstile:/);
  });
});

describe("task 6: iOS-10 and CX1", () => {
  it("the app's provider uses the session without a disk cache", () => {
    const src = stripComments(read("ios/Otodoke/Data/SupabaseProvider.swift"));
    const live = src.match(/static func live\(config: AppConfig\)[^{]*\{([\s\S]*?)\n {4}\}/);
    expect(live, "SupabaseProvider.live").not.toBeNull();
    expect(live![1]).toContain("liveURLSession()");
    const session = src.match(/static func liveURLSession\(\)[^{]*\{([\s\S]*?)\n {4}\}/);
    expect(session?.[1] ?? "").not.toMatch(/URLSession\.shared|\.shared\b/);
  });

  it("only ParcelWriter publishes 「古くなった」", () => {
    const publishers: string[] = [];
    for (const f of swiftFiles()) {
      const n = (stripComments(readFileSync(f, "utf8")).match(/\.publish\(\)/g) ?? []).length;
      for (let i = 0; i < n; i++) publishers.push(rel(f));
    }
    expect(publishers.length).toBeGreaterThan(0);
    expect([...new Set(publishers)]).toEqual(["ios/Otodoke/Data/ParcelWriter.swift"]);
  });

  it("the new screens use the one fence type", () => {
    for (const f of ["Calendar/CalendarModel.swift", "Spend/SpendModel.swift", "Settings/SettingsModel.swift"]) {
      expect(stripComments(read(`ios/Otodoke/Screens/${f}`)), f).toMatch(/\bReadFence\b/);
    }
  });
});

describe("task 11: the settings words", () => {
  it("GMAIL_FILTER is the forwarding guide's (moved out of the settings page on dev)", () => {
    const page = read("src/lib/forwarding-guide.ts");
    const web = page.match(/export const GMAIL_FILTER = "([^"]+)"/)?.[1];
    expect(web).toBeTruthy();
    const swift = swiftFiles()
      .filter((f) => f.includes(`${path.sep}Settings${path.sep}`))
      .map((f) => swiftConstant(readFileSync(f, "utf8"), "gmailFilter"))
      .find((v) => v !== null);
    expect(swift).toBe(web);
  });

  it("「あなたのメールの扱い」 lists the Web's items word for word (M1: nothing added)", () => {
    const html = renderToStaticMarkup(createElement(MailHandling));
    const decode = (s: string) => s.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
    const web = [...html.matchAll(/<li>([\s\S]*?)<\/li>/g)].map((m) => decode(m[1].replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim());
    // M2 task 19 adds the item about keeping the key in the Keychain with Face ID (12 → 13).
    expect(web.length).toBe(13);
    const src = stripComments(read("ios/Otodoke/Screens/Settings/MailHandlingView.swift"));
    const block = src.match(/static let items(?:\s*:\s*\[String\])?\s*=\s*\[([\s\S]*?)\n\s*\]/);
    expect(block, "MailHandlingText.items").not.toBeNull();
    const swift = [...block![1].matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]);
    expect(swift).toEqual(web);
    expect(swiftConstant(src, "heading")).toBe("あなたのメールの扱い");
  });
});

describe("task 12: the tabs and the front", () => {
  it("the calendar, spend and settings tabs show their screens", () => {
    const tabs = stripComments(read("ios/Otodoke/Screens/MainTabView.swift"));
    for (const view of ["CalendarView(", "SpendView(", "SettingsView("]) expect(tabs, view).toContain(view);
    expect(tabs).not.toMatch(/case \.calendar, \.spend, \.settings:/);
  });

  it("coming back to the front reaches the screen in front", () => {
    const tabs = stripComments(read("ios/Otodoke/Screens/MainTabView.swift")) + stripComments(read("ios/Otodoke/App/RootView.swift"));
    expect(tabs).toMatch(/scenePhase/);
    expect(tabs).toMatch(/sceneBecameActive\(\)/);
    expect(tabs).toMatch(/ScreenRefresher/);
  });

  it("one DataChanges for the writer and every screen", () => {
    const tabs = stripComments(read("ios/Otodoke/Screens/MainTabView.swift")) + stripComments(read("ios/Otodoke/App/RootView.swift"));
    expect(tabs).toMatch(/DataChanges\(\)/);
    expect(tabs).toMatch(/ParcelWriter\(provider:[^)]*changes:/);
  });
});
