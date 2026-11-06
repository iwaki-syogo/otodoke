import { describe, expect, it } from "vitest";
import { isWeakPassword, normalizePassword, passwordProblem, PASSWORD_RULE } from "@/lib/crypto/password-v1";

/**
 * Review C-11, kept for the password of password-v1: the wrapped key and the login secret can be
 * tried offline by anyone who gets them, so the obviously weak passwords are refused when one is
 * made (/signup), set again (/reset-password) or changed (設定). The rule stays small enough to
 * state on the screen in one line (PASSWORD_RULE).
 */

const weak = (p: string) => isWeakPassword(normalizePassword(p));

describe("weak passwords are refused", () => {
  it("one character repeated, or a short unit repeated", () => {
    for (const p of ["aaaaaaaaaa", "ああああああああああ", "1212121212", "abcabcabcabc", "ＡＡＡＡＡＡＡＡＡＡ"]) expect(weak(p), p).toBe(true);
  });

  it("a sequence up or down (9 → 0 counts)", () => {
    for (const p of ["1234567890", "0987654321", "abcdefghijk", "zyxwvutsrqp", "2345678901"]) expect(weak(p), p).toBe(true);
  });

  it("a common word with only digits or symbols around it", () => {
    for (const p of ["password1234", "Password!!!!", "qwerty123456", "iloveyou2026", "1234otodoke", "password 1234"]) expect(weak(p), p).toBe(true);
  });

  it("negative control: ordinary passwords pass, and so does the vectors' one", () => {
    for (const p of ["テスト用の合言葉です1234", "うちの猫は三毛で7歳", "correct horse battery", "ka9-Fm2!pq", "password と猫と 2026 年の春"]) expect(weak(p), p).toBe(false);
  });

  it("passwordProblem tells it in words, after the length check and before the match check", () => {
    expect(passwordProblem("123", "123")).toBe("10 文字以上にしてください");
    expect(passwordProblem("1234567890", "1234567890")).toContain("推測されやすい");
    expect(passwordProblem("うちの猫は三毛で7歳", "うちの猫は三毛で8歳")).toBe("2 回の入力が違います");
    expect(passwordProblem("うちの猫は三毛で7歳", "うちの猫は三毛で7歳")).toBeNull();
  });

  it("the screen states the rule", () => {
    expect(PASSWORD_RULE).toContain("10 文字以上");
    expect(PASSWORD_RULE).toContain("連番");
    expect(PASSWORD_RULE).toContain("くり返し");
  });
});
