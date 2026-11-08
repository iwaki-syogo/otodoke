import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { PLAINTEXT_DROP_NOTICE } from "@/lib/mail-notices";
import { parseHtml, textOf, findAll } from "./html-tree";

/**
 * 設定, in the password panel of password-v1:
 *  - Decision 7 removes, on 2026-11-14, the plaintext subject, sender and body of read mail of users
 *    with no key (supabase/pending/20261114090000). The screen says so, with the date, and says
 *    that logging in with the password seals the older mail by itself.
 *  - Nothing is counted or pressed any more: mail read before encryption is sealed automatically
 *    (sealRemainingPlain), so the panel carries no count, no card and no button for it.
 */

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn(), back: vi.fn(), prefetch: vi.fn() }) }));
vi.mock("@/app/app/settings/key-actions", () => ({ registerMailKey: vi.fn(), activateMailKey: vi.fn(), rewrapMailKey: vi.fn(), readMailKey: vi.fn(), readRetiredMailKeys: vi.fn(), readSealedMail: vi.fn() }));
vi.mock("@/app/app/settings/password-actions", () => ({ changeLoginSecret: vi.fn() }));

const { PasswordPanel } = await import("@/app/app/settings/password-panel");
const { MailHandling } = await import("@/app/app/settings/mail-handling");

const USER = "00000000-0000-4000-8000-00000000000a";
const NOTICE = "Otodoke に保存した件名・差出人・本文は、11 月 14 日に Otodoke から消えます。荷物と、お使いのメールの受信箱は、そのままです";

const panel = (keyCreatedAt: string | null = null, hasPlain = true) =>
  parseHtml(renderToStaticMarkup(createElement(PasswordPanel, { state: { userId: USER, email: "qa@example.com", keyCreatedAt, oldKeyCount: 0, hasPlain } })));

describe("decision 7 is announced with its date", () => {
  it("without a key: says the older mail is sealed at the password login, and goes on 11/14 otherwise, in mail-notices' words", () => {
    const text = textOf(panel());
    expect(text).toContain(PLAINTEXT_DROP_NOTICE);
    expect(PLAINTEXT_DROP_NOTICE).toContain(NOTICE);
    expect(PLAINTEXT_DROP_NOTICE.startsWith("パスワードでログインすると、暗号化を始める前のメールも自動で暗号化します。")).toBe(true);
    expect(text).not.toContain("合言葉");
  });

  it("without a key and without plaintext mail: no notice", () => {
    const text = textOf(panel(null, false));
    expect(text).not.toContain(PLAINTEXT_DROP_NOTICE);
    expect(text).not.toContain("11 月 14 日");
    expect(text).toContain("メールの鍵を作る");
  });

  it("with a key: no date, no warning, no count (the older mail is sealed by itself)", () => {
    const text = textOf(panel("2026-11-06T00:00:00Z"));
    expect(text).not.toContain("11 月 14 日");
    expect(text).not.toContain("運営者が読める形");
    expect(text).not.toContain("暗号化されていないメール");
  });

  it("「あなたのメールの扱い」 says the same, as one item of its own", () => {
    const item = findAll(parseHtml(renderToStaticMarkup(createElement(MailHandling))), (n) => n.tag === "li" && textOf(n) === PLAINTEXT_DROP_NOTICE);
    expect(item).toHaveLength(1);
    expect(PLAINTEXT_DROP_NOTICE.endsWith(`${NOTICE}。`)).toBe(true);
    expect(textOf(item[0])).not.toContain("合言葉");
  });

  it("the pending SQL's header names where users are told, with the password sign-in's files", () => {
    const sql = readFileSync(path.resolve(__dirname, "../../../supabase/pending/20261114090000_drop_unsealed_plaintext.sql"), "utf8");
    expect(sql).not.toContain("the settings screen / README say so");
    // The passphrase panel is replaced by the password panel (password-v1); the sentence is one constant.
    expect(sql).not.toContain("mail-key-panel.tsx");
    expect(sql).toContain("src/app/app/settings/password-panel.tsx");
    expect(sql).toContain("src/lib/mail-notices.ts");
    expect(sql).toContain("PLAINTEXT_DROP_NOTICE");
    for (const told of ["mail-handling.tsx", "src/app/privacy/page.tsx", "README.md"]) expect(sql).toContain(told);
    // Decision 8's retire makes those users keyless until they sign in with a password.
    expect(sql).toContain("supabase/pending/20261107090000_retire_passphrase_keys.sql");
  });
});
