import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * [iOS M2+password-v1, review fix 2] Checks on ios/ that no Swift test can see:
 *  - N-2: the tabs live as long as one signed-in generation (RootView ties MainTabView(auth:) to it with .id);
 *  - N-4 / Should (verify): the test-only hook (afterSignInAnswer) and the test host's check
 *    (XCTestConfigurationFilePath) are DEBUG only: the Release .app holds neither name (strings), the Debug
 *    build holds both (the positive control). Run with OTODOKE_RELEASE_APP / OTODOKE_TEST_BUNDLE.
 */

const ROOT = path.resolve(__dirname, "../../..");
const read = (p: string) => readFileSync(path.join(ROOT, p), "utf8");

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

/** The names that only DEBUG builds may hold. */
const DEBUG_ONLY_NAMES = ["afterSignInAnswer", "XCTestConfigurationFilePath"];

/** Every file under `dir` through `strings -a`, with the DEBUG-only names found. */
function debugNameHits(dir: string, files: string[] = walk(dir)): string[] {
  const hits: string[] = [];
  for (const f of files) {
    const out = execFileSync("strings", ["-a", f], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
    for (const name of DEBUG_ONLY_NAMES) if (out.includes(name)) hits.push(`${path.relative(dir, f)}: ${name}`);
  }
  return hits;
}

describe("N-2: the tabs live as long as the signed-in generation", () => {
  it("RootView gives MainTabView(auth:) the generation as its identity", () => {
    const src = read("ios/Otodoke/App/RootView.swift");
    expect(src).toMatch(/MainTabView\(auth: auth\)\s*\n\s*\.id\(auth\.session\.value\)/);
  });
});

describe("N-4: DEBUG-only names stay out of the Release .app (strings)", () => {
  it("the check finds a planted name and passes a clean bundle (negative and positive control)", () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "otodoke-debug-names-"));
    try {
      const clean = path.join(tmp, "Clean.app");
      mkdirSync(clean, { recursive: true });
      writeFileSync(path.join(clean, "Clean"), Buffer.from("\u0000afterSignIn and XCTest words apart\u0000"));
      expect(debugNameHits(clean)).toEqual([]);
      const planted = path.join(tmp, "Planted.app");
      mkdirSync(planted, { recursive: true });
      writeFileSync(path.join(planted, "Planted"), Buffer.from(`\u0000${DEBUG_ONLY_NAMES.join("\u0000")}\u0000`));
      expect(debugNameHits(planted)).toEqual(DEBUG_ONLY_NAMES.map((n) => `Planted: ${n}`));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("the app's source names them only inside #if DEBUG", () => {
    for (const file of ["ios/Otodoke/Auth/AuthService.swift", "ios/Otodoke/App/OtodokeApp.swift"]) {
      const lines = read(file).split("\n");
      const stack: boolean[] = [];
      lines.forEach((line, i) => {
        const t = line.trim();
        if (/^#if\b/.test(t)) stack.push(/^#if\s+DEBUG\b/.test(t));
        else if (/^#elseif\b/.test(t) || /^#else\b/.test(t)) stack[stack.length - 1] = false;
        else if (/^#endif\b/.test(t)) stack.pop();
        else if (DEBUG_ONLY_NAMES.some((n) => line.includes(n))) expect(stack.includes(true), `${file}:${i + 1}`).toBe(true);
      });
    }
  });

  const release = process.env.OTODOKE_RELEASE_APP;
  const testBundle = process.env.OTODOKE_TEST_BUNDLE;

  /**
   * The app's own object files (Objects-normal) of a built Otodoke.app. The linked packages (Point-Free's issue
   * reporting) hold the XCTest name themselves, so that name is looked for in the app's own code only.
   */
  function ownObjects(app: string): string {
    const m = app.match(/^(.*)\/Build\/Products\/(Debug|Release)-iphonesimulator\//);
    if (!m) throw new Error(`not a built Otodoke.app path: ${app}`);
    return path.join(m[1], "Build/Intermediates.noindex/Otodoke.build", `${m[2]}-iphonesimulator`, "Otodoke.build/Objects-normal");
  }

  /** Only the compiled objects of the app (not the linked binary next to them). */
  function objectFiles(dir: string): string[] {
    return walk(dir).filter((f) => f.endsWith(".o"));
  }

  it.runIf(Boolean(release))("the built Release Otodoke.app holds neither name (OTODOKE_RELEASE_APP)", () => {
    expect(existsSync(release!)).toBe(true);
    // afterSignInAnswer: nowhere in the app. XCTestConfigurationFilePath: nowhere in the app's own objects.
    expect(debugNameHits(release!).filter((h) => h.endsWith("afterSignInAnswer"))).toEqual([]);
    const objects = ownObjects(release!);
    expect(objectFiles(objects).length).toBeGreaterThan(0);
    expect(debugNameHits(objects, objectFiles(objects))).toEqual([]);
  });

  it.runIf(Boolean(testBundle))("the Debug build holds both (OTODOKE_TEST_BUNDLE's app, the positive control)", () => {
    expect(existsSync(testBundle!)).toBe(true);
    // The test bundle sits in the Debug Otodoke.app (PlugIns/OtodokeTests.xctest): that build's own objects are read.
    const objects = ownObjects(testBundle!);
    expect(objectFiles(objects).length).toBeGreaterThan(0);
    const found = new Set(debugNameHits(objects, objectFiles(objects)).map((h) => h.split(": ").pop()));
    for (const name of DEBUG_ONLY_NAMES) expect(found.has(name), name).toBe(true);
  });
});
