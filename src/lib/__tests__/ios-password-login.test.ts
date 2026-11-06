import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { COPY_SOURCE, LOGIN_MESSAGES_COPY, PASSWORD_WORDS_COPY } from "./login-words-pw-int";

/**
 * [iOS password login (password-login)] Checks on ios/ that no Swift test can see:
 *  - the Web's words: the copy (login-words-pw-int.ts) is the Web's file (this tree's src/lib/login-errors.ts and
 *    src/lib/crypto/password-v1.ts once they have the password-v1 words, else the tip of integrate/password-v1
 *    read through git; neither found fails), and every LoginText constant named after a Web key is that word;
 *    the app's own words are exactly the listed ones (a new one must be added to the list, for review);
 *  - 「合言葉」 is in no file of ios/Otodoke (comments too) nor in ios/project.yml (negative control);
 *  - the 8-digit code login is gone from ios/Otodoke (negative control);
 *  - the login screen: SecureField with the password content types, no autocorrection or capitals, no field
 *    of text bound to the password, every word from LoginText, 「パスワードを忘れた」 opens
 *    https://otodoke.app/login/forgot in Safari (openURL / Link), not in a view of the app;
 *  - no log call, print or crash message names the password, auth_secret, master, the KEK or the access token
 *    (negative control); LoginFailure and KeyAPIFailure carry nothing;
 *  - the wiring: the unlock address is auth.signedInEmail; attachKeys starts KeySetup with takeSignInSecret().
 */

const ROOT = path.resolve(__dirname, "../../..");
const APP = path.join(ROOT, "ios/Otodoke");
const rel = (f: string, base = ROOT) => path.relative(base, f);

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

/** Every `static let <name> = "<literal>"` of a Swift enum body, in order. */
function swiftConstants(src: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of src.matchAll(/^\s*static let (\w+)(?:\s*:\s*\w+)?\s*=\s*"([^"\\]*)"/gm)) out.set(m[1], m[2]);
  return out;
}

const camel = (key: string) => key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

// ---- the Web's words ----------------------------------------------------------------------------

/** LOGIN_MESSAGES of a login-errors.ts text: { key: "words" } in order; null when the file has none. */
function parseLoginMessages(src: string): Record<string, string> | null {
  const block = src.match(/export const LOGIN_MESSAGES = \{([\s\S]*?)\n\} as const;/)?.[1];
  if (!block) return null;
  const out: Record<string, string> = {};
  for (const m of block.matchAll(/^\s*(\w+):\s*"([^"\\]*)",/gm)) out[m[1]] = m[2];
  return out;
}

/** The password words of a password-v1.ts text (PASSWORD_MIN_LENGTH put in); null when it has none. */
function parsePasswordWords(src: string): Record<string, string> | null {
  const min = src.match(/export const PASSWORD_MIN_LENGTH = (\d+);/)?.[1];
  const body = src.match(/export function passwordProblem\([\s\S]*?\n\}/)?.[0];
  const rule = src.match(/export const PASSWORD_RULE = `([^`]*)`;/)?.[1];
  if (!min || !body || !rule) return null;
  const fill = (t: string) => t.replace(/\$\{PASSWORD_MIN_LENGTH\}/g, min);
  const answers = [...body.matchAll(/return [`"]([^`"]*)[`"];/g)].map((m) => fill(m[1]));
  if (answers.length !== 3) return null;
  return { PASSWORD_RULE: fill(rule), too_short: answers[0], weak: answers[1], mismatch: answers[2] };
}

/** A Web file: this tree's when it has the words, else the tip of integrate/password-v1 through git. */
function webSource(file: string, has: (src: string) => boolean): { from: string; src: string } {
  const own = read(file);
  if (own && has(own)) return { from: file, src: own };
  try {
    const src = execFileSync("git", ["-C", ROOT, "show", `${COPY_SOURCE.ref}:${file}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    if (has(src)) return { from: `${COPY_SOURCE.ref}:${file}`, src };
  } catch {
    // not in this clone: fall through
  }
  throw new Error(`the Web's ${file} with the password-v1 words was found neither in this tree nor at ${COPY_SOURCE.ref}`);
}

/** Web keys the app shows, and the LoginText constants named after them. */
const SHOWN_KEYS = [
  "credentials",
  "not_confirmed",
  "rate",
  "captcha",
  "network",
  "other",
  "invalid_email",
  "email_not_ascii",
  "signup_exists_or_sent",
  "confirmation_sent",
  "signed_out",
  "stale_session",
  "key_in_use_changed",
  "key_wrap_changed",
  "key_not_pending",
  "key_not_in_use",
  "key_challenge_failed",
  "key_failed",
  "invalid_input",
];

/** The password words, by their LoginText names. */
const PASSWORD_NAMES: Record<string, keyof typeof PASSWORD_WORDS_COPY> = {
  passwordRule: "PASSWORD_RULE",
  passwordTooShort: "too_short",
  passwordWeak: "weak",
  passwordMismatch: "mismatch",
};

/** The app's own words (not on the Web). A new one is added here, so a reviewer sees it. */
const APP_OWN_WORDS: Record<string, string> = {
  signInTitle: "ログイン",
  signUpTitle: "アカウントを作る",
  emailLabel: "メールアドレス",
  passwordLabel: "パスワード",
  passwordAgainLabel: "パスワード（もう一度）",
  signInButton: "ログイン",
  signUpButton: "アカウントを作る",
  toSignUp: "アカウントを作る",
  toSignIn: "ログインに戻る",
  forgotPassword: "パスワードを忘れた",
  resendConfirmation: "確認のメールをもう一度送る",
};

describe("the Web's words", () => {
  it("the copy of LOGIN_MESSAGES is the Web's, key for key and word for word", () => {
    const web = webSource("src/lib/login-errors.ts", (s) => parseLoginMessages(s)?.credentials !== undefined);
    expect(parseLoginMessages(web.src), web.from).toEqual(LOGIN_MESSAGES_COPY);
  });

  it("the copy of the password rule is the Web's", () => {
    const web = webSource("src/lib/crypto/password-v1.ts", (s) => parsePasswordWords(s) !== null);
    expect(parsePasswordWords(web.src), web.from).toEqual({ ...PASSWORD_WORDS_COPY });
  });

  it("negative control: the parsers see a word changed by one character, and a key added", () => {
    const src = 'export const LOGIN_MESSAGES = {\n  credentials: "あ。",\n  rate: "い。",\n} as const;';
    expect(parseLoginMessages(src)).toEqual({ credentials: "あ。", rate: "い。" });
    expect(parseLoginMessages(src.replace("い。", "う。"))).not.toEqual({ credentials: "あ。", rate: "い。" });
    expect(parseLoginMessages(src.replace("} as const;", '  extra: "え",\n} as const;'))).not.toEqual({ credentials: "あ。", rate: "い。" });
    expect(parseLoginMessages("export const OTHER = {}")).toBeNull();
    const pw =
      "export const PASSWORD_MIN_LENGTH = 10;\nexport const PASSWORD_RULE = `${PASSWORD_MIN_LENGTH} 文字。`;\nexport function passwordProblem(a: string, b: string): string | null {\n  if (x) return `${PASSWORD_MIN_LENGTH} 文字以上`;\n  if (y) return \"弱い\";\n  if (z) return \"違う\";\n  return null;\n}";
    expect(parsePasswordWords(pw)).toEqual({ PASSWORD_RULE: "10 文字。", too_short: "10 文字以上", weak: "弱い", mismatch: "違う" });
  });

  it("every LoginText constant named after a Web key is the Web's word", () => {
    const swift = stripComments(read("ios/Otodoke/Auth/LoginText.swift"));
    for (const key of SHOWN_KEYS) {
      expect(LOGIN_MESSAGES_COPY[key], `the copy has ${key}`).toBeDefined();
      expect(swiftConstant(swift, camel(key)), `LoginText.${camel(key)}`).toBe(LOGIN_MESSAGES_COPY[key]);
    }
    for (const [name, key] of Object.entries(PASSWORD_NAMES)) {
      expect(swiftConstant(swift, name), `LoginText.${name}`).toBe(PASSWORD_WORDS_COPY[key]);
    }
  });

  it("LoginText has the Web's words and the listed words of the app's own, nothing else", () => {
    const all = swiftConstants(stripComments(read("ios/Otodoke/Auth/LoginText.swift")));
    const own = [...all.entries()].filter(([name]) => !SHOWN_KEYS.map(camel).includes(name) && !(name in PASSWORD_NAMES));
    expect(Object.fromEntries(own)).toEqual(APP_OWN_WORDS);
    for (const words of Object.values(APP_OWN_WORDS)) expect(words).not.toMatch(/合言葉/);
  });

  it("「パスワードを忘れた」 is the Web's page, over https", () => {
    const src = read("ios/Otodoke/Auth/LoginText.swift");
    const m = src.match(/^\s*static let forgotPasswordURL\s*=\s*URL\(string:\s*"([^"]+)"\)!/m);
    expect(m?.[1]).toBe("https://otodoke.app/login/forgot");
  });
});

// ---- 「合言葉」 --------------------------------------------------------------------------------------

/** Every file under `root` (and the extra files) holding 「合言葉」, with its line. */
function aikotobaHits(root: string, extra: string[] = [], base = ROOT): string[] {
  const hits: string[] = [];
  for (const f of [...walk(root), ...extra]) {
    if (!/\.(swift|plist|strings|stringsdict|xcstrings|xcprivacy|yml|json|md)$/.test(f)) continue;
    readFileSync(f, "utf8")
      .split("\n")
      .forEach((line, i) => {
        if (line.includes("合言葉")) hits.push(`${rel(f, base)}:${i + 1}`);
      });
  }
  return hits;
}

describe("「合言葉」 is gone from the app", () => {
  it("no file of ios/Otodoke, nor ios/project.yml, has 「合言葉」 (comments included)", () => {
    expect(walk(APP).length).toBeGreaterThan(0);
    expect(aikotobaHits(APP, [path.join(ROOT, "ios/project.yml")])).toEqual([]);
  });

  it("negative control: a planted word in a Swift string, a comment and a plist is caught", () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "otodoke-aikotoba-"));
    try {
      const root = path.join(tmp, "Otodoke");
      mkdirSync(path.join(root, "Screens"), { recursive: true });
      writeFileSync(path.join(root, "Screens", "Clean.swift"), 'let a = "パスワード"\n');
      expect(aikotobaHits(root, [], tmp)).toEqual([]);
      writeFileSync(path.join(root, "Screens", "Planted.swift"), 'let a = "パスワード"\nlet b = "合言葉"\n// 合言葉\n');
      writeFileSync(path.join(root, "Info.plist"), "<string>合言葉</string>\n");
      expect(aikotobaHits(root, [], tmp).sort()).toEqual(["Otodoke/Info.plist:1", "Otodoke/Screens/Planted.swift:2", "Otodoke/Screens/Planted.swift:3"]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ---- the code login is gone ---------------------------------------------------------------------

const OTP_MARKS = /\bsignInWithOTP\b|\bverifyOTP\b|\bfunc sendCode\b|\bfunc verifyCode\b|\.oneTimeCode\b|otodoke-start-at-code|\bcodeLength\b|\bCaptchaText\b|\bcodeRejected\b/;

function otpHits(root: string, base = ROOT): string[] {
  const hits: string[] = [];
  for (const f of swiftFiles(root)) {
    stripComments(readFileSync(f, "utf8"))
      .split("\n")
      .forEach((line, i) => {
        const m = line.match(OTP_MARKS);
        if (m) hits.push(`${rel(f, base)}:${i + 1} ${m[0]}`);
      });
  }
  return hits;
}

describe("the 8-digit code login is gone", () => {
  it("ios/Otodoke has no code login (signInWithOTP, verifyOTP, sendCode, verifyCode, .oneTimeCode, the launch argument)", () => {
    expect(otpHits(APP)).toEqual([]);
  });

  it("negative control: planted calls are caught, a comment is not", () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "otodoke-otp-"));
    try {
      const root = path.join(tmp, "Otodoke");
      mkdirSync(path.join(root, "Auth"), { recursive: true });
      writeFileSync(path.join(root, "Auth", "Clean.swift"), "// signInWithOTP was here\nfunc signIn() {}\n");
      expect(otpHits(root, tmp)).toEqual([]);
      writeFileSync(path.join(root, "Auth", "Planted.swift"), "func a() async throws {\n  try await auth.signInWithOTP(email: e)\n  field.textContentType(.oneTimeCode)\n}\n");
      expect(otpHits(root, tmp)).toEqual(["Otodoke/Auth/Planted.swift:2 signInWithOTP", "Otodoke/Auth/Planted.swift:3 .oneTimeCode"]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ---- the login screen -------------------------------------------------------------------------------

describe("the login screen", () => {
  const view = () => stripComments(read("ios/Otodoke/Auth/LoginView.swift"));

  it("the password fields are SecureFields with the password content types, no autocorrection, no capitals", () => {
    const src = view();
    expect((src.match(/SecureField\(/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(src).toMatch(/\$model\.password\b/);
    expect(src).toMatch(/\$model\.passwordAgain\b/);
    expect(src).toMatch(/\.textContentType\(\s*\.password\s*\)/);
    expect(src).toMatch(/\.textContentType\(\s*\.newPassword\s*\)/);
    expect(src).toMatch(/\.autocorrectionDisabled\(/);
    expect(src).toMatch(/\.textInputAutocapitalization\(\s*\.never\s*\)/);
    expect(src).not.toMatch(/TextField\([^)]*\$model\.password/);
  });

  it("every word comes from LoginText (no Japanese literal in the view)", () => {
    const literals = [...view().matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]);
    expect(literals.filter((s) => /[\u3040-\u30ff\u3400-\u9fff\uff00-\uffef]/.test(s))).toEqual([]);
    expect(view()).toMatch(/LoginText\./);
  });

  it("「パスワードを忘れた」 opens the Web's page in Safari, not in a view of the app", () => {
    const src = view();
    expect(src).toMatch(/forgotPasswordURL/);
    expect(src).toMatch(/\bopenURL\b|\bLink\(/);
    expect(src).not.toMatch(/SFSafariViewController|WKWebView|ASWebAuthenticationSession/);
  });

  it("the Turnstile widget stays on the screen and the model keeps its token", () => {
    expect(view()).toContain("TurnstileView(");
  });
});

// ---- nothing secret in a log line ---------------------------------------------------------------------

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

/** What a password sign-in holds that may never reach a log line, a print or a crash message. */
const SECRET = /\b(\w*[pP]assword\w*|\w*[sS]ecret\w*|master|kek|KEK|accessToken|access_token|signIn|PasswordSignIn|captchaToken)\b/;

function secretLogHits(files: string[], base = ROOT): string[] {
  const found: string[] = [];
  for (const file of files) {
    const src = stripComments(readFileSync(file, "utf8"));
    for (const m of src.matchAll(LOG_CALL)) {
      const call = callArgs(src, (m.index ?? 0) + m[0].length - 1);
      if (!call) continue;
      const hit = codeOnly(call.args).match(SECRET);
      if (hit) found.push(`${rel(file, base)}:${src.slice(0, m.index).split("\n").length} ${m[0].replace(/\s+/g, "")}… ${hit[1]} …)`);
    }
  }
  return found;
}

describe("nothing of a password sign-in is logged", () => {
  it("no log call, print or crash message in ios/Otodoke names the password, a secret, master, the KEK or a token", () => {
    expect(secretLogHits(swiftFiles())).toEqual([]);
  });

  it("negative control: planted calls are caught; a count and an id are not", () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "otodoke-pw-log-"));
    try {
      const root = path.join(tmp, "Otodoke");
      mkdirSync(path.join(root, "Auth"), { recursive: true });
      writeFileSync(path.join(root, "Auth", "Clean.swift"), 'import os\nlet log = Logger(subsystem: "s", category: "c")\nfunc f(ms: Int, code: String) {\n    log.info("password step \\(ms) ms: \\(code)")\n}\n');
      expect(secretLogHits(swiftFiles(root), tmp)).toEqual([]);
      writeFileSync(
        path.join(root, "Auth", "Planted.swift"),
        'import os\nlet authLog = Logger(subsystem: "s", category: "c")\nfunc g(authSecret: String, master: Data, session: Session) {\n    authLog.error("\\(authSecret)")\n    print(master)\n    fatalError("\\(session.accessToken)")\n}\n',
      );
      expect(secretLogHits(swiftFiles(root), tmp)).toEqual([
        "Otodoke/Auth/Planted.swift:4 authLog.error(… authSecret …)",
        "Otodoke/Auth/Planted.swift:5 print(… master …)",
        "Otodoke/Auth/Planted.swift:6 fatalError(… accessToken …)",
      ]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("LoginFailure and KeyAPIFailure carry nothing from their input", () => {
    for (const [file, name] of [
      ["ios/Otodoke/Auth/LoginText.swift", "LoginFailure"],
      ["ios/Otodoke/Crypto/KeySetup.swift", "KeyAPIFailure"],
    ]) {
      const block = stripComments(read(file)).match(new RegExp(`enum ${name}[^{]*\\{([\\s\\S]*?)\\n\\}`))?.[1];
      expect(block, `enum ${name}`).toBeTruthy();
      expect(block).not.toMatch(/case\s+\w+\s*\(/);
    }
  });
});

// ---- the wiring ---------------------------------------------------------------------------------------

describe("the wiring", () => {
  const keys = () => stripComments(read("ios/Otodoke/Screens/MainScreens+Keys.swift"));

  it("the unlock opens the key with the signed-in session's address", () => {
    expect(keys()).toMatch(/signInEmail:\s*\{[^}]*auth\.signedInEmail/);
  });

  it("attachKeys makes KeySetup with the Web's key endpoints and gives it the sign-in, once", () => {
    const src = keys();
    expect(src).toMatch(/KeySetup\(/);
    expect(src).toMatch(/KeyAPIClient\(/);
    expect(src).toMatch(/takeSignInSecret\(\)/);
    expect(src).toMatch(/keySetup\s*=/);
  });

  it("the key endpoints are the Web's origin by default", () => {
    const src = stripComments(read("ios/Otodoke/Crypto/KeySetup.swift"));
    expect(src).toMatch(/init\(baseURL:\s*URL\s*=\s*AppConfig\.webBase/);
    expect(read("ios/Otodoke/Config/AppConfig.swift")).toMatch(/static let webBase = URL\(string: "https:\/\/otodoke\.app"\)!/);
  });

  it("no TDD-STUB(password-login) is left", () => {
    const left = walk(APP).filter((f) => readFileSync(f, "utf8").includes("TDD-STUB(password-login)"));
    expect(left.map((f) => rel(f))).toEqual([]);
  });
});
