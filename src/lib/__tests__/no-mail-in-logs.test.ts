import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SRC, appSourceFiles, codeOnly, consoleCalls, read } from "./source-scan";

/**
 * No console call in the app may print a mail's content or a passphrase. Server logs (Vercel)
 * are kept outside the database and would undo the encryption of stored mail.
 *
 * A call is refused when the code among its arguments (string contents ignored, `${...}` kept)
 * names any of these. Log ids, counts, statuses and error messages instead.
 *
 * password-v1 adds the password and what is made from it (master, the KEK, the login secret), the
 * account's address, and the tokens a sign-in carries (the bot check's, the access token).
 */
const FORBIDDEN =
  /\b(subject|text_body|html_body|from_name|from_address|fromName|text|html|body|bodies|mail|mails|recipients|plaintext|passphrase|pkcs8|privateKey|challenge|envelope|body_envelope|extraction|result|password|master|kek|authSecret|currentAuthSecret|newAuthSecret|email|captchaToken|accessToken)\b/;

/** Each refused call as "<file relative to base>:<line> console.<method>(… <name> …)". */
function violations(files: string[], base = process.cwd()): string[] {
  const found: string[] = [];
  for (const file of files) {
    for (const call of consoleCalls(read(file))) {
      const code = codeOnly(call.args);
      const hit = code.match(FORBIDDEN);
      if (hit) found.push(`${path.relative(base, file)}:${call.line} console.${call.method}(… ${hit[1]} …)`);
    }
  }
  return found;
}

describe("no mail content or passphrase in logs", () => {
  it("finds the console calls it is about (the scan is not empty)", () => {
    const all = appSourceFiles().flatMap((f) => consoleCalls(read(f)));
    expect(all.length).toBeGreaterThan(20);
    expect(all.some((c) => c.method === "error")).toBe(true);
  });

  it("no console call in src/ names mail content or a passphrase", () => {
    expect(violations(appSourceFiles())).toEqual([]);
  });

  // The planted files go in a src/ of their own under the OS temp dir, never in the real src/.
  // The other guard tests list the real src/ and then read every file, in parallel with this one:
  // a file planted there and removed again could vanish between their list and their read (ENOENT).
  it("negative control: a violation planted in a tree of its own is caught; the same tree without it passes", () => {
    // The real scan walks src/lib/ and the folders below it, where the planted file sits in its tree.
    const lib = path.join(SRC, "lib");
    const real = appSourceFiles();
    expect(real.some((f) => path.dirname(f) === lib)).toBe(true);
    expect(real.some((f) => path.dirname(path.dirname(f)) === lib)).toBe(true);

    const tmp = mkdtempSync(path.join(os.tmpdir(), "otodoke-log-scan-"));
    try {
      const root = path.join(tmp, "src");
      mkdirSync(path.join(root, "lib"), { recursive: true });
      writeFileSync(path.join(root, "lib", "clean.ts"), 'export function g(id: string) {\n  console.error("read failed:", id);\n}\n');
      expect(appSourceFiles(root)).toEqual([path.join(root, "lib", "clean.ts")]);
      expect(violations(appSourceFiles(root), tmp)).toEqual([]);

      writeFileSync(path.join(root, "lib", "zz-planted-log-violation.ts"), 'export function f(mail: { subject: string }) {\n  console.error("read failed:", `${mail.subject}`);\n}\n');
      expect(violations(appSourceFiles(root), tmp)).toEqual(["src/lib/zz-planted-log-violation.ts:2 console.error(… mail …)"]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
    expect(existsSync(tmp)).toBe(false);
  });

  it("negative control: the words of password-v1 are caught, in arguments and template holes, not in the words of the message", () => {
    const planted = [
      'console.warn("sign-in refused:", authSecret);',
      'console.warn("sign-in refused:", input.email);',
      "console.warn(`sign-in refused: ${parsed.data.newAuthSecret}`);",
      'console.error("derived", master, kek);',
      'console.warn("bot check", captchaToken);',
      'console.warn("session", session.accessToken);',
      'console.warn("change", { password: x });',
    ].join("\n");
    expect(consoleCalls(planted).map((c) => codeOnly(c.args).match(FORBIDDEN)?.[1])).toEqual(["authSecret", "email", "newAuthSecret", "master", "captchaToken", "accessToken", "password"]);
    // The same words inside the message's string are not code: allowed.
    expect(codeOnly('"[login] sign-in with the login secret (authSecret) and the email refused:", error.status').match(FORBIDDEN)).toBeNull();
    // Names that only contain one of them are not it.
    expect(codeOnly("p_email_hash, emailRedirectTo, kekFor").match(FORBIDDEN)).toBeNull();
  });

  it("reads strings as strings and template holes as code", () => {
    expect(codeOnly('"mail text body", id')).toBe('"", id');
    expect(codeOnly("`email ${row.id}: ${row.subject}`")).toMatch(/row\.subject/);
    expect(consoleCalls('console.warn("a", f(b)); // console.log(mail)\nconsole.log(x)').map((c) => c.args)).toEqual(['"a", f(b)', "x"]);
  });
});

/** console calls that pass a whole error object (`err` / `error` as an argument of its own). */
function wholeErrorObjects(source: string): number[] {
  return consoleCalls(source)
    .filter((c) => codeOnly(c.args).split(",").some((a) => /^\s*(err|error|e)\s*$/.test(a)))
    .map((c) => c.line);
}

describe("the inbound webhook logs an error by its message and code only", () => {
  const route = () => read(path.join(SRC, "app", "api", "inbound", "route.ts"));

  it("logs errors, and none as a whole object", () => {
    expect(consoleCalls(route()).filter((c) => c.method === "error").length).toBeGreaterThanOrEqual(2);
    expect(wholeErrorObjects(route())).toEqual([]);
  });

  it("negative control: a whole error object is caught", () => {
    expect(wholeErrorObjects('console.error("inbound: processing failed", err);\nconsole.error("x", error)\nconsole.error("ok", err.message)')).toEqual([1, 2]);
  });
});
