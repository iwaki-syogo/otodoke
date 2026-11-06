import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { findAll, parseHtml, textOf } from "./html-tree";

/**
 * 設定, after the review of 2026-11-06 (R1-1, R1-5):
 *  - Decision 7 removes, on 2026-11-14, the plaintext subject, sender and body of read mail of users
 *    with no passphrase (supabase/pending/20261114090000). The screen says so, with the date, where
 *    it used to say the mail stays until 「暗号化する」 is pressed.
 *  - Without a passphrase, a failed count of plaintext mail is said as such; the warning used to
 *    vanish, as if there were none (the panel with a passphrase already said so).
 */

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn(), back: vi.fn(), prefetch: vi.fn() }) }));
vi.mock("@/app/app/settings/key-actions", () => ({ registerMailKey: vi.fn(), activateMailKey: vi.fn(), rewrapMailKey: vi.fn(), sealStoredMail: vi.fn(), readMailKey: vi.fn(), readRetiredMailKeys: vi.fn(), readSealedMail: vi.fn() }));

const { MailKeyPanel } = await import("@/app/app/settings/mail-key-panel");
const { MailHandling } = await import("@/app/app/settings/mail-handling");

const USER = "00000000-0000-4000-8000-00000000000a";
const NOTICE = "11 月 14 日に件名・差出人・本文を消します。荷物は残ります";
const COUNT_FAILED = "暗号化されていないメールの数を読み込めませんでした";

const panel = (over: { keyCreatedAt?: string | null; plainCount: number | null }) =>
  parseHtml(renderToStaticMarkup(createElement(MailKeyPanel, { state: { userId: USER, keyCreatedAt: over.keyCreatedAt ?? null, currentKeyId: over.keyCreatedAt ? "a".repeat(32) : null, plainCount: over.plainCount, oldKeyCount: 0 } })));

const redBoxes = (root: ReturnType<typeof parseHtml>) => findAll(root, (n) => n.tag === "p" && textOf(n) === COUNT_FAILED && (n.attrs.class ?? "").includes("bg-red-50"));

describe("decision 7 is announced with its date", () => {
  it("without a passphrase: the plaintext warning says the mail goes on 11/14 unless one is set", () => {
    const text = textOf(panel({ plainCount: 3 }));
    expect(text).toContain("暗号化されていない保存済みのメール 3 通も、決めたあとに暗号化できます。それまでは運営者が読める形です。");
    expect(text).toContain(`合言葉を決めていない場合は、${NOTICE}`);
  });

  it("with a passphrase: no date (decision 7 leaves these to 「暗号化する」)", () => {
    const text = textOf(panel({ keyCreatedAt: "2026-11-06T00:00:00Z", plainCount: 2 }));
    expect(text).toContain("押すまでは、運営者が読める形で残ります");
    expect(text).not.toContain("11 月 14 日");
  });

  it("「あなたのメールの扱い」 says the same, next to the mail read before encryption", () => {
    const item = findAll(parseHtml(renderToStaticMarkup(createElement(MailHandling))), (n) => n.tag === "li" && textOf(n).includes("暗号化を始める前に読み取ったメールは、暗号化していません"));
    expect(item).toHaveLength(1);
    expect(textOf(item[0])).toContain(`合言葉を決めていない場合は、${NOTICE}`);
  });

  it("the pending SQL's header no longer claims a notice that is not there", () => {
    const sql = readFileSync(path.resolve(__dirname, "../../../supabase/pending/20261114090000_drop_unsealed_plaintext.sql"), "utf8");
    expect(sql).not.toContain("the settings screen / README say so");
    expect(sql).toContain("mail-key-panel.tsx");
  });
});

describe("a failed count of plaintext mail", () => {
  it("without a passphrase: says the count could not be read, instead of no warning", () => {
    expect(redBoxes(panel({ plainCount: null }))).toHaveLength(1);
  });

  it("with a passphrase: the same words (as before)", () => {
    expect(redBoxes(panel({ keyCreatedAt: "2026-11-06T00:00:00Z", plainCount: null }))).toHaveLength(1);
  });

  it("control: a count of 0 shows neither the warning nor the failure", () => {
    const root = panel({ plainCount: 0 });
    expect(redBoxes(root)).toHaveLength(0);
    expect(textOf(root)).not.toContain("運営者が読める形");
  });
});
