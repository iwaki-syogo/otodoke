import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MailHandling } from "@/app/app/settings/mail-handling";

/**
 * [iOS batch 2, M2] Checks on ios/ that no Swift test can see:
 *  - task 14: no third-party crypto; no app source names the vectors; the Release .app carries no vector
 *    (strings, with the test bundle as the positive control: run with OTODOKE_RELEASE_APP / OTODOKE_TEST_BUNDLE);
 *  - task 15: NSFaceIDUsageDescription in project.yml is FaceIDText.usageDescription word for word; the key
 *    item's attributes are written in KeyVault.swift and nothing weaker; the session is read by its account;
 *  - task 16 / CX2: going to the background reaches the opened key's store;
 *  - task 18: the sealed mail is opened in the app (not the Web), the passphrase field is a SecureField with no
 *    autocorrection, UnlockView adds no words of its own, no HTML is drawn and nothing of a mail is written to
 *    disk; no log call, print or crash message names a passphrase, a key or mail text (negative control);
 *    CryptoError carries nothing from its input;
 *  - task 19: 「あなたのメールの扱い」 gains one item, the same on iOS, on the Web and in the README;
 *  - tasks 21, 22: the delivered and cancelled pages replace the placeholders and are read again in front.
 */

const ROOT = path.resolve(__dirname, "../../..");
const APP = path.join(ROOT, "ios/Otodoke");
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
const read = (p: string) => (existsSync(path.join(ROOT, p)) ? readFileSync(path.join(ROOT, p), "utf8") : "");
const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"])\/\/.*$/gm, "$1");

/** The string literal assigned to `static let <name>` (no escapes in these values). */
function swiftConstant(src: string, name: string): string | null {
  const m = src.match(new RegExp(`^\\s*static let ${name}(?:\\s*:\\s*\\w+)?\\s*=\\s*"([^"\\\\]*)"`, "m"));
  return m ? m[1] : null;
}

// ---- a small Swift call scanner (strings blanked, interpolations kept) --------------------------------

/** The argument text of every call to `name(` at the given positions, with balanced parentheses. */
function callArgs(src: string, start: number): { args: string; end: number } | null {
  let depth = 0;
  let i = start;
  let inString = false;
  const interp: number[] = [];
  for (; i < src.length; i++) {
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

/** The code of call arguments: string contents removed, `\(…)` interpolations kept. */
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

/** Calls that print or log: print/debugPrint/dump/NSLog/os_log, Logger methods, and crash messages. */
const LOG_CALL = /\b(print|debugPrint|dump|NSLog|os_log|fatalError|preconditionFailure|assertionFailure|precondition|assert)\s*\(|\b\w*(?:[lL]og|logger)\s*\.\s*(trace|debug|info|notice|warning|error|critical|fault|log)\s*\(/g;

/** What may never reach a log line, a print or a crash message. */
const FORBIDDEN =
  /\b(passphrase|password|plaintext|privateKey|private_key|secret|kek|pkcs8|recipient|rawRepresentation|subject|fromName|fromAddress|textBody|htmlBody|body|html|text|mail|opened|envelope|envelopeJSON|wrappedPrivateKey)\b/;

function logViolations(files: string[], base = ROOT): string[] {
  const found: string[] = [];
  for (const file of files) {
    const src = stripComments(readFileSync(file, "utf8"));
    for (const m of src.matchAll(LOG_CALL)) {
      const open = (m.index ?? 0) + m[0].length - 1;
      const call = callArgs(src, open);
      if (!call) continue;
      const hit = codeOnly(call.args).match(FORBIDDEN);
      if (hit) {
        const line = src.slice(0, m.index).split("\n").length;
        found.push(`${path.relative(base, file)}:${line} ${m[0].replace(/\s+/g, "")}… ${hit[1]} …)`);
      }
    }
  }
  return found;
}

function logCallCount(files: string[]): number {
  return files.reduce((n, f) => n + [...stripComments(readFileSync(f, "utf8")).matchAll(LOG_CALL)].length, 0);
}

// ---------------------------------------------------------------------------------------------

describe("task 14: the crypto parts", () => {
  it("use CryptoKit, CommonCrypto and the system only (no third-party crypto)", () => {
    const crypto = swiftFiles(path.join(APP, "Crypto"));
    expect(crypto.map((f) => path.basename(f)).sort()).toEqual(expect.arrayContaining(["CryptoBytes.swift", "Envelope.swift", "KeyVault.swift", "KeyWrap.swift", "OpenKeyStore.swift", "UnlockModel.swift"]));
    for (const f of crypto) {
      for (const m of readFileSync(f, "utf8").matchAll(/^\s*import\s+(\w+)/gm)) {
        expect(["CryptoKit", "CommonCrypto", "Foundation", "Security", "LocalAuthentication", "Observation", "SwiftUI"], `${rel(f)} imports ${m[1]}`).toContain(m[1]);
      }
    }
    const yml = read("ios/project.yml");
    const packages = yml.match(/^packages:\n([\s\S]*?)^\S/m)?.[1] ?? "";
    expect([...packages.matchAll(/^ {2}(\w[\w-]*):/gm)].map((m) => m[1])).toEqual(["Supabase"]);
  });

  it("no app source names the vectors or holds their keys", () => {
    const v = JSON.parse(read("fixtures/crypto/envelope-v1.json"));
    for (const f of swiftFiles()) {
      const src = readFileSync(f, "utf8");
      for (const mark of ["envelope-v1", "negative-v1", v.envelope.recipient.key_id, v.envelope.recipient.private_key_d, v.key_wrap.kdf_salt]) {
        expect(src.includes(mark), `${rel(f)} has ${mark.slice(0, 12)}`).toBe(false);
      }
    }
  });

  it("CryptoError carries nothing from its input, and no crypto file words an error itself", () => {
    const bytes = stripComments(read("ios/Otodoke/Crypto/CryptoBytes.swift"));
    const block = bytes.match(/enum CryptoError[^{]*\{([\s\S]*?)\n\}/)?.[1];
    expect(block, "enum CryptoError").toBeTruthy();
    expect(block).not.toMatch(/case\s+\w+\s*\(/);
    for (const f of swiftFiles(path.join(APP, "Crypto"))) {
      const src = stripComments(readFileSync(f, "utf8"));
      expect(src, rel(f)).not.toMatch(/\bLocalizedError\b|\berrorDescription\b|CustomStringConvertible/);
    }
  });
});

describe("task 15: Face ID and the Keychain", () => {
  it("NSFaceIDUsageDescription is in the app's Info.plist properties, as FaceIDText.usageDescription", () => {
    const yml = read("ios/project.yml");
    const app = yml.match(/^ {2}Otodoke:\n([\s\S]*?)^ {2}OtodokeTests:/m)?.[1] ?? "";
    const props = app.match(/^ {6}properties:\n([\s\S]*)$/m)?.[1] ?? "";
    const line = props.match(/^ {8}NSFaceIDUsageDescription:\s*(.+)$/m)?.[1]?.trim();
    expect(line, "NSFaceIDUsageDescription under targets.Otodoke.info.properties").toBeTruthy();
    const value = line!.replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
    const swift = swiftConstant(read("ios/Otodoke/Screens/Shared/FaceIDText.swift"), "usageDescription");
    expect(swift).toBeTruthy();
    expect(value).toBe(swift);
  });

  it("the key item is this device only, behind the current biometry set, never synchronized, and nothing weaker", () => {
    const src = stripComments(read("ios/Otodoke/Crypto/KeyVault.swift"));
    expect(src).toMatch(/kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly/);
    expect(src).toMatch(/\.biometryCurrentSet/);
    expect(src).toMatch(/SecAccessControlCreateWithFlags/);
    expect(src).toMatch(/kSecAttrSynchronizable/);
    expect(src).not.toMatch(/kSecAttrAccessibleAfterFirstUnlock\b|kSecAttrAccessibleAlways|kSecAttrAccessibleWhenUnlocked\b|kSecAttrAccessibleWhenUnlockedThisDeviceOnly|kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly/);
    expect(src).not.toMatch(/\.biometryAny\b|\.userPresence\b|\.devicePasscode\b/);
    expect(src).not.toMatch(/kSecAttrSynchronizable[^\n]*(true|kCFBooleanTrue)/);
    // A new LAContext each time: never one kept on a type.
    expect(src).not.toMatch(/^\s*(static\s+)?(let|var)\s+\w+\s*(:\s*LAContext)?\s*=\s*LAContext\(\)/m);
  });

  it("the session is read by its own account (the key item is never touched by it)", () => {
    const src = stripComments(read("ios/Otodoke/Data/SupabaseProvider.swift"));
    const query = src.match(/private func query\(_ key: String\)[\s\S]*?\n {4}\}/)?.[0] ?? "";
    expect(query).toMatch(/kSecAttrAccount/);
    expect(query).toMatch(/kSecAttrService/);
  });
});

describe("task 16 / CX2: the background reaches the opened key", () => {
  it("MainTabView tells the key store when the app goes to the background", () => {
    const tabs = stripComments(read("ios/Otodoke/Screens/MainTabView.swift"));
    const background = tabs.match(/case \.background:([\s\S]*?)case /)?.[1] ?? "";
    expect(background).toMatch(/wentToBackground\(\)/);
  });
});

describe("task 18: the sealed mail on the detail", () => {
  it("is opened in the app: no 「Web で開く」 for it any more, UnlockView and the scene phase instead", () => {
    const view = stripComments(read("ios/Otodoke/Screens/Detail/ParcelDetailView.swift"));
    expect(view).not.toMatch(/WebLink\.parcel\(id:/);
    expect(view).toMatch(/UnlockView\(/);
    expect(view).toMatch(/scenePhase/);
    expect(view).toMatch(/sceneChanged\(/);
    expect(view).toMatch(/isBodyHidden/);
  });

  it("the passphrase field is a SecureField without autocorrection or capitals, and UnlockView adds no words", () => {
    const src = stripComments(read("ios/Otodoke/Screens/Shared/UnlockView.swift"));
    expect(src).toMatch(/SecureField\(/);
    expect(src).toMatch(/\.autocorrectionDisabled\(/);
    expect(src).toMatch(/\.textInputAutocapitalization\(\.never\)/);
    expect(src).not.toMatch(/\bTextField\(/);
    const literals = [...src.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]);
    expect(literals.filter((s) => /[\u3040-\u30ff\u4e00-\u9fff]/.test(s))).toEqual([]);
    expect(src).toMatch(/FaceIDText\./);
  });

  it("no HTML is drawn and nothing of a mail is written to disk", () => {
    const files = [
      ...swiftFiles(path.join(APP, "Crypto")).filter((f) => path.basename(f) !== "KeyVault.swift"),
      // TrackingLinkView.swift posts a carrier tracking form in a WKWebView (batch 1); it never sees a mail.
      ...swiftFiles(path.join(APP, "Screens/Detail")).filter((f) => path.basename(f) !== "TrackingLinkView.swift"),
      path.join(APP, "Screens/Shared/UnlockView.swift"),
      path.join(APP, "Logic/MailBody.swift"),
      path.join(APP, "Data/MailKeyReader.swift"),
    ];
    for (const f of files) {
      const src = stripComments(readFileSync(f, "utf8"));
      expect(src, rel(f)).not.toMatch(/WKWebView|NSAttributedString\.DocumentType\.html|\.html\s*\]|documentType:\s*\.html|AttributedString\(html/);
      expect(src, rel(f)).not.toMatch(/\.write\(to:|FileManager|UserDefaults|NSCache|URLCache|createFile\(/);
    }
  });

  it("finds the log calls it is about (the scan is not empty)", () => {
    expect(logCallCount(swiftFiles())).toBeGreaterThan(0);
  });

  it("no log call, print or crash message in ios/Otodoke names a passphrase, a key or mail text", () => {
    expect(logViolations(swiftFiles())).toEqual([]);
  });

  it("negative control: a passphrase planted in a Logger call, a print and a fatalError is caught; the clean tree passes", () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "otodoke-swift-log-scan-"));
    try {
      const root = path.join(tmp, "Otodoke");
      mkdirSync(path.join(root, "Crypto"), { recursive: true });
      writeFileSync(
        path.join(root, "Crypto", "Clean.swift"),
        'import os\nlet log = Logger(subsystem: "s", category: "c")\nfunc f(ms: Int, id: String) {\n    log.info("opened in \\(ms) ms for \\(id)")\n    // log.error("\\(passphrase)")\n}\n',
      );
      expect(logViolations(swiftFiles(root), tmp)).toEqual([]);
      expect(logCallCount(swiftFiles(root))).toBe(1);

      writeFileSync(
        path.join(root, "Crypto", "Planted.swift"),
        'import os\nlet unlockLog = Logger(subsystem: "s", category: "c")\nfunc g(passphrase: String, mail: MailPlaintext) {\n    unlockLog.error("failed: \\(passphrase, privacy: .public)")\n    print(mail.subject ?? "")\n    fatalError("bad \\(mail)")\n}\n',
      );
      expect(logViolations(swiftFiles(root), tmp)).toEqual([
        "Otodoke/Crypto/Planted.swift:4 unlockLog.error(… passphrase …)",
        "Otodoke/Crypto/Planted.swift:5 print(… mail …)",
        "Otodoke/Crypto/Planted.swift:6 fatalError(… mail …)",
      ]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
    expect(existsSync(tmp)).toBe(false);
  });

  it("the scanner reads strings as strings and interpolations as code", () => {
    expect(codeOnly('"mail text body", id')).toBe('"", id');
    expect(codeOnly('"a \\(row.subject) b"')).toMatch(/row\.subject/);
    expect(codeOnly('"x \\(f("passphrase")) y"')).not.toMatch(/passphrase/);
    expect(callArgs('print("a (b", c) + d', 5)?.args).toBe('"a (b", c');
  });
});

describe("task 19: 「あなたのメールの扱い」 gains the Keychain item, the same in three places", () => {
  const webItems = () => {
    const html = renderToStaticMarkup(createElement(MailHandling));
    const decode = (s: string) => s.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
    return [...html.matchAll(/<li>([\s\S]*?)<\/li>/g)].map((m) => decode(m[1].replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim());
  };
  const swiftItems = () => {
    const src = stripComments(read("ios/Otodoke/Screens/Settings/MailHandlingView.swift"));
    const block = src.match(/static let items(?:\s*:\s*\[String\])?\s*=\s*\[([\s\S]*?)\n\s*\]/);
    return block ? [...block[1].matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]) : [];
  };

  it("iOS and the Web list the same 14 items, one of them about the Keychain", () => {
    const web = webItems();
    expect(web).toHaveLength(14);
    expect(swiftItems()).toEqual(web);
    const added = web.filter((s) => s.includes("キーチェーン"));
    expect(added).toHaveLength(1);
    for (const fact of ["iOS", "Face ID", "外に出", "同期", "ログアウト"]) expect(added[0], fact).toContain(fact);
  });

  it("the README's section says the same", () => {
    const readme = read("README.md");
    const start = readme.indexOf("\n## あなたのメールの扱い\n");
    const end = readme.indexOf("\n## 技術\n");
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const section = readme.slice(start, end);
    const item = webItems().find((s) => s.includes("キーチェーン")) ?? "";
    expect(item).not.toBe("");
    expect(section).toContain(item.replace(/。$/, ""));
  });
});

describe("tasks 21 and 22: the delivered and cancelled pages are wired", () => {
  it("the list and the calendar open the pages instead of the placeholders", () => {
    const list = stripComments(read("ios/Otodoke/Screens/Parcels/ParcelListView.swift"));
    expect(list).not.toMatch(/PlaceholderScreen\(title:\s*"届いた荷物"\)/);
    expect(list).not.toMatch(/PlaceholderScreen\(title:\s*"キャンセルした荷物"\)/);
    expect(list).toMatch(/DeliveredView\(/);
    expect(list).toMatch(/CancelledView\(/);
    const calendar = stripComments(read("ios/Otodoke/Screens/Calendar/CalendarView.swift"));
    expect(calendar).not.toMatch(/PlaceholderScreen\(title:\s*"届いた荷物"\)/);
    expect(calendar).toMatch(/DeliveredView\(/);
  });

  it("each page is told to the refresher (read again back in front)", () => {
    const others = swiftFiles().filter((f) => path.basename(f) !== "ScreenRefresher.swift").map((f) => stripComments(readFileSync(f, "utf8"))).join("\n");
    expect(others).toMatch(/\.delivered\b[^\n]*refresher|refresher[^\n]*\.delivered\b|shownScreen\(\.delivered/);
    expect(others).toMatch(/\.cancelled\b[^\n]*refresher|refresher[^\n]*\.cancelled\b|shownScreen\(\.cancelled/);
  });
});

// ---- task 14: the Release .app holds no vector ----------------------------------------------------

/** Marks of the password-v1 vectors (long hex), read from the canonical file (never typed here). */
function passwordVectorMarks(): string[] {
  const p = JSON.parse(read("fixtures/crypto/password-v1.json"));
  const first = p.cases[0];
  return [p.private_key.d_hex, first.master_hex, first.auth_secret, first.kek_hex, first.wrap_ciphertext_hex.slice(0, 40)];
}

/** Marks of the vectors, read from the canonical files (never typed here). */
function vectorMarks(): string[] {
  const v = JSON.parse(read("fixtures/crypto/envelope-v1.json"));
  return [v.envelope.recipient.key_id, v.envelope.recipient.private_key_d, v.envelope.envelope.ct.slice(0, 40), v.key_wrap.wrapped_private_key.slice(0, 40), "otodoke envelope v1 / key wrap v1", "negative-v1", ...passwordVectorMarks()];
}

/** Every file under `dir` (an .app or .xctest bundle) through `strings -a`, with the marks found. */
function vectorHits(dir: string): string[] {
  const marks = vectorMarks();
  const hits: string[] = [];
  for (const f of walk(dir)) {
    const out = execFileSync("strings", ["-a", f], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
    for (const mark of marks) if (out.includes(mark)) hits.push(`${path.relative(dir, f)}: ${mark.slice(0, 16)}`);
  }
  return hits;
}

describe("task 14: the Release .app carries no vector (strings)", () => {
  it("the check finds a planted vector and passes a clean bundle (negative and positive control)", () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "otodoke-strings-"));
    try {
      const app = path.join(tmp, "Clean.app");
      mkdirSync(app, { recursive: true });
      writeFileSync(path.join(app, "Clean"), Buffer.from("\u0000\u0001just code and words\u0000"));
      expect(vectorHits(app)).toEqual([]);
      const planted = path.join(tmp, "Planted.xctest", "Fixtures", "crypto");
      mkdirSync(planted, { recursive: true });
      writeFileSync(path.join(planted, "envelope-v1.json"), readFileSync(path.join(ROOT, "fixtures/crypto/envelope-v1.json")));
      expect(vectorHits(path.join(tmp, "Planted.xctest")).length).toBeGreaterThan(0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("the password-v1 vectors are marks too: a bundle with only password-v1.json is found, a look-alike is not", () => {
    const pw = readFileSync(path.join(ROOT, "fixtures/crypto/password-v1.json"), "utf8");
    const tmp = mkdtempSync(path.join(os.tmpdir(), "otodoke-strings-pw-"));
    try {
      const planted = path.join(tmp, "Planted.xctest", "Fixtures", "crypto");
      mkdirSync(planted, { recursive: true });
      writeFileSync(path.join(planted, "password-v1.json"), pw);
      // The marks are real values of the file: long lowercase hex, each in password-v1.json, none in the
      // envelope vector (so the envelope's marks cannot stand in for them).
      const marks = passwordVectorMarks();
      const envelope = readFileSync(path.join(ROOT, "fixtures/crypto/envelope-v1.json"), "utf8");
      expect(marks).toHaveLength(5);
      for (const mark of marks) {
        expect(mark).toMatch(/^[0-9a-f]{32,}$/);
        expect(pw.includes(mark), mark.slice(0, 16)).toBe(true);
        expect(envelope.includes(mark), mark.slice(0, 16)).toBe(false);
        expect(vectorMarks()).toContain(mark);
      }
      // Each password-v1 mark is found on its own.
      const hits = vectorHits(path.join(tmp, "Planted.xctest"));
      for (const mark of marks) expect(hits, mark.slice(0, 16)).toContain(`${path.join("Fixtures", "crypto", "password-v1.json")}: ${mark.slice(0, 16)}`);
      // A clean bundle holding hex of the same shape (64 lowercase hex, not a vector) is not found.
      const lookAlike = path.join(tmp, "LookAlike.app");
      mkdirSync(lookAlike, { recursive: true });
      writeFileSync(path.join(lookAlike, "LookAlike"), Buffer.from(`\u0000${"0123456789abcdef".repeat(4)}\u0000${"f".repeat(64)}\u0000`));
      expect(vectorHits(lookAlike)).toEqual([]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  const release = process.env.OTODOKE_RELEASE_APP;
  const testBundle = process.env.OTODOKE_TEST_BUNDLE;

  it.runIf(Boolean(release))("the built Release Otodoke.app holds none of the vectors (OTODOKE_RELEASE_APP)", () => {
    expect(existsSync(release!)).toBe(true);
    expect(vectorHits(release!)).toEqual([]);
  });

  it.runIf(Boolean(testBundle))("the built test bundle holds them (OTODOKE_TEST_BUNDLE, the positive control)", () => {
    expect(existsSync(testBundle!)).toBe(true);
    expect(vectorHits(testBundle!).length).toBeGreaterThan(0);
  });
});
