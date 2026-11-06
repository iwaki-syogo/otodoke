import { describe, expect, it } from "vitest";
import { isWeakPassphrase, normalizePassphrase, passphraseProblem, PASSPHRASE_RULE } from "@/lib/crypto/key-wrap";

/**
 * Review C-11: the wrapped key can be tried offline by anyone who gets the row, so the obviously
 * weak passphrases are refused when one is set or changed. The rule stays small enough to state
 * on the screen in one line (PASSPHRASE_RULE).
 */

const weak = (p: string) => isWeakPassphrase(normalizePassphrase(p));

describe("weak passphrases are refused", () => {
  it("one character repeated, or a short unit repeated", () => {
    for (const p of ["aaaaaaaaaa", "ああああああああああ", "1212121212", "abcabcabcabc", "ＡＡＡＡＡＡＡＡＡＡ"]) expect(weak(p), p).toBe(true);
  });

  it("a sequence up or down (9 → 0 counts)", () => {
    for (const p of ["1234567890", "0987654321", "abcdefghijk", "zyxwvutsrqp", "2345678901"]) expect(weak(p), p).toBe(true);
  });

  it("a common word with only digits or symbols around it", () => {
    for (const p of ["password1234", "Password!!!!", "qwerty123456", "iloveyou2026", "1234otodoke", "password 1234"]) expect(weak(p), p).toBe(true);
  });

  it("negative control: ordinary passphrases pass, and so does the vectors' one", () => {
    for (const p of ["テスト用の合言葉です1234", "うちの猫は三毛で7歳", "correct horse battery", "ka9-Fm2!pq", "password と猫と 2026 年の春"]) expect(weak(p), p).toBe(false);
  });

  it("passphraseProblem tells it in words, after the length check and before the match check", () => {
    expect(passphraseProblem("123", "123")).toBe("10 文字以上にしてください");
    expect(passphraseProblem("1234567890", "1234567890")).toContain("推測されやすい");
    expect(passphraseProblem("うちの猫は三毛で7歳", "うちの猫は三毛で8歳")).toBe("2 回の入力が違います");
    expect(passphraseProblem("うちの猫は三毛で7歳", "うちの猫は三毛で7歳")).toBeNull();
  });

  it("the screen states the rule", () => {
    expect(PASSPHRASE_RULE).toContain("10 文字以上");
    expect(PASSPHRASE_RULE).toContain("連番");
    expect(PASSPHRASE_RULE).toContain("くり返し");
  });
});
