import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { SHARED_MAIL_DOMAINS, SHARED_MAIL_DOMAIN_SUFFIXES } from "@/lib/screen-senders";

const root = path.resolve(__dirname, "../../..");
const webRoot = process.env.OTODOKE_SETTINGS_WEB_ROOT ?? root;
const native = (file: string) => {
  const target = path.join(root, "ios/Otodoke", file);
  return existsSync(target) ? readFileSync(target, "utf8") : "";
};

/** Comments cannot supply a missing production read, button or request. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

function block(source: string, marker: string): string {
  const start = source.indexOf(marker);
  if (start < 0) return "";
  const first = source.indexOf("{", start);
  if (first < 0) return "";
  let depth = 0;
  for (let i = first; i < source.length; i++) {
    if (source[i] === "{") depth++;
    if (source[i] === "}" && --depth === 0) return source.slice(first + 1, i);
  }
  return "";
}

function noticeReadProblems(source: string): string[] {
  const body = block(code(source), "func intakeNotice(");
  const requirements = [
    '.from("mail_intake_notices")',
    '.select("limited_at")',
    '.eq("user_id", value: me)',
    '.limit(2)',
    ".failed",
    ".loaded(",
  ];
  return requirements.filter((value) => !body.includes(value));
}

function publicationProblems(source: string): string[] {
  const load = block(code(source), "private func loadSettings(");
  const ticket = load.indexOf("let ticket = fence.beginRead()");
  const reads = load.indexOf("await withTaskCancellationHandler");
  const verdict = load.indexOf("fence.verdict(ticket) == .current");
  if (ticket < 0 || reads < ticket || verdict < reads) return ["missing fenced settings publication"];
  const problems: string[] = [];
  if (/\bawait\b/.test(load.slice(ticket, reads))) problems.push("suspension before loading-state initialization");
  if (/\bawait\b/.test(load.slice(verdict))) problems.push("suspension after final fence verdict");
  return problems;
}

function rememberedEntryProblems(source: string): string[] {
  const dropped = block(code(source), "struct SettingsDroppedPage");
  const body = block(dropped, "var body: some View");
  const remembered = block(dropped, "var rememberedSection: some View");
  const button = block(remembered, "Button {");
  const problems: string[] = [];
  if (!body.includes("rememberedSection")) problems.push("remembered section is not rendered by its page");
  if (!button.includes("model.mailRecovery.forgetSender(domain: domain)")) problems.push("native remove button is disconnected");
  return problems;
}

function literal(expression: ts.Expression): string | Record<string, string> {
  while (ts.isAsExpression(expression) || ts.isSatisfiesExpression(expression) || ts.isParenthesizedExpression(expression)) expression = expression.expression;
  if (ts.isStringLiteral(expression)) return expression.text;
  if (ts.isObjectLiteralExpression(expression)) {
    return Object.fromEntries(expression.properties.map((entry) => {
      if (!ts.isPropertyAssignment(entry)) throw new Error("copy must expose actual literal values");
      const value = literal(entry.initializer);
      if (typeof value !== "string") throw new Error("copy property must be a string");
      return [entry.name.getText().replace(/^['"]|['"]$/g, ""), value];
    }));
  }
  throw new Error("copy must expose actual literal values");
}

function exportedCopy(fileName: string): Record<string, string | Record<string, string>> {
  const file = ts.createSourceFile(fileName, readFileSync(path.join(webRoot, fileName), "utf8"), ts.ScriptTarget.Latest, true);
  const values: Record<string, string | Record<string, string>> = {};
  for (const statement of file.statements) {
    if (!ts.isVariableStatement(statement) || !statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) continue;
    for (const entry of statement.declarationList.declarations) {
      if (ts.isIdentifier(entry.name) && entry.initializer) values[entry.name.text] = literal(entry.initializer);
    }
  }
  return values;
}

function swiftStrings(source: string, enumName: string): Record<string, string> {
  const body = block(code(source), `enum ${enumName}`);
  return Object.fromEntries([...body.matchAll(/static let (\w+)\s*=\s*("(?:[^"\\]|\\.)*")/g)].map((match) => [match[1], JSON.parse(match[2]) as string]));
}

function swiftArray(source: string, name: string): string[] {
  const array = code(source).match(new RegExp(`static let ${name}\\s*=\\s*\\[([\\s\\S]*?)\\]`))?.[1] ?? "";
  return [...array.matchAll(/"(?:[^"\\]|\\.)*"/g)].map((match) => JSON.parse(match[0]) as string);
}

describe("native settings mail recovery (N3/N5)", () => {
  it("N3 reads the person's intake notice independently of unread counts", () => {
    expect(noticeReadProblems(native("Data/SettingsReader.swift"))).toEqual([]);
    const model = code(native("Screens/Settings/SettingsModel.swift"));
    expect(model).toMatch(/intakeNotice:\s*LoadResult<String\?>\?/);
    const reads = block(model, "private func readAll(");
    expect(reads).toMatch(/async let \w+ = reader\.intakeNotice\(\)/);
    expect(reads.indexOf("reader.intakeNotice()")).toBeLessThan(reads.indexOf("if case let .loaded(n) = waitingResult"));
  });

  it("N3 displays the independent notice even when the unread count is zero", () => {
    const rows = code(native("Screens/Settings/SettingsStatusRows.swift"));
    const body = block(rows, "var body: some View");
    expect(body).toContain("intakeSection");
    const intake = block(rows, "var intakeSection: some View");
    expect(intake).toContain("model.intakeNotice");
    expect(intake).toContain("StorageIntakeText.body");
    expect(intake).toContain("StorageIntakeText.reason");
    expect(intake).toContain("dismissIntake");
    expect(intake).not.toContain("model.unread");
  });

  it("N5 exposes a native remembered-sender list and removal, with a failed-read state", () => {
    const pages = code(native("Screens/Settings/SettingsPages.swift"));
    const dropped = block(pages, "struct SettingsDroppedPage");
    expect(rememberedEntryProblems(pages)).toEqual([]);
    const remembered = block(dropped, "var rememberedSection: some View");
    expect(remembered).toContain("model.rememberedSenders");
    expect(remembered).toContain("RememberedSenderText.title");
    expect(remembered).toContain("forgetSender");
    expect(remembered).toContain(".failed");
    expect(remembered).not.toMatch(/openURL|WebLink|SettingsWeb/);
  });

  it("settings publication has no suspension between its fence and UI-state changes", () => {
    expect(publicationProblems(native("Screens/Settings/SettingsModel.swift"))).toEqual([]);
  });

  it("N5 raw sender rows do not use normalized Swift String equality as view IDs", () => {
    const pages = code(native("Screens/Settings/SettingsPages.swift"));
    const remembered = block(block(pages, "struct SettingsDroppedPage"), "var rememberedSection: some View");
    expect(remembered).not.toMatch(/ForEach\(domains,\s*id:\s*\\\.self\)/);
    expect(code(native("Data/RememberedSenderRule.swift"))).toMatch(/var id:\s*\[UInt16\]/);
  });

  it("N3/N5 use the actual centralized Web values for every new native sentence", () => {
    const source = native("Screens/Settings/SettingsMailRecoveryText.swift");
    const storage = swiftStrings(source, "StorageIntakeText");
    const read = exportedCopy("src/lib/read-notices.ts");
    for (const [key, canonical] of Object.entries({ notice: "READ_STORAGE_LIMIT_NOTICE", body: "READ_STORAGE_LIMIT_BODY", reason: "READ_STORAGE_LIMIT_REASON", failed: "READ_STORAGE_NOTICE_FAILED", confirm: "READ_STORAGE_CONFIRM", confirming: "READ_STORAGE_CONFIRMING" })) {
      expect(typeof read[canonical], canonical).toBe("string");
      expect(storage[key], key).toBe(read[canonical]);
    }
    const sender = exportedCopy("src/lib/settings-mail-text.ts").REMEMBERED_SENDER_TEXT;
    expect(sender).toBeDefined();
    expect(swiftStrings(source, "RememberedSenderText")).toEqual(sender);
  });

  it("N5 excludes exactly the Web shared domains and suffixes from remembered senders", () => {
    const source = native("Data/RememberedSenderRule.swift");
    expect(swiftArray(source, "sharedMailDomains").sort()).toEqual([...SHARED_MAIL_DOMAINS].sort());
    expect(swiftArray(source, "sharedMailDomainSuffixes").sort()).toEqual([...SHARED_MAIL_DOMAIN_SUFFIXES].sort());
  });

  it("negative control: removing owner scope cannot satisfy the notice-read guard", () => {
    const complete = 'func intakeNotice() { database.from("mail_intake_notices").select("limited_at").eq("user_id", value: me).limit(2); return error ? .failed : .loaded(nil) }';
    expect(noticeReadProblems(complete)).toEqual([]);
    expect(noticeReadProblems(complete.replace('.eq("user_id", value: me)', ""))).toEqual(['.eq("user_id", value: me)']);
    expect(noticeReadProblems(`// ${complete}`)).not.toEqual([]);
  });

  it("negative control: retaining the section declaration cannot hide a disconnected page or button", () => {
    const pages = native("Screens/Settings/SettingsPages.swift");
    expect(rememberedEntryProblems(pages)).toEqual([]);
    expect(rememberedEntryProblems(pages.replace("\n            rememberedSection\n", "\n"))).toEqual(["remembered section is not rendered by its page"]);
    expect(rememberedEntryProblems(pages.replace("await model.mailRecovery.forgetSender(domain: domain)", ""))).toEqual(["native remove button is disconnected"]);
  });

  it("negative control: either post-ticket suspension invalidates publication safety", () => {
    const complete = "private func loadSettings() { let ticket = fence.beginRead(); readIntakeNotice = nil; let values = await withTaskCancellationHandler { readAll() }; guard fence.verdict(ticket) == .current else { return }; readIntakeNotice = values }";
    expect(publicationProblems(complete)).toEqual([]);
    expect(publicationProblems(complete.replace("readIntakeNotice = nil", "let owner = await provider.currentUserID(); readIntakeNotice = nil"))).toEqual(["suspension before loading-state initialization"]);
    expect(publicationProblems(complete.replace("readIntakeNotice = values", "let owner = await provider.currentUserID(); readIntakeNotice = values"))).toEqual(["suspension after final fence verdict"]);
  });
});
