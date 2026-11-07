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
const files = [...walk(join(ROOT, "src"), [".ts", ".tsx"]), ...walk(join(ROOT, "ios", "Otodoke"), [".swift"])];

describe("wording never says Otodoke deletes the user's own mail", () => {
  it("scans real files", () => {
    expect(files.length).toBeGreaterThan(20);
  });
  it.each(["関係ないと分かったメールは消します", "件名・差出人・本文を消します"])("no user-facing text contains 「%s」", (old) => {
    const hits = files.filter((f) => readFileSync(f, "utf8").includes(old));
    expect(hits).toEqual([]);
  });
});

describe("the iPhone desktop-site wording is the new one", () => {
  it.each(["アドレス欄の左の ≡ のボタンを押し、「デスクトップ用ウェブサイトを表示」を選ぶと", "iPhone はアドレス欄の左の ≡ のボタンから"])("no user-facing text contains 「%s」", (old) => {
    const hits = files.filter((f) => readFileSync(f, "utf8").includes(old));
    expect(hits).toEqual([]);
  });
});
