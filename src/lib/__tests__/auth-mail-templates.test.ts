import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { RESET_LOSES_MAIL } from "@/lib/mail-notices";

/**
 * The mails Supabase Auth sends: supabase/templates/, wired in supabase/config.toml. Production
 * gets the same subjects and text by hand, in the dashboard's email templates.
 *
 *  - confirmation (Confirm sign up): the Web's signUp, and the iOS app's second build signing in
 *    with a new address (signInWithOtp). The link confirms the address on the Web (type=email);
 *    the code is for that iOS build, which signs in with it.
 *  - recovery (Reset password): resetPasswordForEmail. The link leads to the new password page
 *    (type=recovery), and the mail says first what a reset costs (decision 3).
 *  - magic_link (Magic link or OTP): only that iOS build signs in this way now (decision 4). The
 *    Web no longer signs in with a link (decision 3), so the mail carries the code only.
 *
 * Every link is made from token_hash, never {{ .ConfirmationURL }} (Supabase's own /verify, which a
 * mail scanner's GET would use up). The redirect URL already carries a query (/auth/confirm?...),
 * so the token is added with "&".
 */

const ROOT = path.resolve(__dirname, "../../..");
const read = (file: string) => readFileSync(path.join(ROOT, file), "utf8");
const template = (name: string) => read(`supabase/templates/${name}.html`);

/** What is inside each {{ }} of a template. */
const variables = (html: string) => [...html.matchAll(/\{\{\s*([^}]*?)\s*\}\}/g)].map((m) => m[1]);
/** Every href of a template. */
const links = (html: string) => [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);
/** What a reader sees: the tags taken out. */
const textOf = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");

/** The [auth.email.template.<name>] table of config.toml, up to the next table. */
function section(name: string): string {
  const toml = read("supabase/config.toml");
  const start = toml.indexOf(`[auth.email.template.${name}]`);
  expect(start, name).toBeGreaterThanOrEqual(0);
  const next = toml.indexOf("\n[", start + 1);
  return toml.slice(start, next === -1 ? undefined : next);
}

/** Supabase fills these three; anything else (a typo such as .Tokenhash) is drawn empty. */
const KNOWN = [".RedirectTo", ".TokenHash", ".Token"];

describe("the address confirmation (Confirm sign up)", () => {
  const html = template("confirmation");

  it("has one link, the one /auth/confirm verifies as a confirmation", () => {
    expect(links(html)).toEqual(["{{ .RedirectTo }}&token_hash={{ .TokenHash }}&type=email"]);
  });

  it("keeps the code for the iOS app's second build", () => {
    expect(html).toContain("{{ .Token }}");
    expect(textOf(html)).toContain("アプリでは、このコードを入力してください。");
  });

  it("is the confirmation of the address, not a sign-in", () => {
    const text = textOf(html);
    expect(text).toContain("メールアドレスの確認");
    expect(text).toContain("メールアドレスを確認する");
    expect(text).not.toContain("ログインする");
  });
});

describe("the password reset (Reset password)", () => {
  const html = template("recovery");

  it("has one link, the one /auth/confirm sends to the new password page", () => {
    expect(links(html)).toEqual(["{{ .RedirectTo }}&token_hash={{ .TokenHash }}&type=recovery"]);
  });

  it("says what a reset costs, before the button, in the words of the screens", () => {
    const text = textOf(html);
    expect(text).toContain("パスワードの再設定");
    expect(text).toContain(RESET_LOSES_MAIL);
    expect(html.indexOf(RESET_LOSES_MAIL)).toBeLessThan(html.indexOf("<a "));
  });
});

describe("the sign-in code (Magic link or OTP)", () => {
  const html = template("magic_link");

  it("carries the code for the iOS app and no link: the Web no longer signs in with one", () => {
    expect(html).toContain("{{ .Token }}");
    expect(links(html)).toEqual([]);
    expect(variables(html)).toEqual([".Token"]);
    expect(textOf(html)).toContain("Otodoke のアプリに、このコードを入力してください。");
  });
});

describe("every template", () => {
  for (const name of ["confirmation", "recovery", "magic_link"]) {
    it(`${name}: Japanese, only the values Supabase fills, never ConfirmationURL`, () => {
      const html = template(name);
      expect(html).toContain('<html lang="ja">');
      expect(variables(html).length).toBeGreaterThan(0);
      for (const v of variables(html)) expect(KNOWN, `${name}: {{ ${v} }}`).toContain(v);
      expect(html).not.toContain("ConfirmationURL");
      expect(textOf(html)).toContain("心当たりがない場合は、このメールを無視してください。");
    });
  }

  it("negative control: the helpers find a link, a variable and an unknown one", () => {
    const planted = '<a href="{{ .ConfirmationURL }}">x</a> {{.Tokenhash}}';
    expect(links(planted)).toEqual(["{{ .ConfirmationURL }}"]);
    expect(variables(planted)).toEqual([".ConfirmationURL", ".Tokenhash"]);
    expect(KNOWN).not.toContain(".Tokenhash");
  });
});

describe("supabase/config.toml", () => {
  const WIRED: Array<[string, string, string]> = [
    ["confirmation", "confirmation.html", "Otodoke のメールアドレスの確認"],
    ["recovery", "recovery.html", "Otodoke のパスワードの再設定"],
    ["magic_link", "magic_link.html", "Otodoke のログインコード"],
  ];

  for (const [name, file, subject] of WIRED) {
    it(`[auth.email.template.${name}] is ${file}, with its subject`, () => {
      const body = section(name);
      expect(body).toContain(`content_path = "./supabase/templates/${file}"`);
      expect(body).toContain(`subject = "${subject}"`);
      expect(existsSync(path.join(ROOT, "supabase/templates", file))).toBe(true);
    });
  }

  it("the confirmation is no longer the sign-in mail", () => {
    expect(section("confirmation")).not.toContain("magic_link.html");
    expect(read("supabase/config.toml")).not.toContain("ログインリンク");
  });
});
