import path from "node:path";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { findAll, parseHtml, type HtmlNode } from "./html-tree";
import { appSourceFiles, read, withoutComments } from "./source-scan";

/**
 * A passphrase never reaches the server, not even before the page's script has run.
 *
 * The forms that take a passphrase are handled in the browser (onSubmit + preventDefault). Before
 * hydration, or when the script fails to load, the browser submits the form itself: a GET form
 * with named fields would put the passphrase in the URL (server logs, history). So:
 *  - no input that takes a passphrase has a `name` (an unnamed field is never submitted), and
 *  - every form holding one is method="post" with no `action` and no named field at all, so a
 *    native submit sends an empty body to the same page.
 * Checked on the server-rendered HTML (what the browser has before hydration) and on the source.
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

const USER = "00000000-0000-4000-8000-00000000000a";

const PASSPHRASE_WORDS = /passphrase|password|合言葉/i;

/** An attribute by name, ignoring case (HTML does; React writes `autoComplete`). */
const attr = (n: HtmlNode, name: string) => Object.entries(n.attrs).find(([k]) => k.toLowerCase() === name)?.[1];
const hasAttr = (n: HtmlNode, name: string) => attr(n, name) !== undefined;

/** An input that takes a passphrase, judged by its type, autocomplete, id, label or placeholder. */
function takesPassphrase(n: HtmlNode): boolean {
  if (n.tag !== "input") return false;
  if ((attr(n, "type") ?? "").toLowerCase() === "password") return true;
  if (/password/i.test(attr(n, "autocomplete") ?? "")) return true;
  return ["id", "aria-label", "placeholder"].some((a) => PASSPHRASE_WORDS.test(attr(n, a) ?? ""));
}

const isControl = (n: HtmlNode) => ["input", "select", "textarea", "button"].includes(n.tag);

/** What is wrong with the rendered markup: each problem as one line, none when it is safe. */
function nativeSubmitProblems(html: string): string[] {
  const root = parseHtml(html);
  const problems: string[] = [];
  for (const input of findAll(root, takesPassphrase)) {
    if (hasAttr(input, "name")) problems.push(`passphrase input named "${attr(input, "name")}"`);
  }
  for (const form of findAll(root, (n) => n.tag === "form" && findAll(n, takesPassphrase).length > 0)) {
    if ((attr(form, "method") ?? "").toLowerCase() !== "post") problems.push(`form method is "${attr(form, "method") ?? "get (default)"}"`);
    if (hasAttr(form, "action")) problems.push(`form has action "${attr(form, "action")}"`);
    for (const c of findAll(form, (n) => isControl(n) && hasAttr(n, "name"))) problems.push(`form field named "${attr(c, "name")}"`);
  }
  return problems;
}

const passphraseInputs = (html: string) => findAll(parseHtml(html), takesPassphrase);
const formsWithPassphrase = (html: string) => findAll(parseHtml(html), (n) => n.tag === "form" && findAll(n, takesPassphrase).length > 0);

async function screens(): Promise<Record<string, string>> {
  const { UnlockForm } = await import("@/app/app/unlock-form");
  const { MailKeyPanel } = await import("@/app/app/settings/mail-key-panel");
  const { SealedMail } = await import("@/app/app/parcels/[id]/sealed-mail");
  const html = (el: ReactElement) => renderToStaticMarkup(el);
  return {
    unlock: html(createElement(UnlockForm, { userId: USER })),
    "settings without a key": html(createElement(MailKeyPanel, { state: { userId: USER, keyCreatedAt: null, plainCount: 2, oldKeyCount: 0 } })),
    "settings with a key": html(createElement(MailKeyPanel, { state: { userId: USER, keyCreatedAt: "2026-11-06T00:00:00Z", plainCount: 2, oldKeyCount: 1 } })),
    "sealed mail": html(createElement(SealedMail, { userId: USER, emailId: "e1", fromDomain: "example.test", notes: null, confidence: null })),
  };
}

describe("passphrase forms: nothing is sent when submitted before the script runs", () => {
  it("finds the forms it is about (unlock, new key, change, forgotten)", async () => {
    const s = await screens();
    expect(formsWithPassphrase(s.unlock)).toHaveLength(1);
    expect(formsWithPassphrase(s["settings without a key"])).toHaveLength(1);
    // Unlock, change, make a new one (forgotten).
    expect(formsWithPassphrase(s["settings with a key"])).toHaveLength(3);
    expect(formsWithPassphrase(s["sealed mail"])).toHaveLength(1);
    expect(passphraseInputs(s["settings with a key"]).filter((n) => attr(n, "type") === "password")).toHaveLength(6);
  });

  it("no passphrase input is named, and the forms are POST with no action and no named field", async () => {
    for (const [screen, html] of Object.entries(await screens())) expect(nativeSubmitProblems(html), screen).toEqual([]);
  });

  it("the password manager hints stay", async () => {
    const s = await screens();
    const autocompletes = passphraseInputs(s["settings with a key"])
      .filter((n) => attr(n, "type") === "password")
      .map((n) => attr(n, "autocomplete"));
    expect(autocompletes).toEqual(["current-password", "current-password", "new-password", "new-password", "new-password", "new-password"]);
    expect(passphraseInputs(s.unlock).map((n) => attr(n, "autocomplete"))).toEqual(["current-password"]);
  });

  it("negative control: a GET form, a named passphrase, an action and a named field are each caught", () => {
    expect(nativeSubmitProblems('<form><input type="password" name="passphrase"/></form>')).toEqual(['passphrase input named "passphrase"', 'form method is "get (default)"', 'form field named "passphrase"']);
    expect(nativeSubmitProblems('<form method="post" action="/x"><input type="password"/></form>')).toEqual(['form has action "/x"']);
    expect(nativeSubmitProblems('<form method="post"><input type="text" name="username"/><input aria-label="合言葉"/><button NAME="go">x</button></form>')).toEqual(['form field named "username"', 'form field named "go"']);
    expect(nativeSubmitProblems('<form method="post"><input autoComplete="new-password" name="p"/></form>')).toEqual(['passphrase input named "p"', 'form field named "p"']);
    // A form with no passphrase in it is not this test's business.
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

const PASSPHRASE_INPUT = /type=["']password["']|autoComplete=["'][^"']*password|(?:id|aria-label|placeholder)=(?:["'][^"']*|\{`[^`]*)(?:passphrase|password|合言葉)/i;

function sourceProblems(files: Array<{ file: string; source: string }>): string[] {
  const out: string[] = [];
  for (const { file, source } of files) {
    const inputs = jsxInputs(source).filter((i) => PASSPHRASE_INPUT.test(i));
    if (inputs.length === 0) continue;
    const rel = path.relative(process.cwd(), file);
    for (const i of inputs) if (/\sname=/.test(i)) out.push(`${rel}: passphrase input with a name`);
    for (const form of withoutComments(source).match(/<form\b[^>]*>/g) ?? []) {
      if (!/\smethod="post"/.test(form)) out.push(`${rel}: form without method="post"`);
      if (/\saction=/.test(form)) out.push(`${rel}: form with an action`);
    }
  }
  return out;
}

describe("passphrase forms: the source", () => {
  const files = () => appSourceFiles().filter((f) => f.endsWith(".tsx")).map((file) => ({ file, source: read(file) }));

  it("finds the files with passphrase inputs", () => {
    const withInputs = files()
      .filter((f) => jsxInputs(f.source).some((i) => PASSPHRASE_INPUT.test(i)))
      .map((f) => path.relative(process.cwd(), f.file));
    expect(withInputs.sort()).toEqual(["src/app/app/settings/mail-key-panel.tsx", "src/app/app/unlock-form.tsx"]);
  });

  it("no passphrase input has a name; their forms are method=post without an action", () => {
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
      "src/app/a.tsx: passphrase input with a name",
      'src/app/a.tsx: form without method="post"',
      "src/app/b.tsx: form with an action",
      "src/app/c.tsx: passphrase input with a name",
    ]);
  });
});
