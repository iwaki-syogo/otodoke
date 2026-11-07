import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The sample page's sentence is the same on the Web and on iOS: it says the sample is the anonymized
 * real mails and a made-up year of orders, and that the dates move to the day of loading.
 */

const ROOT = path.resolve(__dirname, "../../..");
const read = (p: string) => (existsSync(path.join(ROOT, p)) ? readFileSync(path.join(ROOT, p), "utf8") : "");

const NEW = "匿名化した実際の注文・発送メールと、見本として作った 1 年分の注文を読み込みます。日付は、読み込んだ日に合わせてずらします。";
/** The sentence from before the made-up history was loaded too. */
const BEFORE_HISTORY = "匿名化した実際の注文・発送メールを読み込みます。";
const OLD = "今日に合わせてずらしてあります";
const FILES = ["src/app/app/settings/demo/page.tsx", "ios/Otodoke/Screens/Settings/SettingsPages.swift"];

const contains = (text: string, phrase: string) => text.includes(phrase);

describe("the sample date sentence", () => {
  it.each(FILES)("%s has the new sentence and not the old ones", (file) => {
    const src = read(file);
    expect(src.length, file).toBeGreaterThan(0);
    expect(contains(src, NEW), file).toBe(true);
    expect(contains(src, OLD), file).toBe(false);
    expect(contains(src, BEFORE_HISTORY), file).toBe(false);
  });
  it("negative control: the check catches the old wording and a missing new sentence", () => {
    const oldText = "匿名化した実際の注文・発送メールを読み込みます。日付は今日に合わせてずらしてあります。";
    expect(contains(oldText, OLD)).toBe(true);
    expect(contains(oldText, NEW)).toBe(false);
    const beforeHistory = "匿名化した実際の注文・発送メールを読み込みます。日付は、読み込んだ日に合わせてずらします。";
    expect(contains(beforeHistory, BEFORE_HISTORY)).toBe(true);
    expect(contains(beforeHistory, NEW)).toBe(false);
    expect(contains(NEW, BEFORE_HISTORY)).toBe(false);
  });
});
