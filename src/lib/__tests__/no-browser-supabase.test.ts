import path from "node:path";
import { describe, expect, it } from "vitest";
import { appSourceFiles, read, SRC, withoutComments } from "./source-scan";

/**
 * No Supabase client and no Supabase key reach the browser's JavaScript.
 *
 * A module that a "use client" module imports (directly or through others) is bundled for the
 * browser, and every `process.env.NEXT_PUBLIC_*` it names is written into that bundle. With the
 * anon key and the project URL in public JS, anybody can call Supabase Auth directly (/otp,
 * /signup) past the app's own login-mail limit and Turnstile. So the browser has no Supabase
 * client: it reads its wrapped keys and sealed mail through Server Actions
 * (src/app/app/settings/key-actions.ts).
 *
 * The walk follows imports from every "use client" module. A "use server" module is not followed:
 * the client gets only a reference to call it, never its code. Type-only imports are not followed
 * either (they are erased).
 */

const FORBIDDEN = /createBrowserClient|NEXT_PUBLIC_SUPABASE_ANON_KEY|NEXT_PUBLIC_SUPABASE_URL|SUPABASE_SERVICE_ROLE_KEY|from\s+["']@supabase\//;

const isClient = (source: string) => /^\s*["']use client["']/.test(withoutComments(source));
const isServerActions = (source: string) => /^\s*["']use server["']/.test(withoutComments(source));

/** Module specifiers a source imports or re-exports, type-only imports left out. */
function importsOf(source: string): string[] {
  const code = withoutComments(source);
  const out: string[] = [];
  const re = /(?:^|\n)\s*(import|export)\s+(type\s+)?(?:[^"';]*?\s+from\s+)?["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code))) if (!m[2]) out.push(m[3]);
  // Dynamic imports are bundled too.
  for (const d of code.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)) out.push(d[1]);
  return out;
}

/** The file a specifier points to inside src/, or null for a package. */
function resolve(from: string, spec: string, exists: (f: string) => boolean): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = path.join(SRC, spec.slice(2));
  else if (spec.startsWith(".")) base = path.resolve(path.dirname(from), spec);
  else return null;
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts"), path.join(base, "index.tsx")]) {
    if (exists(candidate)) return candidate;
  }
  return null;
}

/**
 * Every module bundled for the browser that names a Supabase client or key, as
 * "<module> (reached from <client module>)". `files` maps absolute paths to sources.
 */
function browserSupabaseProblems(files: Map<string, string>): string[] {
  const rel = (f: string) => path.relative(process.cwd(), f);
  const problems = new Set<string>();
  for (const [entry, entrySource] of files) {
    if (!isClient(entrySource)) continue;
    const seen = new Set<string>();
    const queue = [entry];
    while (queue.length > 0) {
      const file = queue.pop()!;
      if (seen.has(file)) continue;
      seen.add(file);
      const source = files.get(file)!;
      if (file !== entry && isServerActions(source)) continue;
      if (FORBIDDEN.test(withoutComments(source))) problems.add(`${rel(file)} (reached from ${rel(entry)})`);
      for (const spec of importsOf(source)) {
        if (/^@supabase\//.test(spec)) problems.add(`${rel(file)} imports ${spec} (reached from ${rel(entry)})`);
        const target = resolve(file, spec, (f) => files.has(f));
        if (target) queue.push(target);
      }
    }
  }
  return [...problems].sort();
}

const appFiles = () => new Map(appSourceFiles().map((f) => [f, read(f)]));

describe("no Supabase client or key in the browser's JavaScript", () => {
  it("finds the client modules it is about, and walks into what they import", () => {
    const files = appFiles();
    const clients = [...files].filter(([, s]) => isClient(s)).map(([f]) => path.relative(process.cwd(), f));
    expect(clients).toContain("src/lib/crypto/tab-key.ts");
    expect(clients).toContain("src/lib/crypto/password-flows.ts");
    expect(clients).toContain("src/app/app/parcels/[id]/sealed-mail.tsx");
    expect(clients).toContain("src/app/app/settings/password-panel.tsx");
    expect(clients).toContain("src/app/login/login-form.tsx");
    // The walk reaches the crypto code through the password flows (an import of an import).
    const flows = path.join(SRC, "lib/crypto/password-flows.ts");
    expect(importsOf(files.get(flows)!)).toContain("./key-wrap");
    expect(resolve(flows, "./key-wrap", (f) => files.has(f))).toBe(path.join(SRC, "lib/crypto/key-wrap.ts"));
  });

  it("no client module, nor anything it imports, names createBrowserClient, a Supabase key or @supabase/*", () => {
    expect(browserSupabaseProblems(appFiles())).toEqual([]);
  });

  it("the browser Supabase client module is gone", () => {
    expect(appSourceFiles().map((f) => path.relative(process.cwd(), f))).not.toContain("src/lib/supabase/client.ts");
  });

  it("negative control: a client module importing a browser client, two levels down, is caught; a server action is not followed", () => {
    const files = appFiles();
    const at = (p: string) => path.join(SRC, p);
    files.set(at("app/x/widget.tsx"), '"use client";\nimport { useThing } from "@/lib/x/thing";\nexport function W() { return useThing(); }\n');
    files.set(at("lib/x/thing.ts"), 'import { make } from "./make";\nexport const useThing = () => make();\n');
    files.set(at("lib/x/make.ts"), 'import { createBrowserClient } from "@supabase/ssr";\nexport const make = () => createBrowserClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);\n');
    // A client module calling a server action that uses the server client: fine.
    files.set(at("app/x/ok.tsx"), '"use client";\nimport { act } from "./actions";\nexport function O() { return act(); }\n');
    files.set(at("app/x/actions.ts"), '"use server";\nimport { createServerClient } from "@supabase/ssr";\nexport async function act() { return createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {} as never); }\n');
    // A type-only import is erased: fine.
    files.set(at("app/x/typed.tsx"), '"use client";\nimport type { Database } from "@/lib/x/make";\nexport type D = Database;\n');
    expect(browserSupabaseProblems(files)).toEqual(["src/lib/x/make.ts (reached from src/app/x/widget.tsx)", "src/lib/x/make.ts imports @supabase/ssr (reached from src/app/x/widget.tsx)"]);
  });
});
