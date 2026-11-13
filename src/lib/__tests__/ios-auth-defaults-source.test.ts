import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The iOS AuthService keeps a signed-out mark in the UserDefaults it is given. Only the app's launch may pass
 * `.standard`; tests and DEBUG previews pass their own throwaway suite. The init has no default, so a missed
 * call site stops at compile time, and this file pins who may build one outside DEBUG.
 */
const ROOT = path.resolve(__dirname, "../../..");
const read = (p: string) => (existsSync(path.join(ROOT, p)) ? readFileSync(path.join(ROOT, p), "utf8") : "");

/** The source with every line inside `#if DEBUG` ... `#endif` removed (nested #if counted; `#else` of a DEBUG block is still inside it). */
export function outsideDebug(src: string): string {
  const out: string[] = [];
  const stack: boolean[] = []; // true = this #if opened a DEBUG region
  let depth = 0; // number of open DEBUG regions
  for (const line of src.split("\n")) {
    const t = line.trim();
    if (/^#if\b/.test(t)) {
      const isDebug = /^#if\s+DEBUG\s*$/.test(t);
      stack.push(isDebug);
      if (isDebug) depth++;
      continue;
    }
    if (/^#endif\b/.test(t)) {
      if (stack.pop()) depth--;
      continue;
    }
    if (/^#else\b|^#elseif\b/.test(t)) continue;
    if (depth === 0) out.push(line);
  }
  return out.join("\n");
}

function swiftFiles(dir: string): string[] {
  const abs = path.join(ROOT, dir);
  if (!existsSync(abs)) return [];
  return readdirSync(abs, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".swift"))
    .map((e) => path.join(e.parentPath ?? (e as unknown as { path: string }).path, e.name));
}

/** Every `AuthService(` creation outside DEBUG, as "file: line". */
export function creationsOutsideDebug(files: Array<{ name: string; src: string }>): string[] {
  const found: string[] = [];
  for (const f of files) {
    for (const line of outsideDebug(f.src).split("\n")) {
      if (/\bAuthService\(/.test(line) && !/^\s*(\/\/|\*)/.test(line)) found.push(`${f.name}: ${line.trim()}`);
    }
  }
  return found;
}

/** The only creation outside DEBUG must be the app's launch, passing `.standard`. */
export function launchProblems(files: Array<{ name: string; src: string }>): string[] {
  const found = creationsOutsideDebug(files);
  const problems: string[] = [];
  if (found.length !== 1) problems.push(`expected 1 creation outside DEBUG, found ${found.length}`);
  for (const f of found) {
    if (!f.startsWith("OtodokeApp.swift:")) problems.push(`creation outside the app launch: ${f}`);
    else if (!/userDefaults:\s*\.standard\b/.test(f)) problems.push(`launch does not pass .standard: ${f}`);
  }
  return problems;
}

const APP = swiftFiles("ios/Otodoke").map((p) => ({ name: path.basename(p), src: readFileSync(p, "utf8") }));
const SERVICE = read("ios/Otodoke/Auth/AuthService.swift");

describe("iOS AuthService UserDefaults", () => {
  it("reads the app sources", () => {
    expect(APP.length).toBeGreaterThan(20);
    expect(SERVICE).not.toBe("");
  });

  it("is created outside DEBUG only by the app launch, with .standard", () => {
    expect(launchProblems(APP)).toEqual([]);
  });

  it("has no default for the init's userDefaults", () => {
    const init = SERVICE.match(/\binit\(provider: SupabaseProvider.*\) \{/)?.[0] ?? "";
    expect(init).toContain("userDefaults: UserDefaults");
    expect(init).not.toMatch(/userDefaults:\s*UserDefaults\s*=/);
  });

  it("negative control: the launch passing a throwaway suite fails", () => {
    const changed = APP.map((f) =>
      f.name === "OtodokeApp.swift" ? { ...f, src: f.src.replace("userDefaults: .standard", 'userDefaults: UserDefaults(suiteName: "x")!') } : f,
    );
    expect(launchProblems(changed).length).toBeGreaterThan(0);
  });

  it("negative control: a second creation outside DEBUG fails", () => {
    const changed = [...APP, { name: "Extra.swift", src: "func f() { _ = AuthService(provider: p, userDefaults: .standard) }" }];
    expect(launchProblems(changed).length).toBeGreaterThan(0);
  });

  it("counts nested #if correctly", () => {
    const src = ["#if DEBUG", "#if os(iOS)", "A", "#endif", "B", "#else", "C", "#endif", "D", "#if os(iOS)", "E", "#else", "F", "#endif"].join("\n");
    expect(outsideDebug(src).split("\n")).toEqual(["D", "E", "F"]);
  });
});
