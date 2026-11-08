import path from "node:path";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { findAll, parseHtml, type HtmlNode } from "./html-tree";
import { appSourceFiles, read, withoutComments } from "./source-scan";

/**
 * A password never reaches the server, not even before the page's script has run (password-v1:
 * only auth_secret, made from it in the browser, is sent).
 *
 * The forms that take a password are handled in the browser (onSubmit + preventDefault). Before
 * hydration, or when the script fails to load, the browser submits the form itself: a GET form
 * with named fields would put the password in the URL (server logs, history). So:
 *  - no input that takes a password has a `name` (an unnamed field is never submitted), and
 *  - every form holding one is method="post" with no `action` and no named field at all (the
 *    hidden username for a password manager and the bot check's token included), so a native
 *    submit sends an empty body to the same page.
 * Checked on the server-rendered HTML (what the browser has before hydration) and on the source.
 * Inputs labelled with the old word 合言葉 are still caught: the check is about any secret field.
 */

vi.mock("next/navigation", () => ({
  redirect: vi.fn(),
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/app/settings",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/app/app/settings/key-actions", () => ({
  registerMailKey: vi.fn(),
  activateMailKey: vi.fn(),
  rewrapMailKey: vi.fn(),
  sealStoredMail: vi.fn(),
  readMailKey: vi.fn(),
  readRetiredMailKeys: vi.fn(),
  readSealedMail: vi.fn(),
}));
vi.mock("@/app/app/settings/password-actions", () => ({ changeLoginSecret: vi.fn() }));

const USER = "00000000-0000-4000-8000-00000000000a";

const SECRET_WORDS = /passphrase|password|パスワード|合言葉/i;

/** An attribute by name, ignoring case (HTML does; React writes `autoComplete`). */
const attr = (n: HtmlNode, name: string) => Object.entries(n.attrs).find(([k]) => k.toLowerCase() === name)?.[1];
const hasAttr = (n: HtmlNode, name: string) => attr(n, name) !== undefined;

/** An input that takes a password, judged by its type, autocomplete, id, label or placeholder. */
function takesSecret(n: HtmlNode): boolean {
  if (n.tag !== "input") return false;
  if ((attr(n, "type") ?? "").toLowerCase() === "password") return true;
  if (/password/i.test(attr(n, "autocomplete") ?? "")) return true;
  return ["id", "aria-label", "placeholder"].some((a) => SECRET_WORDS.test(attr(n, a) ?? ""));
}

const isControl = (n: HtmlNode) => ["input", "select", "textarea", "button"].includes(n.tag);

/** What is wrong with the rendered markup: each problem as one line, none when it is safe. */
function nativeSubmitProblems(html: string): string[] {
  const root = parseHtml(html);
  const problems: string[] = [];
  for (const input of findAll(root, takesSecret)) {
    if (hasAttr(input, "name")) problems.push(`password input named "${attr(input, "name")}"`);
  }
  for (const form of findAll(root, (n) => n.tag === "form" && findAll(n, takesSecret).length > 0)) {
    if ((attr(form, "method") ?? "").toLowerCase() !== "post") problems.push(`form method is "${attr(form, "method") ?? "get (default)"}"`);
    if (hasAttr(form, "action")) problems.push(`form has action "${attr(form, "action")}"`);
    for (const c of findAll(form, (n) => isControl(n) && hasAttr(n, "name"))) problems.push(`form field named "${attr(c, "name")}"`);
  }
  return problems;
}

const passwordInputs = (html: string) => findAll(parseHtml(html), takesSecret);
const formsWithPassword = (html: string) => findAll(parseHtml(html), (n) => n.tag === "form" && findAll(n, takesSecret).length > 0);

async function screens(): Promise<Record<string, string>> {
  const { LoginForm } = await import("@/app/login/login-form");
  const { SignupForm } = await import("@/app/signup/signup-form");
  const { ResetForm } = await import("@/app/reset-password/reset-form");
  const { UnlockForm } = await import("@/app/app/unlock-form");
  const { PasswordPanel } = await import("@/app/app/settings/password-panel");
  const { SealedMail } = await import("@/app/app/parcels/[id]/sealed-mail");
  const html = (el: ReactElement) => renderToStaticMarkup(el);
  return {
    login: html(createElement(LoginForm, { next: "/app" })),
    signup: html(createElement(SignupForm)),
    reset: html(createElement(ResetForm, { email: "someone@example.test", userId: USER })),
    unlock: html(createElement(UnlockForm, { userId: USER, email: "qa@example.com" })),
    "settings without a key": html(createElement(PasswordPanel, { state: { userId: USER, email: "qa@example.com", keyCreatedAt: null, oldKeyCount: 0, hasPlain: true } })),
    "settings with a key": html(createElement(PasswordPanel, { state: { userId: USER, email: "qa@example.com", keyCreatedAt: "2026-11-06T00:00:00Z", oldKeyCount: 1, hasPlain: false } })),
    "sealed mail": html(createElement(SealedMail, { userId: USER, email: "qa@example.com", emailId: "e1", fromDomain: "example.test", notes: null, confidence: null })),
  };
}

describe("password forms: nothing is sent when submitted before the script runs", () => {
  it("finds the forms it is about (login, signup, reset, open again, first key, change)", async () => {
    const s = await screens();
    expect(formsWithPassword(s.login)).toHaveLength(1);
    expect(formsWithPassword(s.signup)).toHaveLength(1);
    expect(formsWithPassword(s.reset)).toHaveLength(1);
    expect(formsWithPassword(s.unlock)).toHaveLength(1);
    expect(formsWithPassword(s["settings without a key"])).toHaveLength(1);
    // Open it again, change it. A forgotten password is a link to /login/forgot, with no field.
    expect(formsWithPassword(s["settings with a key"])).toHaveLength(2);
    expect(formsWithPassword(s["sealed mail"])).toHaveLength(1);
    expect(passwordInputs(s["settings with a key"]).filter((n) => attr(n, "type") === "password")).toHaveLength(4);
  });

  it("no password input is named, and the forms are POST with no action and no named field", async () => {
    for (const [screen, html] of Object.entries(await screens())) expect(nativeSubmitProblems(html), screen).toEqual([]);
  });

  it("the password manager hints stay: the address as username, the current and the new password", async () => {
    const s = await screens();
    const autocompletes = (html: string) => passwordInputs(html).map((n) => attr(n, "autocomplete"));
    expect(autocompletes(s.login)).toEqual(["current-password"]);
    expect(autocompletes(s.signup)).toEqual(["new-password", "new-password"]);
    expect(autocompletes(s.reset)).toEqual(["new-password", "new-password"]);
    expect(autocompletes(s.unlock)).toEqual(["current-password"]);
    expect(autocompletes(s["settings without a key"])).toEqual(["current-password"]);
    expect(autocompletes(s["settings with a key"])).toEqual(["current-password", "current-password", "new-password", "new-password"]);
    // Every form names its account for the password manager: typed in (login, signup), or the
    // session's, in a hidden field without a name (the others).
    for (const [screen, html] of Object.entries(s)) {
      for (const form of formsWithPassword(html)) expect(findAll(form, (n) => n.tag === "input" && attr(n, "autocomplete") === "username"), screen).toHaveLength(1);
    }
  });

  it("negative control: a GET form, a named password, an action and a named field are each caught", () => {
    expect(nativeSubmitProblems('<form><input type="password" name="password"/></form>')).toEqual(['password input named "password"', 'form method is "get (default)"', 'form field named "password"']);
    expect(nativeSubmitProblems('<form method="post" action="/x"><input type="password"/></form>')).toEqual(['form has action "/x"']);
    expect(nativeSubmitProblems('<form method="post"><input type="text" name="username"/><input aria-label="パスワード"/><button NAME="go">x</button></form>')).toEqual(['form field named "username"', 'form field named "go"']);
    expect(nativeSubmitProblems('<form method="post"><input aria-label="合言葉"/><input type="hidden" name="cf-turnstile-response"/></form>')).toEqual(['form field named "cf-turnstile-response"']);
    expect(nativeSubmitProblems('<form method="post"><input autoComplete="new-password" name="p"/></form>')).toEqual(['password input named "p"', 'form field named "p"']);
    // A form with no password in it is not this test's business.
    expect(nativeSubmitProblems('<form><input type="text" name="q"/></form>')).toEqual([]);
  });
});

/** Each `<input .../>` JSX element in a source, as its text. */
function jsxInputs(source: string): string[] {
  const code = withoutComments(source);
  const out: string[] = [];
  const re = /<input\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code))) {
    let depth = 0;
    let j = m.index + m[0].length;
    for (; j < code.length; j++) {
      const c = code[j];
      if (c === "{") depth++;
      else if (c === "}") depth--;
      else if (depth === 0 && c === ">") break;
    }
    out.push(code.slice(m.index, j + 1));
  }
  return out;
}

const PASSWORD_INPUT = /type=["']password["']|autoComplete=["'][^"']*password|(?:id|aria-label|placeholder)=(?:["'][^"']*|\{`[^`]*)(?:passphrase|password|パスワード|合言葉)/i;

function sourceProblems(files: Array<{ file: string; source: string }>): string[] {
  const out: string[] = [];
  for (const { file, source } of files) {
    const inputs = jsxInputs(source).filter((i) => PASSWORD_INPUT.test(i));
    if (inputs.length === 0) continue;
    const rel = path.relative(process.cwd(), file);
    for (const i of inputs) if (/\sname=/.test(i)) out.push(`${rel}: password input with a name`);
    for (const form of withoutComments(source).match(/<form\b[^>]*>/g) ?? []) {
      if (!/\smethod="post"/.test(form)) out.push(`${rel}: form without method="post"`);
      if (/\saction=/.test(form)) out.push(`${rel}: form with an action`);
    }
  }
  return out;
}

describe("password forms: the source", () => {
  const files = () => appSourceFiles().filter((f) => f.endsWith(".tsx")).map((file) => ({ file, source: read(file) }));

  it("finds the files with password inputs", () => {
    const withInputs = files()
      .filter((f) => jsxInputs(f.source).some((i) => PASSWORD_INPUT.test(i)))
      .map((f) => path.relative(process.cwd(), f.file));
    expect(withInputs.sort()).toEqual(["src/app/app/settings/password-panel.tsx", "src/app/app/unlock-form.tsx", "src/app/login/login-form.tsx", "src/app/login/other-password-form.tsx", "src/app/reset-password/reset-form.tsx", "src/app/signup/signup-form.tsx"]);
  });

  it("no password input has a name; their forms are method=post without an action", () => {
    expect(sourceProblems(files())).toEqual([]);
  });

  it("negative control: planted sources are caught", () => {
    const planted = [
      { file: path.join(process.cwd(), "src/app/a.tsx"), source: '<form onSubmit={f}><input type="password" name="passphrase" value={p} /></form>' },
      { file: path.join(process.cwd(), "src/app/b.tsx"), source: '<form method="post" action="/x"><input aria-label="合言葉" onChange={(e) => s(e.target.value)} /></form>' },
      { file: path.join(process.cwd(), "src/app/c.tsx"), source: '<form method="post"><input placeholder={`合言葉（${N} 文字以上）`} name="p" /></form>' },
      { file: path.join(process.cwd(), "src/app/d.tsx"), source: '<form><input type="text" name="q" /></form>' },
    ];
    expect(sourceProblems(planted)).toEqual([
      "src/app/a.tsx: password input with a name",
      'src/app/a.tsx: form without method="post"',
      "src/app/b.tsx: form with an action",
      "src/app/c.tsx: password input with a name",
    ]);
  });
});
