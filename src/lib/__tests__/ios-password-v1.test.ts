import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * [iOS build 3, password-v1] What the Swift tests cannot see about the app's password-v1 parts
 * (docs/crypto/password-v1.md):
 *  - the vectors reach iOS through scripts/ios-fixtures.ts, never by hand: `--password-out <dir>` writes
 *    fixtures/crypto/password-v1.json byte for byte into <dir> (the default run writes it into
 *    ios/OtodokeTests/Fixtures/crypto/, which ios/.gitignore keeps out of git). `--crypto-out <dir>` keeps
 *    writing its two files only (ios-fixtures-m2.test.ts). .gitleaks.toml is not changed;
 *  - email_norm and password_norm are not Foundation's trimming, lowercasing or compatibility mapping;
 *  - master never takes the row's kdf_iterations, and a made row always records 600000;
 *  - the given-IV wrap is called only in KeyWrap.swift and KeyGeneration.swift, the given-key row only in
 *    KeyGeneration.swift (the app's path takes a new random IV, kdf_salt and key);
 *  - no log call, print or crash message names the password, master, the KEK or auth_secret; the new parts
 *    throw CryptoError only (it carries nothing from its input);
 *  - the passphrase route (a separate passphrase stretched by PBKDF2 with the row's round count) is gone:
 *    decided to remove it (nothing released; nobody has a passphrase). This block needs the test changes
 *    listed for approval (CryptoVectorTests' key-wrap tests, UnlockModelTests' LiveKeyDeriver tests, the
 *    GatedDeriver fake): it stays red until those are approved and made.
 */

const ROOT = path.resolve(__dirname, "../../..");
const APP = path.join(ROOT, "ios/Otodoke");
const CRYPTO = path.join(APP, "Crypto");
const SCRIPT = path.join(ROOT, "scripts/ios-fixtures.ts");
const TSX = path.join(ROOT, "node_modules/.bin/tsx");
const SOURCE = path.join(ROOT, "fixtures/crypto/password-v1.json");
const IOS_FILE = "ios/OtodokeTests/Fixtures/crypto/password-v1.json";
const FLAG = "--password-out";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const V: Any = JSON.parse(readFileSync(SOURCE, "utf8"));
const rel = (f: string) => path.relative(ROOT, f);

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const swiftFiles = (root = APP) => walk(root).filter((f) => f.endsWith(".swift"));
const readApp = (p: string) => (existsSync(path.join(ROOT, p)) ? readFileSync(path.join(ROOT, p), "utf8") : "");
const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"])\/\/.*$/gm, "$1");
const code = (p: string) => stripComments(readApp(p));

/** Every secret-like value of the vectors (the private key, and per case master, KEK, auth_secret, salts, wrap). */
function vectorSecrets(): string[] {
  const out = [V.private_key.d_hex, V.private_key.pkcs8_hex];
  for (const c of V.cases) out.push(c.master_hex, c.kek_hex, c.auth_secret, c.wrap_ciphertext_hex, c.user_keys_row.wrapped_private_key, c.user_keys_row.kdf_salt);
  return out;
}

// ---------------------------------------------------------------------------------------------
// The vectors for iOS.

let tmp = "";
let stdout = "";
const scriptHasFlag = () => readFileSync(SCRIPT, "utf8").includes(FLAG);

beforeAll(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "otodoke-ios-password-v1-"));
  // Until the script knows the flag, it is not run: without it the script would take the default run and
  // write into the repository.
  if (!scriptHasFlag()) return;
  execFileSync(TSX, [SCRIPT, FLAG, tmp], { cwd: ROOT, env: { ...process.env, TZ: "UTC" }, encoding: "utf8", timeout: 60_000 });
  stdout = execFileSync(TSX, [SCRIPT, "--stdout"], { cwd: ROOT, env: { ...process.env, TZ: "UTC" }, encoding: "utf8", timeout: 60_000 });
}, 180_000);

afterAll(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

function sameBytes(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && a.equals(b);
}

describe("password-v1: the vectors reach iOS through scripts/ios-fixtures.ts", () => {
  it(`the script takes ${FLAG} <dir> and copies the canonical file (never a hand-written one)`, () => {
    const src = stripComments(readFileSync(SCRIPT, "utf8"));
    expect(scriptHasFlag()).toBe(true);
    expect(src).toMatch(/fixtures\/crypto\/password-v1\.json/);
  });

  it(`${FLAG} writes exactly password-v1.json`, () => {
    expect(readdirSync(tmp).sort()).toEqual(["password-v1.json"]);
  });

  it("password-v1.json is the canonical file byte for byte", () => {
    const written = path.join(tmp, "password-v1.json");
    expect(existsSync(written)).toBe(true);
    expect(sameBytes(readFileSync(written), readFileSync(SOURCE))).toBe(true);
  });

  it("negative control: one byte changed, or one byte short, is not the same", () => {
    const copy = Buffer.from(readFileSync(SOURCE));
    copy[100] ^= 0x01;
    expect(sameBytes(copy, readFileSync(SOURCE))).toBe(false);
    expect(sameBytes(readFileSync(SOURCE).subarray(0, -1), readFileSync(SOURCE))).toBe(false);
  });

  it("the default place is ignored by git and nothing there is tracked", () => {
    expect(() => execFileSync("git", ["check-ignore", "-q", IOS_FILE], { cwd: ROOT })).not.toThrow();
    expect(execFileSync("git", ["ls-files", IOS_FILE], { cwd: ROOT, encoding: "utf8" }).trim()).toBe("");
  });

  it("no password-v1 value goes into web-expected.json (committed) or --stdout", () => {
    expect(stdout.length).toBeGreaterThan(0);
    const committed = readFileSync(path.join(ROOT, "ios/OtodokeTests/Fixtures/web-expected.json"), "utf8");
    for (const secret of vectorSecrets()) {
      expect(stdout.includes(secret), secret.slice(0, 8)).toBe(false);
      expect(committed.includes(secret), secret.slice(0, 8)).toBe(false);
    }
  });

  it("no app source names the vector file or holds its values", () => {
    for (const f of swiftFiles()) {
      const src = readFileSync(f, "utf8");
      expect(src.includes("password-v1.json"), rel(f)).toBe(false);
      for (const secret of [...vectorSecrets(), V.private_key.key_id]) expect(src.includes(secret), `${rel(f)} has ${secret.slice(0, 8)}`).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// The Swift parts.

const PASSWORD_V1 = "ios/Otodoke/Crypto/PasswordV1.swift";
const KEY_GENERATION = "ios/Otodoke/Crypto/KeyGeneration.swift";
const KEY_WRAP = "ios/Otodoke/Crypto/KeyWrap.swift";

/** What email_norm and password_norm must not be made with (the spec's "Do not use the platform's own functions"). */
const PLATFORM_TEXT_FUNCTIONS =
  /\btrimmingCharacters\s*\(|\.(?:lowercased|uppercased)\s*\(|\blocalizedLowercase\b|\blocalizedUppercase\b|\bcapitalized\b|\bfolding\s*\(|\bprecomposedStringWithCompatibilityMapping\b|\bapplyingTransform\s*\(|\.whitespacesAndNewlines\b|\.whitespaces\b/g;
const NFKC_RECIPE = /\.decomposedStringWithCompatibilityMapping\s*\.\s*precomposedStringWithCanonicalMapping\b/;

function textFunctionViolations(src: string): string[] {
  return [...stripComments(src).matchAll(PLATFORM_TEXT_FUNCTIONS)].map((m) => m[0].replace(/\s+/g, ""));
}

describe("password-v1: email_norm and password_norm are the spec's, not Foundation's", () => {
  it("PasswordV1.swift and KeyGeneration.swift exist", () => {
    expect(existsSync(path.join(ROOT, PASSWORD_V1))).toBe(true);
    expect(existsSync(path.join(ROOT, KEY_GENERATION))).toBe(true);
  });

  it("PasswordV1.swift uses no trimming, case mapping or compatibility mapping of the platform", () => {
    expect(textFunctionViolations(readApp(PASSWORD_V1))).toEqual([]);
  });

  it("password_norm is the compatibility decomposition then the canonical composition", () => {
    expect(code(PASSWORD_V1)).toMatch(NFKC_RECIPE);
  });

  it("email_norm works on unicodeScalars", () => {
    expect(code(PASSWORD_V1)).toMatch(/\bunicodeScalars\b/);
  });

  it("negative control: the scan finds each forbidden call planted, and passes the recipe and comments", () => {
    const planted = [
      "let a = email.trimmingCharacters(in: .whitespacesAndNewlines)",
      "let b = a.lowercased()",
      "let c = password.precomposedStringWithCompatibilityMapping",
      "let d = email.folding(options: .caseInsensitive, locale: nil)",
    ].join("\n");
    expect(textFunctionViolations(planted)).toEqual([
      "trimmingCharacters(",
      ".whitespacesAndNewlines",
      ".lowercased(",
      "precomposedStringWithCompatibilityMapping",
      "folding(",
    ]);
    const clean = "// not trimmingCharacters(in:) or lowercased()\nlet n = p.decomposedStringWithCompatibilityMapping.precomposedStringWithCanonicalMapping\n";
    expect(textFunctionViolations(clean)).toEqual([]);
    expect(stripComments(clean)).toMatch(NFKC_RECIPE);
    expect("let n = p.precomposedStringWithCompatibilityMapping").not.toMatch(NFKC_RECIPE);
  });
});

describe("password-v1: the round count and the randomness", () => {
  it("master never reads the row's kdf_iterations", () => {
    expect(code(PASSWORD_V1)).not.toMatch(/\.kdfIterations\b/);
    expect(code(KEY_GENERATION)).not.toMatch(/\.kdfIterations\b/);
    expect(code(PASSWORD_V1)).toMatch(/\biterations\s*=\s*600_?000\b/);
  });

  it("a made row records PasswordV1.iterations", () => {
    expect(code(KEY_GENERATION)).toMatch(/kdfIterations:\s*PasswordV1\.iterations\b/);
  });

  it("the app's wrap and the made row take their IV, kdf_salt and key from a secure random source", () => {
    expect(code(KEY_WRAP)).toMatch(/SecRandomCopyBytes|AES\.GCM\.Nonce\(\)|SystemRandomNumberGenerator/);
    expect(code(KEY_GENERATION)).toMatch(/SecRandomCopyBytes|SystemRandomNumberGenerator|SymmetricKey\(size:/);
    expect(code(KEY_GENERATION)).toMatch(/P256\.KeyAgreement\.PrivateKey\(\)|AgreementPrivate\(\)/);
  });

  it("the given-IV wrap and the given-key row are called only by the parts that make a row", () => {
    const found: string[] = [];
    for (const f of swiftFiles()) {
      const src = stripComments(readFileSync(f, "utf8"));
      const name = path.basename(f);
      for (const m of src.matchAll(/KeyWrap\s*\.\s*wrap\s*\(([^)]*)\)/g)) if (/\biv:/.test(m[1]) && !["KeyWrap.swift", "KeyGeneration.swift"].includes(name)) found.push(`${rel(f)} KeyWrap.wrap(…iv:)`);
      for (const m of src.matchAll(/KeyGeneration\s*\.\s*row\s*\(/g)) if (name !== "KeyGeneration.swift") found.push(`${rel(f)} ${m[0]}`);
    }
    expect(found).toEqual([]);
  });
});

// ---- the log scan (the scanner of ios-scaffold-b2-m2.test.ts, with the password-v1 names) ----------------

function callArgs(src: string, start: number): { args: string; end: number } | null {
  let depth = 0;
  let inString = false;
  const interp: number[] = [];
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (inString) {
      if (c === "\\" && src[i + 1] === "(") {
        interp.push(depth);
        inString = false;
        depth++;
        i++;
        continue;
      }
      if (c === "\\") {
        i++;
        continue;
      }
      if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      continue;
    }
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (interp.length && interp[interp.length - 1] === depth) {
        interp.pop();
        inString = true;
        continue;
      }
      if (depth === 0) return { args: src.slice(start + 1, i), end: i };
    }
  }
  return null;
}

function codeOnly(args: string): string {
  let out = "";
  let inString = false;
  let depth = 0;
  const interp: number[] = [];
  for (let i = 0; i < args.length; i++) {
    const c = args[i];
    if (inString) {
      if (c === "\\" && args[i + 1] === "(") {
        interp.push(depth);
        inString = false;
        depth++;
        out += " ";
        i++;
        continue;
      }
      if (c === "\\") {
        i++;
        continue;
      }
      if (c === '"') {
        inString = false;
        out += '"';
      }
      continue;
    }
    if (c === '"') {
      inString = true;
      out += '"';
      continue;
    }
    if (c === "(") depth++;
    if (c === ")") {
      depth--;
      if (interp.length && interp[interp.length - 1] === depth) {
        interp.pop();
        inString = true;
        out += " ";
        continue;
      }
    }
    out += c;
  }
  return out;
}

const LOG_CALL = /\b(print|debugPrint|dump|NSLog|os_log|fatalError|preconditionFailure|assertionFailure|precondition|assert)\s*\(|\b\w*(?:[lL]og|logger)\s*\.\s*(trace|debug|info|notice|warning|error|critical|fault|log)\s*\(/g;

/** The password-v1 values that may never reach a log line, a print or a crash message. */
const FORBIDDEN_V1 =
  /\b(password|passwordNorm|passwordBytes|master|authSecret|auth_secret|kek|KEK|kdfSalt|saltPW|emailNorm|pkcs8|privateKey|rawRepresentation|derRepresentation|wrappedPrivateKey|sealed|secret)\b/;

function logViolations(files: string[], base = ROOT): string[] {
  const found: string[] = [];
  for (const file of files) {
    const src = stripComments(readFileSync(file, "utf8"));
    for (const m of src.matchAll(LOG_CALL)) {
      const call = callArgs(src, (m.index ?? 0) + m[0].length - 1);
      if (!call) continue;
      const hit = codeOnly(call.args).match(FORBIDDEN_V1);
      if (hit) found.push(`${path.relative(base, file)}:${src.slice(0, m.index).split("\n").length} ${m[0].replace(/\s+/g, "")}… ${hit[1]} …)`);
    }
  }
  return found;
}

describe("password-v1: nothing secret reaches a log, a print or an error", () => {
  it("no log call, print or crash message in ios/Otodoke names the password, master, the KEK or auth_secret", () => {
    expect(logViolations(swiftFiles())).toEqual([]);
  });

  it("negative control: master, auth_secret and the KEK planted in a Logger call, a print and a fatalError are caught", () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "otodoke-swift-v1-log-scan-"));
    try {
      const root = path.join(tmpDir, "Otodoke");
      mkdirSync(path.join(root, "Crypto"), { recursive: true });
      writeFileSync(path.join(root, "Crypto", "Clean.swift"), 'import os\nlet log = Logger(subsystem: "s", category: "c")\nfunc f(ms: Int) {\n    log.info("master took \\(ms) ms")\n    // print(master)\n}\n');
      expect(logViolations(swiftFiles(root), tmpDir)).toEqual([]);
      writeFileSync(
        path.join(root, "Crypto", "Planted.swift"),
        'import os\nlet pwLog = Logger(subsystem: "s", category: "c")\nfunc g(master: Data, authSecret: String, kek: Data) {\n    pwLog.debug("m \\(master, privacy: .public)")\n    print(authSecret)\n    fatalError("bad \\(kek)")\n}\n',
      );
      expect(logViolations(swiftFiles(root), tmpDir)).toEqual([
        "Otodoke/Crypto/Planted.swift:4 pwLog.debug(… master …)",
        "Otodoke/Crypto/Planted.swift:5 print(… authSecret …)",
        "Otodoke/Crypto/Planted.swift:6 fatalError(… kek …)",
      ]);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("the new parts throw CryptoError only and word no error of their own", () => {
    for (const p of [PASSWORD_V1, KEY_GENERATION]) {
      const src = code(p);
      expect(src.length, p).toBeGreaterThan(0);
      const throwing = [...src.matchAll(/\bthrows\b(\s*\(\s*\w+\s*\))?/g)];
      expect(throwing.length, p).toBeGreaterThan(0);
      for (const t of throwing) expect(t[1]?.replace(/\s+/g, ""), `${p}: ${t[0]}`).toBe("(CryptoError)");
      expect(src, p).not.toMatch(/\bNSError\s*\(|\bLocalizedError\b|\berrorDescription\b|CustomStringConvertible|CustomDebugStringConvertible|\bvar\s+description\b/);
      expect(src, p).not.toMatch(/(?:enum|struct|class)\s+\w+\s*:[^{]*\bError\b/);
    }
  });

  it("CryptoError still carries nothing from its input", () => {
    const block = code("ios/Otodoke/Crypto/CryptoBytes.swift").match(/enum CryptoError[^{]*\{([\s\S]*?)\n\}/)?.[1];
    expect(block, "enum CryptoError").toBeTruthy();
    expect(block).not.toMatch(/case\s+\w+\s*\(/);
    expect(block).toMatch(/case\s+wrongPassword\b/);
  });
});

// ---------------------------------------------------------------------------------------------
// The passphrase route is gone (decided: remove). Red until the test changes listed for approval are made.

describe("password-v1: the passphrase route is gone (needs the approved test changes)", () => {
  it("KeyWrap.swift has no passphrase, no round-count bounds and no KDF of its own", () => {
    const src = code(KEY_WRAP);
    expect(src).not.toMatch(/\bpassphrase\b/i);
    expect(src).not.toMatch(/\bnormalize\s*\(/);
    expect(src).not.toMatch(/\biterationsAllowed\b|\bminIterations\b|\bmaxIterations\b/);
    expect(src).not.toMatch(/typealias\s+KDF\b/);
    expect(src).not.toMatch(/\bCCKeyDerivationPBKDF\b/);
  });

  it("nothing in ios/Otodoke/Crypto uses Foundation's compatibility mapping", () => {
    const found = swiftFiles(CRYPTO).filter((f) => /\bprecomposedStringWithCompatibilityMapping\b/.test(stripComments(readFileSync(f, "utf8"))));
    expect(found.map(rel)).toEqual([]);
  });

  it("no app source calls the passphrase functions", () => {
    const found: string[] = [];
    for (const f of swiftFiles()) {
      const src = stripComments(readFileSync(f, "utf8"));
      for (const m of src.matchAll(/KeyWrap\s*\.\s*(normalize|pbkdf2|iterationsAllowed)\b/g)) found.push(`${rel(f)} KeyWrap.${m[1]}`);
      for (const m of src.matchAll(/KeyWrap\s*\.\s*(openStoredKey|unwrapPrivateKeyBytes)\s*\(([^)]*)\)/g)) if (/\bpassphrase:/.test(m[2])) found.push(`${rel(f)} KeyWrap.${m[1]}(…passphrase:)`);
    }
    expect(found).toEqual([]);
  });

  it("CryptoError has no wrongPassphrase (a refused wrap is wrongPassword)", () => {
    const block = code("ios/Otodoke/Crypto/CryptoBytes.swift").match(/enum CryptoError[^{]*\{([\s\S]*?)\n\}/)?.[1] ?? "";
    expect(block).not.toMatch(/case\s+wrongPassphrase\b/);
  });

  it("the app's key deriver goes through PasswordV1", () => {
    const src = code("ios/Otodoke/Crypto/UnlockModel.swift");
    expect(src).toMatch(/struct\s+LiveKeyDeriver\b/);
    expect(src).toMatch(/\bPasswordV1(?:Deriver)?\b/);
  });
});
