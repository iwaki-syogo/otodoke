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
const SWIFT_ROOT = path.join(ROOT, "ios/Otodoke");
const APPROVED_COPY = [
  "メールの読み取り",
  "届いたメールは、Anthropic の Claude で読み取ります。",
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
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"])\/\/.*$/gm, "$1");
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
  it("compares exported Web copy with native strings, including every approved sentence", () => {
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
