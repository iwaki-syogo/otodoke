import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * [iOS batch 1] Checks on the files of ios/ that no Swift test can see.
 * Task 1: ignore rules, settings, privacy manifest, the pinned supabase-swift.
 * Task 3: the DEBUG-only launch argument. Task 4: no device calendar / zone / locale in the logic.
 * Task 7: one write path. All tasks: no secret in ios/, and no test-architect stub left behind.
 */

const ROOT = path.resolve(__dirname, "../../..");
const IOS = path.join(ROOT, "ios");
const APP = path.join(IOS, "Otodoke");
const RESOLVED = path.join(IOS, "Otodoke.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved");

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name === "build" || name === "DerivedData" || name === ".build" || name.endsWith(".xcodeproj")) continue;
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const swiftFiles = (dir: string) => walk(dir).filter((f) => f.endsWith(".swift"));
const rel = (f: string) => path.relative(ROOT, f);

/** Source without // and /* *\/ comments and without string literals' contents kept (for counting calls). */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

describe("task 1: ios/.gitignore", () => {
  /**
   * Copies the repository's ignore files into a fresh repository, creates the paths for real and
   * asks git which ones `git add -A` would take. Real files and a real `add` answer the question
   * exactly, including a file un-ignored inside an ignored directory.
   */
  function wouldAdd(paths: string[]): Set<string> {
    const dir = mkdtempSync(path.join(os.tmpdir(), "otodoke-ignore-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: dir });
      cpSync(path.join(ROOT, ".gitignore"), path.join(dir, ".gitignore"));
      mkdirSync(path.join(dir, "ios"), { recursive: true });
      cpSync(path.join(IOS, ".gitignore"), path.join(dir, "ios/.gitignore"));
      for (const p of paths) {
        mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
        writeFileSync(path.join(dir, p), "x");
      }
      const out = execFileSync("git", ["-c", "core.excludesFile=/dev/null", "add", "-A", "--dry-run"], { cwd: dir, encoding: "utf8" });
      return new Set(
        out
          .split("\n")
          .map((l) => l.replace(/^add '/, "").replace(/'$/, ""))
          .filter(Boolean),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  const ignored = [
    "ios/Config/Secrets.xcconfig",
    "ios/Otodoke.xcodeproj/project.pbxproj",
    "ios/Otodoke.xcodeproj/xcshareddata/xcschemes/Otodoke.xcscheme",
    "ios/Otodoke.xcodeproj/project.xcworkspace/contents.xcworkspacedata",
    "ios/build/DerivedData/info.plist",
    "ios/DerivedData/x/info.plist",
    "ios/Otodoke.xcodeproj/xcuserdata/me.xcuserdatad/x.plist",
    "ios/Otodoke.xcarchive/Info.plist",
    "ios/Otodoke.ipa",
    "ios/Otodoke.app.dSYM.zip",
    "ios/ExportOptions.plist",
  ];
  const kept = [
    "ios/.gitignore",
    "ios/project.yml",
    "ios/Config/Base.xcconfig",
    "ios/Config/Secrets.xcconfig.example",
    "ios/Otodoke.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved",
    "ios/Otodoke/App/OtodokeApp.swift",
    "ios/Otodoke/Support/PrivacyInfo.xcprivacy",
    "ios/OtodokeTests/Fixtures/web-expected.json",
    "ios/OtodokeTests/SmokeTests.swift",
  ];

  it("exists", () => {
    expect(existsSync(path.join(IOS, ".gitignore"))).toBe(true);
  });

  it("keeps secrets, build output and the generated project out of git", () => {
    const added = wouldAdd([...ignored, ...kept]);
    for (const p of ignored) expect(added.has(p), `${p} must be ignored`).toBe(false);
  });

  it("still tracks the sources, the settings example and Package.resolved inside the generated project", () => {
    const added = wouldAdd([...ignored, ...kept]);
    for (const p of kept) expect(added.has(p), `${p} must be tracked`).toBe(true);
  });
});

describe("task 1: settings and secrets", () => {
  it("Base.xcconfig reads Secrets.xcconfig only if it is there", () => {
    const base = readFileSync(path.join(IOS, "Config/Base.xcconfig"), "utf8");
    expect(base).toMatch(/^#include\?\s+"Secrets\.xcconfig"/m);
  });

  it("Secrets.xcconfig.example names the three keys and holds no value", () => {
    const example = readFileSync(path.join(IOS, "Config/Secrets.xcconfig.example"), "utf8");
    const assignments = example
      .split("\n")
      .filter((l) => !l.trim().startsWith("//") && l.includes("="))
      .map((l) => l.split("=")[0].trim());
    expect(assignments.sort()).toEqual(["INBOUND_DOMAIN", "SUPABASE_ANON_KEY", "SUPABASE_URL"]);
    expect(example).not.toMatch(/eyJhbGciOi/);
    expect(example).not.toMatch(/[a-z]{20}\.supabase\.co/);
    // How to write a URL in an xcconfig, where // starts a comment.
    expect(example).toContain("https:/$()/");
  });

  it("no file under ios/ holds this project's ref, a JWT, or another service's key", () => {
    const texts = walk(IOS).filter((f) => /\.(swift|yml|yaml|xcconfig|example|plist|xcprivacy|json|resolved|md|txt|strings)$/.test(f));
    expect(texts.length).toBeGreaterThan(0);
    for (const f of texts) {
      const s = readFileSync(f, "utf8");
      expect(s, rel(f)).not.toContain("zvqaqdmlxghekasjqneq");
      expect(s, rel(f)).not.toMatch(/eyJhbGciOi[A-Za-z0-9_-]{10,}/);
      expect(s, rel(f)).not.toMatch(/service_role|sk-ant-|\bre_[A-Za-z0-9]{20,}/);
    }
  });
});

describe("task 1: project.yml and the pinned package", () => {
  function dump(): Record<string, unknown> {
    const out = execFileSync("xcodegen", ["dump", "--spec", path.join(IOS, "project.yml"), "--type", "json", "--no-env"], { encoding: "utf8" });
    return JSON.parse(out);
  }

  it("has the three targets, the team, the bundle id and iOS 17", () => {
    const spec = dump();
    const text = JSON.stringify(spec);
    const targets = Object.keys((spec.targets ?? {}) as object).sort();
    expect(targets).toEqual(["Otodoke", "OtodokeTests", "OtodokeUITests"]);
    expect(text).toContain("9SVPJ6X69X");
    expect(text).toContain("com.iwakisyogo.otodoke");
    // options.deploymentTarget.iOS, a target's deploymentTarget, or the build setting; quoted or not.
    expect(text).toMatch(/"(iOS|deploymentTarget|IPHONEOS_DEPLOYMENT_TARGET)"\s*:\s*"?17(\.0)?"?[,}\s]/);
  });

  it("pins supabase-swift to one exact version from its official repository", () => {
    const spec = dump() as { packages?: Record<string, { url?: string; exactVersion?: string; version?: string }> };
    const pkgs = Object.values(spec.packages ?? {});
    const supabase = pkgs.find((p) => p.url?.replace(/\.git$/, "") === "https://github.com/supabase/supabase-swift");
    expect(supabase, "supabase-swift package").toBeDefined();
    expect(supabase?.exactVersion ?? "", "exactVersion").toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("commits Package.resolved, and it pins the same supabase-swift version", () => {
    expect(existsSync(RESOLVED), rel(RESOLVED)).toBe(true);
    const resolved = JSON.parse(readFileSync(RESOLVED, "utf8")) as { pins?: { location?: string; state?: { version?: string } }[] };
    const pin = (resolved.pins ?? []).find((p) => p.location?.replace(/\.git$/, "") === "https://github.com/supabase/supabase-swift");
    const spec = dump() as { packages?: Record<string, { url?: string; exactVersion?: string }> };
    const declared = Object.values(spec.packages ?? {}).find((p) => p.url?.replace(/\.git$/, "") === "https://github.com/supabase/supabase-swift");
    expect(pin?.state?.version).toBe(declared?.exactVersion);
  });
});

describe("task 1: privacy manifest", () => {
  it("declares no tracking and the e-mail address, linked, for app functionality", () => {
    const file = path.join(APP, "Support/PrivacyInfo.xcprivacy");
    const json = JSON.parse(execFileSync("plutil", ["-convert", "json", "-o", "-", file], { encoding: "utf8" }));
    expect(json.NSPrivacyTracking).toBe(false);
    expect(json.NSPrivacyTrackingDomains ?? []).toEqual([]);
    const email = (json.NSPrivacyCollectedDataTypes ?? []).find(
      (d: { NSPrivacyCollectedDataType?: string }) => d.NSPrivacyCollectedDataType === "NSPrivacyCollectedDataTypeEmailAddress",
    );
    expect(email).toBeDefined();
    expect(email.NSPrivacyCollectedDataTypeLinked).toBe(true);
    expect(email.NSPrivacyCollectedDataTypeTracking).toBe(false);
    expect(email.NSPrivacyCollectedDataTypePurposes).toContain("NSPrivacyCollectedDataTypePurposeAppFunctionality");
  });
});

describe("task 3: the launch argument that starts at code entry is DEBUG only", () => {
  const ARG = "-otodoke-start-at-code";

  /** Line numbers of `#if DEBUG` blocks (the #else part is outside). Nested #if are tracked. */
  function debugOnlyLines(src: string): Set<number> {
    const lines = src.split("\n");
    const inside = new Set<number>();
    const stack: boolean[] = [];
    lines.forEach((line, i) => {
      const t = line.trim();
      if (/^#if\b/.test(t)) stack.push(/^#if\s+DEBUG\b/.test(t));
      else if (/^#elseif\b/.test(t) || /^#else\b/.test(t)) stack[stack.length - 1] = false;
      else if (/^#endif\b/.test(t)) stack.pop();
      else if (stack.includes(true)) inside.add(i);
    });
    return inside;
  }

  it("appears in the app's sources only inside #if DEBUG", () => {
    const files = swiftFiles(APP);
    let seen = 0;
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      const inside = debugOnlyLines(src);
      src.split("\n").forEach((line, i) => {
        if (line.includes(ARG)) {
          seen += 1;
          expect(inside.has(i), `${rel(f)}:${i + 1} uses ${ARG} outside #if DEBUG`).toBe(true);
        }
      });
    }
    expect(seen, `${ARG} is handled somewhere in ios/Otodoke`).toBeGreaterThan(0);
  });
});

describe("task 4: the logic never reads the device's calendar, time zone or locale", () => {
  it("ios/Otodoke/Logic uses explicit Asia/Tokyo and Gregorian values", () => {
    const files = swiftFiles(path.join(APP, "Logic"));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const src = stripComments(readFileSync(f, "utf8"));
      expect(src, rel(f)).not.toMatch(/\b(Calendar|TimeZone|Locale)\.(current|autoupdatingCurrent)\b/);
      expect(src, rel(f)).not.toMatch(/NSTimeZone\.(default|local|system)\b/);
    }
  });
});

describe("task 7: one write path", () => {
  it("parcels are written by exactly one function, in ios/Otodoke/Data/ParcelWriter.swift", () => {
    const writes: string[] = [];
    for (const f of swiftFiles(APP)) {
      const src = stripComments(readFileSync(f, "utf8"));
      const n = (src.match(/\.update\(/g) ?? []).length + (src.match(/"PATCH"/g) ?? []).length;
      for (let i = 0; i < n; i++) writes.push(rel(f));
    }
    expect(writes).toEqual(["ios/Otodoke/Data/ParcelWriter.swift"]);
  });
});

describe("all tasks: no test-architect stub is left", () => {
  it("no file in ios/Otodoke still carries the TDD-STUB marker", () => {
    const left = swiftFiles(APP).filter((f) => readFileSync(f, "utf8").includes("TDD-STUB"));
    expect(left.map(rel)).toEqual([]);
  });
});
