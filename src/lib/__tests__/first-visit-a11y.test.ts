import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withoutComments } from "./source-scan";

/**
 * What a judge touches before logging in (/, /login, /login/forgot, /signup, /reset-password,
 * /privacy, /guide/forwarding): every field is named by its label, the back link is named by the
 * wordmark alone, the hints are tied to the fields, and every focus keeps an outline.
 */

const SRC = path.join(process.cwd(), "src");
const read = (rel: string) => withoutComments(readFileSync(path.join(SRC, rel), "utf8"));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f);
    if (statSync(p).isDirectory()) return f === "__tests__" ? [] : sourceFiles(p);
    return /\.(tsx|ts)$/.test(f) ? [p] : [];
  });
}

/** Every self-closing <input ... /> tag in a source, as text. */
function inputTags(src: string): string[] {
  return src.match(/<input\b[\s\S]*?\/>/g) ?? [];
}

describe("labels", () => {
  const forms: Array<[string, string[]]> = [
    ["app/login/login-form.tsx", ["login-email", "login-password"]],
    ["app/signup/signup-form.tsx", ["signup-email", "signup-password", "signup-password-again"]],
    ["app/login/forgot/forgot-form.tsx", ["forgot-email"]],
    ["app/reset-password/reset-form.tsx", ["reset-password", "reset-password-again"]],
  ];
  for (const [file, ids] of forms) {
    it(`${file}: each field has a label with the same htmlFor and id`, () => {
      const src = read(file);
      for (const id of ids) {
        expect(src).toContain(`htmlFor="${id}"`);
        expect(inputTags(src).some((t) => t.includes(`id="${id}"`))).toBe(true);
      }
    });
  }

  it("no <label> in src is left without htmlFor unless it wraps its field", () => {
    for (const f of sourceFiles(SRC).filter((x) => x.endsWith(".tsx"))) {
      const src = withoutComments(readFileSync(f, "utf8"));
      for (const m of src.matchAll(/<label\b([^>]*)>([\s\S]*?)<\/label>/g)) {
        expect(m[1].includes("htmlFor=") || /<(input|select|textarea)\b/.test(m[2]), `${f}: ${m[0].slice(0, 60)}`).toBe(true);
      }
    }
  });
});

describe("back link", () => {
  const pages = ["app/login/page.tsx", "app/signup/page.tsx", "app/login/forgot/page.tsx", "app/reset-password/page.tsx", "app/privacy/page.tsx", "app/guide/forwarding/page.tsx", "app/account-deleted/page.tsx"];
  for (const file of pages) {
    it(`${file}: the arrow is aria-hidden, so the link is named by the wordmark`, () => {
      const src = read(file);
      expect(src).toContain('<span aria-hidden="true">←</span> <Wordmark');
      expect(src).not.toMatch(/[^>]←\s*<Wordmark/);
    });
  }
});

describe("hints and errors", () => {
  it("the password rule is referenced by both password fields on /signup and /reset-password", () => {
    const cases: Array<[string, string, string[]]> = [
      ["app/signup/signup-form.tsx", "signup-password-rule", ["signup-password", "signup-password-again"]],
      ["app/reset-password/reset-form.tsx", "reset-password-rule", ["reset-password", "reset-password-again"]],
    ];
    for (const [file, id, fields] of cases) {
      const src = read(file);
      expect(src).toContain(`id="${id}"`);
      for (const f of fields) expect(inputTags(src).find((t) => t.includes(`id="${f}"`))).toContain(`aria-describedby="${id}"`);
    }
  });

  it("the settings password fields point at their rule too", () => {
    const src = read("app/app/settings/password-panel.tsx");
    expect(src).toContain('id="settings-password-rule"');
    expect(src.match(/aria-describedby="settings-password-rule"/g)).toHaveLength(2);
  });

  it("errors after a submit are announced", () => {
    expect(read("app/login/login-form.tsx")).toMatch(/role="alert"[^>]*>\s*\{notice\.text\}/);
    expect(read("app/signup/signup-form.tsx")).toMatch(/role="alert"[^>]*>\s*\{error\}/);
    expect(read("app/signup/signup-form.tsx")).toContain('role="alert" className="text-sm text-red-800"');
    expect(read("app/login/forgot/forgot-form.tsx")).toContain('role={answer.ok ? "status" : "alert"}');
    expect(read("app/reset-password/reset-form.tsx")).toContain('role="alert"');
  });
});

describe("focus", () => {
  it("nothing in the shared components or the first-visit files drops the outline without a focus-visible one", () => {
    const files = [
      ...sourceFiles(path.join(SRC, "components")),
      ...sourceFiles(path.join(SRC, "app/login")),
      ...sourceFiles(path.join(SRC, "app/signup")),
      path.join(SRC, "app/page.tsx"),
      path.join(SRC, "app/privacy/page.tsx"),
      path.join(SRC, "app/reset-password/reset-form.tsx"),
    ];
    for (const f of files) {
      const src = withoutComments(readFileSync(f, "utf8"));
      for (const m of src.matchAll(/"[^"\n]*\boutline-none\b[^"\n]*"/g)) expect(m[0], f).toContain("focus-visible:outline");
    }
  });

  it("the shared field and button looks have a visible focus outline", () => {
    expect(read("app/login/form-style.ts").match(/focus-visible:outline-2/g)).toHaveLength(2);
  });
});

describe("phone width", () => {
  it("the chip row of the forwarding guide wraps", () => {
    expect(read("app/guide/forwarding/page.tsx")).toMatch(/<nav className="[^"]*\bflex-wrap\b/);
  });

  it("the Gmail filter breaks instead of widening the page", () => {
    expect(read("components/forwarding-steps.tsx")).toContain("min-w-0 flex-1 break-all");
  });

  it("the small links under the forms have a tap area (py-2)", () => {
    for (const file of ["app/login/page.tsx", "app/signup/signup-form.tsx", "app/login/forgot/page.tsx"]) {
      const found = [...read(file).matchAll(/<Link href="\/(privacy|login|signup)[^"]*"[^>]*className="([^"]*)"/g)];
      expect(found.length, file).toBeGreaterThan(0);
      for (const m of found) expect(m[2], file).toContain("py-2");
    }
  });
});
