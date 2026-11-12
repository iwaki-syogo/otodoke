import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "../../..");
// A cross-branch check may supply an exact export of the Web commit outside this worktree.
const WEB_ROOT = process.env.OTODOKE_CONSENT_WEB_ROOT ?? ROOT;
// The Web owns this file. A missing file is a failed integration, never a skipped comparison.
const WEB_TEXT_PATH = path.join(WEB_ROOT, "src/lib/ai-consent-text.ts");
const WEB_CONSENT_VIEW_PATH = path.join(WEB_ROOT, "src/app/app/reading/reading-consent.tsx");
const WEB_HANDLING_VIEW_PATH = path.join(WEB_ROOT, "src/app/app/settings/mail-handling.tsx");
const WEB_MAIL_HANDLER_PATH = path.join(WEB_ROOT, "src/app/api/mail/handler.ts");
const SWIFT_ROOT = path.join(ROOT, "ios/Otodoke");
const APPROVED_COPY = [
  "メールの読み取り",
  "届いたメールは、Anthropic の Claude で読み取ります。",
  "メールの件名・差出人・本文を送り、荷物の情報を取り出します。",
  "プライバシーポリシー",
  "許可する",
  "許可しない",
  "読み取りをやめる",
  "読み取りを許可する",
  "もう一度読み込む",
  "読み取りの許可を確認できませんでした。もう一度読み込んでください。",
  "読み取りの許可を保存できませんでした。もう一度お試しください。",
  "サンプルで試す",
  "手で登録する",
  "すでに読み取った荷物と結果は残ります。設定の「サンプルで試す」にある「すべての荷物を消す」で消せます。",
  "許可を待つメールは、届いてから 14 日で消えます。",
] as const;

function readRequired(file: string): string {
  if (!existsSync(file)) throw new Error(`the Web-owned comparison input is missing: ${file}`);
  return readFileSync(file, "utf8");
}

/** Read values from exported literal data, following aliases without depending on declaration names. */
function exportedStrings(source: string): string[] {
  const file = ts.createSourceFile("consent-text.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const bindings = new Map<string, ts.Expression>();
  const exported: ts.Expression[] = [];
  for (const statement of file.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    const isExported = statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
      bindings.set(declaration.name.text, declaration.initializer);
      if (isExported) exported.push(declaration.initializer);
    }
  }
  const read = (expression: ts.Expression, visiting = new Set<string>()): string[] => {
    if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) return [expression.text];
    if (ts.isAsExpression(expression) || ts.isSatisfiesExpression(expression) || ts.isParenthesizedExpression(expression)) {
      return read(expression.expression, visiting);
    }
    if (ts.isIdentifier(expression)) {
      const value = bindings.get(expression.text);
      if (!value || visiting.has(expression.text)) throw new Error(`cannot resolve exported text: ${expression.text}`);
      return read(value, new Set([...visiting, expression.text]));
    }
    if (ts.isArrayLiteralExpression(expression)) return expression.elements.flatMap((element) => read(element, visiting));
    if (ts.isObjectLiteralExpression(expression)) {
      return expression.properties.flatMap((property) => {
        if (ts.isPropertyAssignment(property)) return read(property.initializer, visiting);
        if (ts.isShorthandPropertyAssignment(property)) return read(property.name, visiting);
        if (ts.isSpreadAssignment(property)) return read(property.expression, visiting);
        throw new Error("exported consent text must be literal data");
      });
    }
    throw new Error("cannot prove the values of exported consent text");
  };
  return [...new Set(exported.flatMap((expression) => read(expression)))].sort();
}

function exportedString(source: string, name: string): string {
  const file = ts.createSourceFile("consent-text.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  for (const statement of file.statements) {
    if (!ts.isVariableStatement(statement) || !statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === name && declaration.initializer && ts.isStringLiteral(declaration.initializer)) {
        return declaration.initializer.text;
      }
    }
  }
  throw new Error(`the exported string is missing: ${name}`);
}

function exportedCopyProperty(source: string, property: string): string {
  const file = ts.createSourceFile("consent-text.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  for (const statement of file.statements) {
    if (!ts.isVariableStatement(statement) || !statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.name.text !== "AI_CONSENT_TEXT" || !declaration.initializer) continue;
      let object = declaration.initializer;
      while (ts.isAsExpression(object) || ts.isSatisfiesExpression(object) || ts.isParenthesizedExpression(object)) object = object.expression;
      if (!ts.isObjectLiteralExpression(object)) throw new Error("AI_CONSENT_TEXT must expose its actual text values");
      const value = object.properties.find((entry) => ts.isPropertyAssignment(entry) && entry.name.getText(file) === property);
      if (value && ts.isPropertyAssignment(value) && ts.isStringLiteral(value.initializer) && value.initializer.text) return value.initializer.text;
    }
  }
  throw new Error(`the Web consent text value is missing: ${property}`);
}

/** Resolve every shared-copy paragraph in display order; neither one may be silently omitted. */
function mailHandlingConsentParagraphs(source: string, textSource: string): string[] {
  const file = ts.createSourceFile("mail-handling.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const paragraphs: Array<{ properties: string[]; text: string }> = [];
  const visit = (node: ts.Node) => {
    if (ts.isJsxElement(node) && node.openingElement.tagName.getText(file) === "p") {
      const properties = node.children.flatMap((child) => ts.isJsxExpression(child) && child.expression
        && ts.isPropertyAccessExpression(child.expression) && child.expression.expression.getText(file) === "AI_CONSENT_TEXT"
        ? [child.expression.name.text] : []);
      if (properties.length > 0) {
        const text = node.children.map((child) => {
          if (ts.isJsxText(child)) return child.text;
          if (ts.isJsxExpression(child) && child.expression && ts.isPropertyAccessExpression(child.expression)
            && child.expression.expression.getText(file) === "AI_CONSENT_TEXT") {
            return exportedCopyProperty(textSource, child.expression.name.text);
          }
          throw new Error("the mail-handling consent paragraph contains unreadable content");
        }).join("").replace(/\s+/g, " ").trim();
        if (!text) throw new Error("the mail-handling consent paragraph is empty");
        paragraphs.push({ properties, text });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  if (paragraphs.length !== 2 || paragraphs[0].properties.join(",") !== "retainedResults"
    || paragraphs[1].properties.join(",") !== "waitingRetention") {
    throw new Error("mail-handling must display retained-results then waiting-retention paragraphs exactly once each");
  }
  return paragraphs.map((paragraph) => paragraph.text);
}

/** Values keep string literals; call-site scans blank them so text cannot impersonate code. */
function swiftCode(source: string, keepStrings = true): string {
  let code = "";
  let at = 0;
  let blockDepth = 0;
  let stringEnd: string | null = null;
  let stringEscape = "";
  const literal = (value: string) => keepStrings ? value : value.replace(/[^\r\n]/g, " ");
  while (at < source.length) {
    if (stringEnd !== null) {
      if (source.startsWith(stringEnd, at)) {
        code += literal(stringEnd);
        at += stringEnd.length;
        stringEnd = null;
      } else if (source.startsWith(stringEscape, at)) {
        const end = Math.min(source.length, at + stringEscape.length + 1);
        code += literal(source.slice(at, end));
        at = end;
      } else code += literal(source[at++]);
    } else if (blockDepth > 0) {
      if (source.startsWith("/*", at)) { blockDepth++; at += 2; }
      else if (source.startsWith("*/", at)) { blockDepth--; at += 2; }
      else { if (source[at] === "\n") code += "\n"; at++; }
    } else if (source.startsWith("//", at)) {
      code += " ";
      while (at < source.length && source[at] !== "\n") at++;
    } else if (source.startsWith("/*", at)) {
      code += " ";
      blockDepth = 1;
      at += 2;
    } else {
      const opening = source[at] === '"' || source[at] === "#" ? source.slice(at).match(/^(#+)?("""|")/) : null;
      if (opening) {
        const hashes = opening[1] ?? "";
        stringEnd = opening[2] + hashes;
        stringEscape = `\\${hashes}`;
        code += literal(opening[0]);
        at += opening[0].length;
      } else code += source[at++];
    }
  }
  if (blockDepth > 0 || stringEnd !== null) throw new Error("cannot compare an unterminated Swift comment or string");
  return code;
}

function swiftConsentInterpolation(literal: string, consentText: string): string {
  const consentCode = swiftCode(consentText);
  const expanded = literal.replace(/\\\(AIReadingConsentText\.(\w+)\)/g, (_, property: string) => {
    const declaration = consentCode.match(new RegExp(`static let ${property}(?:\\s*:\\s*String)?\\s*=\\s*("(?:[^"\\\\]|\\\\.)*")`));
    if (!declaration) throw new Error(`the native consent text value is missing: ${property}`);
    return JSON.stringify(JSON.parse(declaration[1])).slice(1, -1);
  });
  return JSON.parse(expanded);
}

function assertNativeConsentParagraph(web: string, native: string, consentText: string) {
  expect(web.length).toBeGreaterThan(0);
  const code = swiftCode(native);
  const calls = swiftCode(native, false);
  const declarations = [...code.matchAll(/static let (\w+)(?:\s*:\s*String)?\s*=\s*("(?:[^"\\]|\\.)*")/g)];
  const declaration = declarations.find((match) => swiftConsentInterpolation(match[2], consentText) === web);
  expect(declaration, "the actual Web paragraph must be declared by the native mail-handling view").toBeTruthy();
  expect(calls).toMatch(new RegExp(`Text\\(MailHandlingText\\.${declaration![1]}\\)`));
}

/** Strict future contract: both native paragraphs must be declared, displayed once and ordered. */
function assertNativeConsentParagraphs(web: string[], native: string, consentText: string) {
  expect(web).toHaveLength(2);
  const code = swiftCode(native);
  const calls = swiftCode(native, false);
  for (const [index, paragraph] of web.entries()) {
    try {
      assertNativeConsentParagraph(paragraph, native, consentText);
    } catch {
      throw new Error(`native mail-handling paragraph ${index + 1} is missing, changed or not displayed: ${paragraph}`);
    }
  }
  const declarations = new Map([...code.matchAll(/static let (\w+)(?:\s*:\s*String)?\s*=\s*("(?:[^"\\]|\\.)*")/g)]
    .map((match) => [match[1], swiftConsentInterpolation(match[2], consentText)]));
  const displayed = [...calls.matchAll(/Text\(MailHandlingText\.(\w+)\)/g)]
    .map((match) => declarations.get(match[1]))
    .filter((value): value is string => typeof value === "string" && web.includes(value));
  expect(displayed, "native consent paragraphs must match both Web values once, in display order").toEqual(web);
}

/** A test-only future Swift source; never an assertion about the unmodified native implementation. */
function nativeWithWaitingParagraph(native: string, waiting: string): string {
  return native.replace("static let items:", `static let waitingRetention = ${JSON.stringify(waiting)}\n    static let items:`)
    .replace("ForEach(Array(MailHandlingText.items.enumerated())", "Text(MailHandlingText.waitingRetention)\n                ForEach(Array(MailHandlingText.items.enumerated())");
}

/** Diagnostic fixture of ebdcbee's all-shared-paragraph predicate and single-paragraph gate. */
function assertLegacySingleMailHandlingParagraph(source: string) {
  const file = ts.createSourceFile("mail-handling.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let paragraphs = 0;
  const visit = (node: ts.Node) => {
    if (ts.isJsxElement(node) && node.openingElement.tagName.getText(file) === "p"
      && node.children.some((child) => ts.isJsxExpression(child) && child.expression
        && ts.isPropertyAccessExpression(child.expression) && child.expression.expression.getText(file) === "AI_CONSENT_TEXT")) paragraphs++;
    ts.forEachChild(node, visit);
  };
  visit(file);
  if (paragraphs !== 1) throw new Error("exactly one mail-handling consent paragraph must be present");
}

/** Read the actual schema used by the endpoint, rather than pinning a private schema's name. */
function webReadWaitingFields(source: string): { name: string; optional: boolean }[] {
  const file = ts.createSourceFile("handler.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const step = file.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "readWaitingStep");
  if (!step) throw new Error("the Web read-waiting handler is missing");
  const schemaNames: string[] = [];
  const findParse = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === "safeParse" && ts.isIdentifier(node.expression.expression)) {
      schemaNames.push(node.expression.expression.text);
    }
    ts.forEachChild(node, findParse);
  };
  findParse(step);
  if (schemaNames.length !== 1) throw new Error("the read-waiting body must have one readable schema");
  let schema: ts.Expression | undefined;
  for (const statement of file.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === schemaNames[0]) schema = declaration.initializer;
    }
  }
  const objects: ts.ObjectLiteralExpression[] = [];
  const findObject = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "object"
      && node.arguments[0] && ts.isObjectLiteralExpression(node.arguments[0])) objects.push(node.arguments[0]);
    ts.forEachChild(node, findObject);
  };
  if (schema) findObject(schema);
  if (objects.length !== 1) throw new Error("the Web request object must expose its actual fields");
  return objects[0].properties.map((property) => {
    if (!ts.isPropertyAssignment(property) || (!ts.isIdentifier(property.name) && !ts.isStringLiteral(property.name))) {
      throw new Error("the Web request field is unreadable");
    }
    let optional = false;
    const findOptional = (node: ts.Node) => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "optional") optional = true;
      ts.forEachChild(node, findOptional);
    };
    findOptional(property.initializer);
    return { name: property.name.text, optional };
  });
}

function assertAutomaticRequestParity(web: string, native: string) {
  const fields = webReadWaitingFields(web);
  // An old empty schema must stay red until the automatic API contract is integrated.
  expect(fields.length).toBeGreaterThan(0);
  const automatic = native.match(/func readWaiting\(afterConsent receipt: AIReadingConsentSaveReceipt, accessToken: String\) async throws\(MailAPIFailure\) -> ReadWaitingResult\s*\{[\s\S]*?try await post\("read-waiting",\s*\[([^\]]*)\]/)?.[1];
  expect(automatic).toBeTruthy();
  const mappings = [...automatic!.matchAll(/"([^"\n]+)"\s*:\s*([^,]+)(?:,|$)/g)].map((match) => ({ name: match[1], value: match[2].trim() }));
  expect(mappings.map((field) => field.name).sort()).toEqual(fields.map((field) => field.name).sort());
  expect(mappings).toHaveLength(1);
  expect(mappings[0].value, "send the original RPC text, preserving its zone and fractional seconds").toBe("receipt.decidedAt");
  expect(fields.every((field) => field.optional), "the existing manual empty body must remain accepted").toBe(true);
  expect(native).toMatch(/func readWaiting\(accessToken: String\) async throws\(MailAPIFailure\) -> ReadWaitingResult\s*\{[\s\S]*?post\("read-waiting",\s*\[:\]/);
}

function privacyHref(source: string): string {
  const file = ts.createSourceFile("reading-consent.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const links: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isJsxElement(node) && node.openingElement.tagName.getText(file) === "Link") {
      const isPrivacy = node.children.some((child) => ts.isJsxExpression(child) && child.expression
        && ts.isPropertyAccessExpression(child.expression) && child.expression.expression.getText(file) === "AI_CONSENT_TEXT"
        && child.expression.name.text === "privacy");
      if (isPrivacy) {
        const attribute = node.openingElement.attributes.properties.find((property) => ts.isJsxAttribute(property) && property.name.getText(file) === "href");
        if (!attribute || !ts.isJsxAttribute(attribute) || !attribute.initializer || !ts.isStringLiteral(attribute.initializer)) {
          throw new Error("the consent privacy Link must have a readable href");
        }
        links.push(attribute.initializer.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  if (links.length !== 1 || !links[0]) throw new Error("expected exactly one real consent privacy Link");
  return links[0];
}

function swiftStrings(source: string): string[] {
  const code = swiftCode(source);
  const literals = [...code.matchAll(/\bstatic\s+let\s+\w+(?:\s*:\s*String)?\s*=\s*("(?:[^"\\]|\\.)*")/g)];
  return [...new Set(literals.map((match) => JSON.parse(match[1]) as string))].sort();
}

function swiftConsentSources(): string[] {
  const files: string[] = [];
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(fullPath);
      else if (/^AIReadingConsent.*\.swift$/.test(entry.name)) files.push(fullPath);
    }
  };
  visit(SWIFT_ROOT);
  if (files.length === 0) throw new Error("the native AI reading consent source is missing");
  return files.map((file) => readFileSync(file, "utf8"));
}

function assertSharedCopy(web: string[], native: string[]) {
  // An empty set (or only a contract/version name) cannot make this comparison pass.
  expect(web.length).toBeGreaterThanOrEqual(APPROVED_COPY.length);
  expect(native.length).toBeGreaterThanOrEqual(APPROVED_COPY.length);
  for (const sentence of APPROVED_COPY) {
    expect(web, `Web is missing the approved text: ${sentence}`).toContain(sentence);
    expect(native, `iOS differs from the Web text: ${sentence}`).toContain(sentence);
  }
  const agreedWebValues = web.filter((value) => APPROVED_COPY.some((sentence) => sentence === value));
  const nativeValues = native.filter((value) => APPROVED_COPY.some((sentence) => sentence === value));
  expect(nativeValues).toEqual(agreedWebValues);
}

describe("AI reading consent copy is shared with the actual Web values", () => {
  // TODO (integration owner/coordinator): integrate the iOS popup SHA and verify
  // AI_CONSENT_TEXT.detail at that exact SHA, then restore this case to `it` before publication.
  it.skip("compares exported Web copy with native strings, including every approved sentence", () => {
    expect(existsSync(WEB_TEXT_PATH), "integrate the Web-owned src/lib/ai-consent-text.ts before declaring parity complete").toBe(true);
    const web = exportedStrings(readFileSync(WEB_TEXT_PATH, "utf8"));
    const native = swiftStrings(swiftConsentSources().join("\n"));
    assertSharedCopy(web, native);
  });

  it("compares the actual Web text version with AIReadingConsentContract.textVersion", () => {
    const web = exportedString(readRequired(WEB_TEXT_PATH), "AI_CONSENT_TEXT_VERSION");
    const native = readFileSync(path.join(SWIFT_ROOT, "Data/AIReadingConsent.swift"), "utf8")
      .match(/enum AIReadingConsentContract\s*\{\s*static let textVersion\s*=\s*"([^"\n]+)"/)?.[1];
    expect(web.length).toBeGreaterThan(0);
    expect(native).toBe(web);
  });

  it("compares the real Web privacy Link href with the native WebLink.privacy URL", () => {
    const webHref = privacyHref(readRequired(WEB_CONSENT_VIEW_PATH));
    const nativeLinks = readFileSync(path.join(SWIFT_ROOT, "Screens/Shared/OpenWeb.swift"), "utf8");
    const config = readFileSync(path.join(SWIFT_ROOT, "Config/AppConfig.swift"), "utf8");
    const nativePath = nativeLinks.match(/static let privacy\s*=\s*page\("([^"\n]+)"\)/)?.[1];
    const nativeBase = config.match(/static let webBase\s*=\s*URL\(string:\s*"([^"\n]+)"\)/)?.[1];
    // These source checks justify evaluating the actual native helper as base + path.
    expect(nativeLinks).toMatch(/static let base\s*=\s*AppConfig\.webBase/);
    expect(nativeLinks).toMatch(/URL\(string:\s*base\.absoluteString\s*\+\s*path\)\s*\?\?\s*base/);
    expect(nativePath).toBe(webHref);
    expect(nativeBase).toBeTruthy();
    const nativeURL = new URL(`${nativeBase}${nativePath}`);
    expect(nativeURL.protocol).toBe("https:");
    expect(nativeURL.href).toBe(new URL(webHref, nativeBase).href);
    expect(readFileSync(path.join(SWIFT_ROOT, "Screens/Consent/AIReadingConsentView.swift"), "utf8"))
      .toMatch(/SFSafariViewController\(url:\s*WebLink\.privacy\)/);
  });

  it("keeps the existing retained-results paragraph identical to the actual native view", () => {
    const web = mailHandlingConsentParagraphs(readRequired(WEB_HANDLING_VIEW_PATH), readRequired(WEB_TEXT_PATH));
    const native = readFileSync(path.join(SWIFT_ROOT, "Screens/Settings/MailHandlingView.swift"), "utf8");
    const consentText = readFileSync(path.join(SWIFT_ROOT, "Screens/Consent/AIReadingConsentView.swift"), "utf8");
    assertNativeConsentParagraph(web[0], native, consentText);
  });

  it("reads both Web mail-handling paragraphs in display order, including the approved waiting deadline", () => {
    const text = readRequired(WEB_TEXT_PATH);
    expect(mailHandlingConsentParagraphs(readRequired(WEB_HANDLING_VIEW_PATH), text)).toEqual([
      `読み取りを許可しているときだけ、Anthropic の Claude に送ります。${exportedCopyProperty(text, "retainedResults")}`,
      "許可を待つメールは、届いてから 14 日で消えます。",
    ]);
  });

  it("reproduces the current integration base's old one-paragraph failure with its all-shared-paragraph predicate", () => {
    const view = readRequired(WEB_HANDLING_VIEW_PATH);
    expect(() => assertLegacySingleMailHandlingParagraph(view)).toThrow("exactly one mail-handling consent paragraph must be present");
    const waitingParagraph = [...view.matchAll(/<p\b[^>]*>[\s\S]*?<\/p>/g)].map((match) => match[0]).find((value) => value.includes("AI_CONSENT_TEXT.waitingRetention"));
    expect(waitingParagraph).toBeTruthy();
    assertLegacySingleMailHandlingParagraph(view.replace(waitingParagraph!, ""));
  });

  it("explicitly detects that the actual iOS view still lacks the second waiting-retention paragraph", () => {
    const web = mailHandlingConsentParagraphs(readRequired(WEB_HANDLING_VIEW_PATH), readRequired(WEB_TEXT_PATH));
    const native = readFileSync(path.join(SWIFT_ROOT, "Screens/Settings/MailHandlingView.swift"), "utf8");
    const consentText = readFileSync(path.join(SWIFT_ROOT, "Screens/Consent/AIReadingConsentView.swift"), "utf8");
    // This active gap detector is not a declaration of full native parity. Once iOS adds this
    // paragraph, replace this known-gap assertion with the strict comparison below.
    expect(() => assertNativeConsentParagraphs(web, native, consentText))
      .toThrow(`native mail-handling paragraph 2 is missing, changed or not displayed: ${web[1]}`);
  });

  it("the strict two-paragraph helper accepts a future completed native fixture, not the current iOS implementation", () => {
    const web = mailHandlingConsentParagraphs(readRequired(WEB_HANDLING_VIEW_PATH), readRequired(WEB_TEXT_PATH));
    const native = readFileSync(path.join(SWIFT_ROOT, "Screens/Settings/MailHandlingView.swift"), "utf8");
    const consentText = readFileSync(path.join(SWIFT_ROOT, "Screens/Consent/AIReadingConsentView.swift"), "utf8");
    const completedFixture = nativeWithWaitingParagraph(native, web[1]);
    assertNativeConsentParagraphs(web, completedFixture, consentText);
    expect(completedFixture).not.toBe(native);
  });

  it("negative controls reject missing, duplicate or reordered Web paragraphs", () => {
    const view = readRequired(WEB_HANDLING_VIEW_PATH);
    const text = readRequired(WEB_TEXT_PATH);
    const sourceParagraphs = [...view.matchAll(/<p\b[^>]*>[\s\S]*?<\/p>/g)].map((match) => match[0]).filter((value) => value.includes("AI_CONSENT_TEXT."));
    expect(sourceParagraphs).toHaveLength(2);
    const [first, second] = sourceParagraphs;
    for (const changed of [view.replace(first, ""), view.replace(second, ""), view.replace(first, `${first}${first}`), view.replace(second, `${second}${second}`), view.replace(`${first}\n      ${second}`, `${second}\n      ${first}`)]) {
      expect(changed).not.toBe(view);
      expect(() => mailHandlingConsentParagraphs(changed, text)).toThrow();
    }
  });

  it("negative controls reject an undeclared, hidden, changed, duplicate or reordered native deadline in the future fixture", () => {
    const web = mailHandlingConsentParagraphs(readRequired(WEB_HANDLING_VIEW_PATH), readRequired(WEB_TEXT_PATH));
    const native = readFileSync(path.join(SWIFT_ROOT, "Screens/Settings/MailHandlingView.swift"), "utf8");
    const consentText = readFileSync(path.join(SWIFT_ROOT, "Screens/Consent/AIReadingConsentView.swift"), "utf8");
    const fixture = nativeWithWaitingParagraph(native, web[1]);
    assertNativeConsentParagraphs(web, fixture, consentText);
    const display = "Text(MailHandlingText.waitingRetention)";
    const firstDisplay = "Text(MailHandlingText.readingPermission)";
    for (const changed of [
      fixture.replace(/static let waitingRetention = [^\n]+\n/, ""),
      fixture.replace(display, "EmptyView()"),
      fixture.replace(web[1], web[1].replace("14 日", "15 日")),
      fixture.replace(display, `${display}\n${display}`),
      fixture.replace(firstDisplay, "__first__").replace(display, firstDisplay).replace("__first__", display),
    ]) {
      expect(changed).not.toBe(fixture);
      expect(() => assertNativeConsentParagraphs(web, changed, consentText)).toThrow();
    }
  });

  it.each(["line", "block"] as const)("negative control: a %s-commented native Text is not a displayed deadline or retained paragraph", (style) => {
    const web = mailHandlingConsentParagraphs(readRequired(WEB_HANDLING_VIEW_PATH), readRequired(WEB_TEXT_PATH));
    const native = readFileSync(path.join(SWIFT_ROOT, "Screens/Settings/MailHandlingView.swift"), "utf8");
    const consentText = readFileSync(path.join(SWIFT_ROOT, "Screens/Consent/AIReadingConsentView.swift"), "utf8");
    const fixture = nativeWithWaitingParagraph(native, web[1]);
    assertNativeConsentParagraphs(web, fixture, consentText);
    const comment = (text: string) => style === "line" ? `// ${text}` : `/* ${text} */`;
    const deadline = "Text(MailHandlingText.waitingRetention)";
    expect(() => assertNativeConsentParagraphs(web, fixture.replace(deadline, comment(deadline)), consentText)).toThrow();
    const retained = "Text(MailHandlingText.readingPermission)";
    expect(() => assertNativeConsentParagraph(web[0], native.replace(retained, comment(retained)), consentText)).toThrow();
    const declaration = `static let waitingRetention = ${JSON.stringify(web[1])}`;
    expect(fixture).toContain(declaration);
    expect(() => assertNativeConsentParagraphs(web, fixture.replace(declaration, comment(declaration)), consentText)).toThrow();
    const retainedValue = exportedCopyProperty(readRequired(WEB_TEXT_PATH), "retainedResults");
    const oldComment = comment(`static let retainedResults = ${JSON.stringify(retainedValue)}`);
    const changedConsent = `${oldComment}\n${consentText.replace(retainedValue, "結果は残りません。")}`;
    expect(changedConsent).not.toBe(consentText);
    expect(() => assertNativeConsentParagraph(web[0], native, changedConsent)).toThrow();
  });

  it("Swift comment removal preserves URL and comment markers inside normal, escaped, raw and multiline strings", () => {
    const url = "https://example.test/path//literal";
    const literals = [
      `static let url = ${JSON.stringify(url)}`,
      `static let markers = ${JSON.stringify("/* literal */ // literal")}`,
      `static let escaped = ${JSON.stringify('say "// literal"')}`,
      'static let raw = #"https://example.test/"quoted"/* literal */"#',
      'let multiline = """\nhttps://example.test // literal\n/* literal */\n"""',
    ];
    const code = swiftCode(`${literals.join("\n")}\n// discard line\n/* discard outer /* discard nested */ discard tail */\n`);
    for (const literal of literals) expect(code).toContain(literal);
    expect(code).not.toContain("discard");
    expect(swiftStrings(`${literals[0]} // discard`)).toEqual([url]);
    expect(() => swiftCode('/* unfinished')).toThrow("unterminated Swift comment or string");
    expect(() => swiftCode('let unfinished = "string')).toThrow("unterminated Swift comment or string");
  });

  it.each(["normal", "raw", "multiline"] as const)("negative control: native Text inside a %s string is not a rendered paragraph", (style) => {
    const web = mailHandlingConsentParagraphs(readRequired(WEB_HANDLING_VIEW_PATH), readRequired(WEB_TEXT_PATH));
    const native = readFileSync(path.join(SWIFT_ROOT, "Screens/Settings/MailHandlingView.swift"), "utf8");
    const consentText = readFileSync(path.join(SWIFT_ROOT, "Screens/Consent/AIReadingConsentView.swift"), "utf8");
    const fixture = nativeWithWaitingParagraph(native, web[1]);
    const unused = (call: string) => style === "normal" ? `let unused = ${JSON.stringify(call)}`
      : style === "raw" ? `let unused = #"${call}"#` : `let unused = """\n${call}\n"""`;
    const deadline = "Text(MailHandlingText.waitingRetention)";
    expect(() => assertNativeConsentParagraphs(web, fixture.replace(deadline, unused(deadline)), consentText)).toThrow();
    const retained = "Text(MailHandlingText.readingPermission)";
    expect(() => assertNativeConsentParagraph(web[0], native.replace(retained, unused(retained)), consentText)).toThrow();
  });

  it("compares the automatic request field with the Web schema and preserves the raw receipt and manual empty body", () => {
    assertAutomaticRequestParity(readRequired(WEB_MAIL_HANDLER_PATH), readFileSync(path.join(SWIFT_ROOT, "Data/MailActionsAPI.swift"), "utf8"));
  });

  it("negative control: a renamed field, rebuilt timestamp or mandatory receipt cannot satisfy request parity", () => {
    const web = readRequired(WEB_MAIL_HANDLER_PATH);
    const native = readFileSync(path.join(SWIFT_ROOT, "Data/MailActionsAPI.swift"), "utf8");
    assertAutomaticRequestParity(web, native);
    expect(() => assertAutomaticRequestParity(web, native.replace('["after_consent": receipt.decidedAt]', '["other_field": receipt.decidedAt]'))).toThrow();
    expect(() => assertAutomaticRequestParity(web, native.replace('["after_consent": receipt.decidedAt]', '["after_consent": Instant.format(receipt.decidedAt)]'))).toThrow();
    expect(() => assertAutomaticRequestParity(web.replace(/\.optional\(\)/g, ""), native)).toThrow();
    expect(() => assertAutomaticRequestParity(web, native.replace('post("read-waiting", [:]', 'post("read-waiting", ["after_consent": "retry"]'))).toThrow();
    const emptyBody = 'const requestShape = z.object({}).strict(); export async function readWaitingStep(request: Request) { return requestShape.safeParse(request); }';
    expect(() => assertAutomaticRequestParity(emptyBody, native)).toThrow();
  });

  it("negative control: removing or changing the actual consent paragraph cannot pass parity", () => {
    const view = readRequired(WEB_HANDLING_VIEW_PATH);
    const text = readRequired(WEB_TEXT_PATH);
    const web = mailHandlingConsentParagraphs(view, text)[0];
    const native = readFileSync(path.join(SWIFT_ROOT, "Screens/Settings/MailHandlingView.swift"), "utf8");
    const consentText = readFileSync(path.join(SWIFT_ROOT, "Screens/Consent/AIReadingConsentView.swift"), "utf8");
    assertNativeConsentParagraph(web, native, consentText);
    expect(() => mailHandlingConsentParagraphs(view.replace(/<p\b[^>]*>[\s\S]*?<\/p>/, ""), text)).toThrow();
    const changed = mailHandlingConsentParagraphs(view.replace("Claude に送ります。", "Claude に送りません。"), text)[0];
    expect(changed).not.toBe(web);
    expect(() => assertNativeConsentParagraph(changed, native, consentText)).toThrow();
    expect(() => assertNativeConsentParagraph(web, native.replace(/Text\(MailHandlingText\.\w+\)/g, "EmptyView()"), consentText)).toThrow();
    const retained = exportedCopyProperty(text, "retainedResults");
    const changedResults = text.replace(retained, retained.replace("結果は残ります。", "結果は消えます。"));
    expect(mailHandlingConsentParagraphs(view, changedResults)[0]).not.toBe(web);
    expect(() => assertNativeConsentParagraph(web, native, consentText.replace(retained, "結果は残りません。"))).toThrow();
    const webCopy = exportedStrings(text);
    const nativeCopy = swiftStrings(swiftConsentSources().join("\n"));
    expect(() => assertSharedCopy(webCopy, nativeCopy.filter((value) => value !== retained))).toThrow();
  });

  it("resolves exported values and aliases regardless of their constant names", () => {
    const source = `const unrelated = "別の文"; const renamed = "許可する";
      export const arbitrary = { heading: "メールの読み取り", positive: renamed, nested: ["許可しない"] } as const;`;
    expect(exportedStrings(source)).toEqual(["メールの読み取り", "許可しない", "許可する"].sort());
    expect(exportedStrings(source)).not.toContain("別の文");
  });

  it("negative control: empty sources and a contract name alone cannot satisfy parity", () => {
    expect(() => assertSharedCopy([], [])).toThrow();
    expect(() => assertSharedCopy(["ai-reading-v1"], ["ai-reading-v1"])).toThrow();
    expect(exportedStrings("const local = '許可する';")).toEqual([]);
  });

  it("negative control: changing native wording is detected even when declaration names stay unchanged", () => {
    const native = APPROVED_COPY.map((sentence, index) => `static let value${index} = ${JSON.stringify(sentence)}`).join("\n");
    const web = [...APPROVED_COPY].sort();
    assertSharedCopy(web, swiftStrings(native));
    expect(() => assertSharedCopy(web, swiftStrings(native.replace("Claude で読み取ります。", "Claude で処理します。")))).toThrow();
  });

  it("negative control: changing the actual Web version or privacy destination is detected", () => {
    const text = readRequired(WEB_TEXT_PATH);
    const nativeVersion = readFileSync(path.join(SWIFT_ROOT, "Data/AIReadingConsent.swift"), "utf8")
      .match(/enum AIReadingConsentContract\s*\{\s*static let textVersion\s*=\s*"([^"\n]+)"/)?.[1];
    expect(nativeVersion).toBeTruthy();
    expect(exportedString(text.replace(/(AI_CONSENT_TEXT_VERSION\s*=\s*)"[^"]+"/, '$1"changed-version"'), "AI_CONSENT_TEXT_VERSION"))
      .not.toBe(nativeVersion);
    const view = readRequired(WEB_CONSENT_VIEW_PATH);
    const originalHref = privacyHref(view);
    expect(privacyHref(view.replace(`href="${originalHref}"`, 'href="/changed-privacy"'))).not.toBe(originalHref);
    expect(() => privacyHref("export const empty = true;")).toThrow();
  });
});
