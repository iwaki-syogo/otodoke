import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..", "..");

const walk = (dir: string, exts: string[]): string[] =>
  readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (name === "__tests__" || name === "node_modules" || name === "build" || name === "Tests") return [];
    if (statSync(p).isDirectory()) return walk(p, exts);
    return exts.some((e) => p.endsWith(e)) ? [p] : [];
  });

// User-facing text only: tests and fixtures are skipped on purpose.
const files = [
  ...walk(join(ROOT, "src"), [".ts", ".tsx"]),
  ...walk(join(ROOT, "ios", "Otodoke"), [".swift"]),
  join(ROOT, "README.md"),
];

const containsPhrase = (text: string, phrase: string): boolean => text.includes(phrase);
const filesContaining = (phrase: string): string[] => files.filter((f) => containsPhrase(readFileSync(f, "utf8"), phrase));

const DELETION_PHRASES = [
  "関係ないと分かったメールは消します",
  "件名・差出人・本文を消します",
  "14 日で消します",
  "毎日まとめて消します",
  "荷物、保存したメール、転送先アドレスを、アカウントごと消します",
  "荷物と保存したメールを消します",
  "荷物と保存したメールを消しました",
];

describe("wording never says Otodoke deletes the user's own mail", () => {
  it("scans real files", () => {
    expect(files.length).toBeGreaterThan(20);
  });
  it.each(DELETION_PHRASES)("no user-facing text contains 「%s」", (old) => {
    expect(filesContaining(old)).toEqual([]);
  });
  it.each(DELETION_PHRASES)("negative control: the check catches a text containing 「%s」", (old) => {
    expect(containsPhrase(`前の文。${old}。後ろの文。`, old)).toBe(true);
  });
  it("the new wording is not caught by the banned list", () => {
    const text = "読み取って買い物に関係ないと分かったメールは、Otodoke に残しません。";
    expect(DELETION_PHRASES.filter((p) => containsPhrase(text, p))).toEqual([]);
  });
  it("the new removal wording (Otodoke only, own inbox untouched) is not caught by the banned list", () => {
    const texts = [
      "Otodoke の荷物、Otodoke に保存したメール、転送先アドレスを、アカウントごと消します。お使いのメールの受信箱は、そのままです。元に戻せません。",
      "Otodoke の荷物と、Otodoke に保存したメールを消します。お使いのメールの受信箱は、そのままです。消すと元に戻せません。",
      "Otodoke の荷物と、Otodoke に保存したメールを消しました。お使いのメールの受信箱は、そのままです。",
    ];
    for (const t of texts) expect(DELETION_PHRASES.filter((p) => containsPhrase(t, p))).toEqual([]);
  });
});

describe("the iPhone desktop-site wording is the new one", () => {
  it.each(["アドレス欄の左の ≡ のボタンを押し、「デスクトップ用ウェブサイトを表示」を選ぶと", "iPhone はアドレス欄の左の ≡ のボタンから"])("no user-facing text contains 「%s」", (old) => {
    const hits = files.filter((f) => readFileSync(f, "utf8").includes(old));
    expect(hits).toEqual([]);
  });
});

// Old plaintext mail is sealed by the server by itself: no text may say the user has to press
// something first, or that the operator can read the mail until then.
const MANUAL_SEAL_PHRASES = ["運営者が読める形で残ります", "運営者が読める形です", "押すまで", "「暗号化する」を押"];
const relative = (f: string) => f.slice(ROOT.length + 1);

describe("wording never says the user must press something to have old mail encrypted", () => {
  it.each(MANUAL_SEAL_PHRASES)("no user-facing text contains 「%s」", (phrase) => {
    expect(filesContaining(phrase).map(relative)).toEqual([]);
  });
  it.each(MANUAL_SEAL_PHRASES)("negative control: the check catches a text containing 「%s」", (phrase) => {
    expect(containsPhrase(`前の文。${phrase}。後ろの文。`, phrase)).toBe(true);
  });
  it("the new wording is not caught", () => {
    const text = "パスワードでログインすると、暗号化を始める前のメールも自動で暗号化します。";
    expect(MANUAL_SEAL_PHRASES.filter((p) => containsPhrase(text, p))).toEqual([]);
  });
});
