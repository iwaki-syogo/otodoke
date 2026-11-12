import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 「サンプルで試す」 in the app says what the Web's settings/demo page and the list's busy note say, word for word.
 * DemoText.swift is read against the Web's files; a file that cannot be read, or a string that cannot be found, is a
 * failure (never an empty pass). The views carry no Japanese of their own.
 */
const ROOT = path.resolve(__dirname, "../../..");
const read = (p: string) => (existsSync(path.join(ROOT, p)) ? readFileSync(path.join(ROOT, p), "utf8") : "");

const TEXT = read("ios/Otodoke/Screens/Settings/DemoText.swift");
const PAGE = read("src/app/app/settings/demo/page.tsx");
const LOADER = read("src/app/app/settings/demo-loader.tsx");
const ERRORS = read("src/lib/settings-errors.ts");
const LABELS = read("src/app/app/settings/demo-labels.ts");
const LIST = read("src/app/app/page.tsx");
const UNREAD = read("src/lib/unread.ts");

/** The string literal bound to a Swift `static let name = "…"`; null when there is none. */
function swiftLet(src: string, name: string): string | null {
  return src.match(new RegExp(`static let ${name} = "([^"\\n]*)"`))?.[1] ?? null;
}

function errorWord(code: string): string | null {
  return ERRORS.match(new RegExp(`${code}: "([^"\\n]*)"`))?.[1] ?? null;
}

/** [swift name, the Web's text or null]. */
function pairs(): Array<[string, string | null]> {
  return [
    ["lead", PAGE.match(/<p className="text-sm leading-6 text-neutral-600">([^<]*)<\/p>/)?.[1] ?? null],
    ["loadLabel", LABELS.match(/LOAD_DEMO_LABEL = "([^"]*)"/)?.[1] ?? null],
    ["loadBusy", LOADER.match(/busyLabel="(読み込んでいます…)"/)?.[1] ?? null],
    ["loadFailed", errorWord("demo_failed")],
    ["clearSummary", LOADER.match(/<summary className="cursor-pointer text-neutral-500">([^<]*)<\/summary>/)?.[1] ?? null],
    ["clearWarning", LOADER.match(/leading-6">(Otodoke の荷物と、Otodoke に保存したメールを消します[^<]*)<\/p>/)?.[1] ?? null],
    ["clearCheck", LOADER.match(/className="h-4 w-4" \/>\s*([^\n<]+)\n/)?.[1]?.trim() ?? null],
    ["clearButton", /label="消す" busyLabel="/.test(LOADER) ? "消す" : null],
    ["clearBusy", LOADER.match(/busyLabel="(消しています…)"/)?.[1] ?? null],
    ["cleared", LOADER.match(/<p className="text-sm text-neutral-700">(Otodoke の荷物と、Otodoke に保存したメールを消しました[^<]*)<\/p>/)?.[1] ?? null],
    ["clearConfirm", errorWord("clear_confirm")],
    ["clearFailed", errorWord("clear_failed")],
  ];
}

describe("「サンプルで試す」 (iOS) says the Web's words", () => {
  it("every sentence is the Web's, word for word", () => {
    expect(TEXT, "DemoText.swift").not.toBe("");
    for (const [name, web] of pairs()) {
      expect(web, `the Web's ${name} was not found`).not.toBeNull();
      expect(swiftLet(TEXT, name), `DemoText.${name}`).toBe(web);
    }
  });

  it("the partial count and the busy note read as the Web's", () => {
    expect(LOADER).toContain("{loaded} 通は読み込めました。");
    expect(TEXT).toContain('"\\(count) 通は読み込めました。"');
    const web = LIST.match(/ほかの人がサンプルを読み込んでいるかもしれません。\{PENDING_GRACE_MS \/ 60_000\} 分ほど待ってから、もう一度サンプルを読み込んでください。/);
    expect(web, "the list's busy note").not.toBeNull();
    expect(UNREAD).toMatch(/PENDING_GRACE_MS = 3 \* 60 \* 1000/);
    expect(swiftLet(TEXT, "busyNote")).toBe("ほかの人がサンプルを読み込んでいるかもしれません。3 分ほど待ってから、もう一度サンプルを読み込んでください。");
  });

  it("negative control: a changed word or a missing string is caught", () => {
    const changed = TEXT.replace("消すと元に戻せません。", "消すと戻せません。");
    const warning = pairs().find(([n]) => n === "clearWarning")![1];
    expect(swiftLet(changed, "clearWarning")).not.toBe(warning);
    expect(swiftLet("", "lead")).toBeNull();
  });

  it("the views and models carry no Japanese of their own", () => {
    for (const f of ["SettingsDemoPanel.swift", "DemoModel.swift"]) {
      const src = read(`ios/Otodoke/Screens/Settings/${f}`).replace(/\/\/.*$/gm, "");
      expect(src, f).not.toBe("");
      expect(src.match(/"[^"\n]*[぀-ヿ一-鿿][^"\n]*"/g) ?? [], f).toEqual([]);
    }
    expect(read("ios/Otodoke/Screens/MainTabView.swift")).toContain("DemoText.busyNote");
  });

  it("the panel reads the result out, marks the running button and lets the check go after sending; the tab starts again after a clear", () => {
    const panel = read("ios/Otodoke/Screens/Settings/SettingsDemoPanel.swift").replace(/\/\/.*$/gm, "");
    const tabs = read("ios/Otodoke/Screens/MainTabView.swift").replace(/\/\/.*$/gm, "");
    const check = (p: string, t: string) => ({
      announces: /AccessibilityNotification\.Announcement\(/.test(p),
      values: /accessibilityValue\(model\.phase == \.loading \? DemoText\.loadBusy/.test(p) && /accessibilityValue\(model\.phase == \.clearing \? DemoText\.clearBusy/.test(p),
      letsGo: /confirmed = false\s*Task \{ _ = await model\.clear\(confirmed: sure\) \}/.test(p),
      restarts: /\.id\(screens\.settings\.demo\?\.clearedCount \?\? 0\)/.test(t),
      hint: /accessibilityHint\(DemoText\.busyHint\)/.test(t),
    });
    expect(check(panel, tabs)).toEqual({ announces: true, values: true, letsGo: true, restarts: true, hint: true });
    expect(check(panel.replace("AccessibilityNotification.Announcement(", "Other("), tabs).announces).toBe(false);
    expect(check(panel.replace(/confirmed = false\s*Task/, "Task"), tabs).letsGo).toBe(false);
    expect(check(panel, tabs.replace(".id(screens.settings.demo?.clearedCount ?? 0)", "")).restarts).toBe(false);
    expect(check(panel, tabs.replace(".accessibilityHint(DemoText.busyHint)", "")).hint).toBe(false);
    expect(TEXT).toContain('static let busyHint = "サンプルの画面を開きます"');
  });

  it("the load waits longer than the server runs, and a press while one runs sends nothing", () => {
    const client = read("ios/Otodoke/Data/DemoClient.swift");
    expect(client).toMatch(/loadTimeout: TimeInterval = 310/);
    expect(client).toContain('"api/demo/\\(endpoint)"');
    const model = read("ios/Otodoke/Screens/Settings/DemoModel.swift");
    const loadGuard = /guard (?:isCurrent\(\),\s*)?phase == \.idle else \{ return \}/g;
    const clearGuard = /guard (?:isCurrent\(\),\s*)?phase == \.idle else \{ return false \}/g;
    expect(model.match(loadGuard)?.length).toBe(1);
    expect(model.match(clearGuard)?.length).toBe(1);
    const noBusyGuard = model.replaceAll("phase == .idle", "true");
    expect(noBusyGuard.match(loadGuard)).toBeNull();
    expect(noBusyGuard.match(clearGuard)).toBeNull();
  });
});
