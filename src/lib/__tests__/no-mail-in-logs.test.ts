import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SRC, appSourceFiles, codeOnly, consoleCalls, read } from "./source-scan";

/**
 * No console call in the app may print a mail's content or a passphrase. Server logs (Vercel)
 * are kept outside the database and would undo the encryption of stored mail.
 *
 * A call is refused when the code among its arguments (string contents ignored, `${...}` kept)
 * names any of these. Log ids, counts, statuses and error messages instead.
 */
const FORBIDDEN = /\b(subject|text_body|html_body|from_name|from_address|fromName|text|html|body|bodies|mail|mails|recipients|plaintext|passphrase|pkcs8|privateKey|challenge|envelope|body_envelope|extraction|result)\b/;

function violations(files: string[]): string[] {
  const found: string[] = [];
  for (const file of files) {
    for (const call of consoleCalls(read(file))) {
      const code = codeOnly(call.args);
      const hit = code.match(FORBIDDEN);
      if (hit) found.push(`${path.relative(process.cwd(), file)}:${call.line} console.${call.method}(… ${hit[1]} …)`);
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

  it("negative control: a planted violation in a real file under src/ is caught, then removed", () => {
    const planted = path.join(SRC, "lib", "zz-planted-log-violation.ts");
    try {
      writeFileSync(planted, 'export function f(mail: { subject: string }) {\n  console.error("read failed:", `${mail.subject}`);\n}\n');
      expect(violations(appSourceFiles())).toEqual(["src/lib/zz-planted-log-violation.ts:2 console.error(… mail …)"]);
    } finally {
      rmSync(planted, { force: true });
    }
    expect(violations(appSourceFiles())).toEqual([]);
  });

  it("reads strings as strings and template holes as code", () => {
    expect(codeOnly('"mail text body", id')).toBe('"", id');
    expect(codeOnly("`email ${row.id}: ${row.subject}`")).toMatch(/row\.subject/);
    expect(consoleCalls('console.warn("a", f(b)); // console.log(mail)\nconsole.log(x)').map((c) => c.args)).toEqual(['"a", f(b)', "x"]);
  });
});
