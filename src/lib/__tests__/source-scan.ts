/** Reading the app's own source for the guard tests. Only src/ is read (never env files). */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

export const SRC = path.join(process.cwd(), "src");

/** Every .ts / .tsx file under src/ that ships with the app (tests and their helpers left out). */
export function appSourceFiles(root = SRC): string[] {
  return (readdirSync(root, { recursive: true }) as string[])
    .filter((f) => /\.(ts|tsx)$/.test(f) && !f.split(path.sep).includes("__tests__") && !f.endsWith(".d.ts"))
    .map((f) => path.join(root, f));
}

export function read(file: string): string {
  return readFileSync(file, "utf8");
}

/** Comments removed, strings kept. Good enough for this codebase's style (no regex literals with //). */
export function withoutComments(source: string): string {
  let out = "";
  let i = 0;
  let quote: string | null = null;
  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];
    if (quote) {
      out += c;
      if (c === "\\") {
        out += next ?? "";
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      out += c;
      i++;
      continue;
    }
    if (c === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      i = end < 0 ? source.length : end + 2;
      continue;
    }
    if (c === "/" && next === "/") {
      const end = source.indexOf("\n", i);
      i = end < 0 ? source.length : end;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/**
 * The code inside a call's parentheses with string contents blanked, keeping `${...}` parts of
 * template strings (they are code). So `console.error("mail failed:", id)` reads as `"", id`.
 */
export function codeOnly(args: string): string {
  let out = "";
  let i = 0;
  while (i < args.length) {
    const c = args[i];
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < args.length && args[j] !== c) j += args[j] === "\\" ? 2 : 1;
      out += '""';
      i = j + 1;
      continue;
    }
    if (c === "`") {
      let j = i + 1;
      out += "`";
      while (j < args.length && args[j] !== "`") {
        if (args[j] === "\\") {
          j += 2;
          continue;
        }
        if (args[j] === "$" && args[j + 1] === "{") {
          let depth = 1;
          let k = j + 2;
          while (k < args.length && depth > 0) {
            if (args[k] === "{") depth++;
            if (args[k] === "}") depth--;
            k++;
          }
          out += ` ${args.slice(j + 2, k - 1)} `;
          j = k;
          continue;
        }
        j++;
      }
      out += "`";
      i = j + 1;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** Each `console.x(...)` call: the method and the text between its parentheses. */
export function consoleCalls(source: string): Array<{ method: string; args: string; line: number }> {
  const code = withoutComments(source);
  const calls: Array<{ method: string; args: string; line: number }> = [];
  const re = /\bconsole\.(\w+)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code))) {
    let depth = 1;
    let j = m.index + m[0].length;
    let quote: string | null = null;
    while (j < code.length && depth > 0) {
      const c = code[j];
      if (quote) {
        if (c === "\\") j++;
        else if (c === quote) quote = null;
      } else if (c === '"' || c === "'" || c === "`") quote = c;
      else if (c === "(") depth++;
      else if (c === ")") depth--;
      j++;
    }
    calls.push({ method: m[1], args: code.slice(m.index + m[0].length, j - 1), line: code.slice(0, m.index).split("\n").length });
  }
  return calls;
}
