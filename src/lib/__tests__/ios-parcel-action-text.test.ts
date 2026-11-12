import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "../../..");
const DETAIL = "ios/Otodoke/Screens/Detail/ParcelDetailView.swift";
const read = (file: string) => readFileSync(path.join(ROOT, file), "utf8");
const names = {
  removeReceivedLabel: "REMOVE_RECEIVED_LABEL",
  removeReceivedNote: "REMOVE_RECEIVED_NOTE",
  removeDeliveredLabel: "REMOVE_DELIVERED_LABEL",
} as const;
type Name = keyof typeof names;
type WebSources = { words: string; received: string; delivered: string };

/** Preserve offsets while hiding comments and, for calls, every ordinary/raw/multiline string. */
function swiftCode(source: string, keepStrings = true): string {
  let out = "", at = 0, depth = 0;
  let end: string | null = null, escape = "";
  const blank = (value: string) => value.replace(/[^\r\n]/g, " ");
  const literal = (value: string) => keepStrings ? value : blank(value);
  while (at < source.length) {
    if (end !== null) {
      if (source.startsWith(end, at)) { out += literal(end); at += end.length; end = null; }
      else if (source.startsWith(escape, at)) {
        const next = Math.min(source.length, at + escape.length + 1);
        out += literal(source.slice(at, next)); at = next;
      } else out += literal(source[at++]);
    } else if (depth > 0) {
      if (source.startsWith("/*", at)) { depth++; out += "  "; at += 2; }
      else if (source.startsWith("*/", at)) { depth--; out += "  "; at += 2; }
      else out += blank(source[at++]);
    } else if (source.startsWith("//", at)) {
      while (at < source.length && source[at] !== "\n") out += blank(source[at++]);
    } else if (source.startsWith("/*", at)) { depth = 1; out += "  "; at += 2; }
    else {
      const opening = source[at] === '"' || source[at] === "#" ? source.slice(at).match(/^(#+)?("""|")/) : null;
      if (opening) {
        const hashes = opening[1] ?? "";
        end = opening[2] + hashes; escape = `\\${hashes}`;
        out += literal(opening[0]); at += opening[0].length;
      } else out += source[at++];
    }
  }
  if (depth || end !== null) throw new Error("unterminated Swift comment or string");
  return out;
}

function region(source: string, marker: string): { start: number; end: number } {
  const code = swiftCode(source, false), at = code.indexOf(marker);
  if (at < 0 || code.indexOf(marker, at + marker.length) >= 0) throw new Error(`missing or ambiguous real Swift block: ${marker}`);
  const open = code.indexOf("{", at + marker.length);
  if (open < 0) throw new Error(`missing Swift body: ${marker}`);
  let depth = 1;
  for (let i = open + 1; i < code.length; i++) {
    if (code[i] === "{") depth++;
    if (code[i] === "}" && --depth === 0) return { start: open + 1, end: i };
  }
  throw new Error(`unclosed Swift block: ${marker}`);
}
function body(source: string, marker: string): string {
  const found = region(source, marker);
  return source.slice(found.start, found.end);
}
function assertExecutable(source: string, pattern: RegExp): void {
  const match = swiftCode(source).match(pattern);
  expect(match, "the expected call must exist in executable Swift").toBeTruthy();
  expect(swiftCode(source, false).slice(match!.index, match!.index! + match![0].length)).toBe(swiftCode(match![0], false));
}

/** No approved-copy replica: the native-only gate checks declarations and executable display binding. */
function assertNative(source: string): Map<string, string> {
  const declaration = body(source, "enum ParcelActionText"), code = swiftCode(declaration), calls = swiftCode(declaration, false);
  const entries = [...code.matchAll(/static let (\w+)\s*=\s*"([^"\\]*)"/g)];
  expect(entries.map((entry) => entry[1]).sort()).toEqual(Object.keys(names).sort());
  for (const entry of entries) {
    expect(calls.slice(entry.index, entry.index! + entry[0].length)).toBe(swiftCode(entry[0], false));
    expect(entry[2]).not.toBe("");
  }
  const allCalls = swiftCode(source, false), header = body(source, "private func header(");
  const received = swiftCode(body(header, "if model.showsNotReceived"), false);
  expect(received).toMatch(/receiptButton\(ParcelActionText\.removeReceivedLabel,\s*action:\s*\{\s*await model\.markNotReceived\(\)\s*\}\)/);
  expect(received).toMatch(/Text\(ParcelActionText\.removeReceivedNote\)/);
  assertExecutable(body(header, "if model.showsNotReceived"), /receiptButton\(ParcelActionText\.removeReceivedLabel,\s*action:\s*\{\s*await model\.markNotReceived\(\)\s*\}\)\s*\.accessibilityIdentifier\("detail\.removeReceived"\)/);
  expect(swiftCode(header, false)).toMatch(/if model\.showsNotDelivered\s*\{\s*notDeliveredButton\s*\}/);
  for (const name of Object.keys(names)) {
    expect(allCalls.match(new RegExp(`\\bParcelActionText\\.${name}\\b`, "g")), name).toHaveLength(1);
  }
  const receipt = body(source, "private func receiptButton(");
  expect(swiftCode(receipt, false)).toMatch(/Button\s*\{\s*Task\s*\{\s*await action\(\)\s*\}\s*\}\s*label:/);
  expect(swiftCode(body(receipt, "label:"), false)).toMatch(/Text\(title\)/);
  const delivered = body(source, "private var notDeliveredButton:");
  expect(swiftCode(delivered, false)).toMatch(/Button\s*\{\s*Task\s*\{\s*await model\.markNotDelivered\(\)\s*\}\s*\}\s*label:/);
  expect(swiftCode(body(delivered, "label:"), false)).toMatch(/Text\(ParcelActionText\.removeDeliveredLabel\)/);
  assertExecutable(delivered, /\}\s*\.buttonStyle\(\.plain\)\s*\.accessibilityIdentifier\("detail\.removeDelivered"\)/);
  return new Map(entries.map((entry) => [entry[1], entry[2]]));
}

function nodes(node: ts.Node): ts.Node[] {
  const result: ts.Node[] = [];
  node.forEachChild((child) => { result.push(child, ...nodes(child)); });
  return result;
}
const parse = (source: string) => ts.createSourceFile("actual.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function renderedReferences(source: string, functionName: string, tag: string): string[] {
  const file = parse(source), component = file.statements.filter(ts.isFunctionDeclaration).find((node) => node.name?.text === functionName);
  if (!component?.body) throw new Error(`missing actual Web component ${functionName}`);
  const returns = component.body.statements.filter(ts.isReturnStatement);
  expect(returns).toHaveLength(1);
  if (!returns[0].expression) throw new Error(`missing actual Web return ${functionName}`);
  const elements = nodes(returns[0].expression).filter(ts.isJsxElement).filter((node) => node.openingElement.tagName.getText(file) === tag);
  return elements.flatMap((element) => element.children.filter(ts.isJsxExpression)
    .flatMap((child) => child.expression && ts.isIdentifier(child.expression) ? [child.expression.text] : []));
}
function readWeb(): WebSources {
  // Deliberately fail if this branch has not integrated the real Web input. No snapshot fallback or skip.
  return {
    words: read("src/lib/parcel-action-text.ts"),
    received: read("src/app/app/parcels/[id]/not-received-button.tsx"),
    delivered: read("src/app/app/parcels/[id]/not-delivered-button.tsx"),
  };
}
function assertCopy(native: string, web: WebSources): void {
  const values = assertNative(native), declarations = nodes(parse(web.words)).filter(ts.isVariableDeclaration);
  expect(declarations.map((node) => node.name.getText()).sort()).toEqual(Object.values(names).sort());
  for (const [name, key] of Object.entries(names)) {
    const declaration = declarations.find((node) => node.name.getText() === key);
    if (!declaration?.initializer || !ts.isStringLiteral(declaration.initializer)) throw new Error(`missing literal Web value ${key}`);
    expect(values.get(name), key).toBe(declaration.initializer.text);
  }
  expect(renderedReferences(web.received, "NotReceivedButton", "PendingButton")).toEqual([names.removeReceivedLabel]);
  expect(renderedReferences(web.received, "NotReceivedButton", "p").filter((name) => name === names.removeReceivedNote)).toEqual([names.removeReceivedNote]);
  expect(renderedReferences(web.delivered, "NotDeliveredButton", "PendingButton")).toEqual([names.removeDeliveredLabel]);
  expect(renderedReferences(web.delivered, "NotDeliveredButton", "p")).not.toContain(names.removeReceivedNote);
}
function changed(source: string, mutation: (source: string) => string): string {
  const mutated = mutation(source);
  expect(mutated, "negative control must change the actual source").not.toBe(source);
  return mutated;
}

describe("A24: the native detail actions share the actual Web copy", () => {
  it("binds three independent native constants to the real buttons and the receipt-only note", () => assertNative(read(DETAIL)));

  it("compares values with the integrated Web module and its actual rendered controls", () => {
    const web = readWeb();
    assertCopy(read(DETAIL), web);
  });

  it("finds the existing UI tests by stable button identifiers rather than copied display words", () => {
    const received = read("ios/OtodokeUITests/ReceivedUITests.swift"), realData = read("ios/OtodokeUITests/RealDataUITests.swift");
    assertExecutable(received, /app\.buttons\["detail\.removeDelivered"\]/);
    assertExecutable(received, /app\.buttons\["detail\.removeReceived"\]/);
    assertExecutable(realData, /app\.buttons\["detail\.removeDelivered"\]/);
    for (const source of [received, realData]) {
      expect(swiftCode(source)).not.toMatch(/app\.buttons\["(?:届いていない|受け取っていない)"\]/);
    }
  });

  it.each(["line comment", "block comment", "raw string", "multiline string"] as const)("rejects a %s pretending to render a native action", (kind) => {
    const native = read(DETAIL);
    assertNative(native);
    for (const call of [
      "receiptButton(ParcelActionText.removeReceivedLabel, action: { await model.markNotReceived() })",
      "Text(ParcelActionText.removeReceivedNote)",
      "Text(ParcelActionText.removeDeliveredLabel)",
    ]) {
      const fake = kind === "line comment" ? `// ${call}\nEmptyView()`
        : kind === "block comment" ? `/* ${call} */ EmptyView()`
          : kind === "raw string" ? `let phantom = #"${call}"#\nEmptyView()`
            : `let phantom = """\n${call}\n"""\nEmptyView()`;
      const mutated = changed(native, (source) => source.replace(call, fake));
      expect(() => assertNative(mutated)).toThrow();
    }
  });

  it("rejects moving the note outside the receipt-only condition", () => {
    const native = read(DETAIL);
    assertNative(native);
    const found = region(native, "if model.showsNotReceived"), note = "Text(ParcelActionText.removeReceivedNote)";
    const mutated = changed(native, (source) => source.slice(0, found.start)
      + source.slice(found.start, found.end).replace(note, "EmptyView()")
      + source.slice(found.end, found.end + 1) + `\n${note}\n` + source.slice(found.end + 1));
    expect(() => assertNative(mutated)).toThrow();
  });

  it("rejects wiring receipt removal to a different action", () => {
    const native = read(DETAIL);
    assertNative(native);
    const mutated = changed(native, (source) => source.replace("await model.markNotReceived()", "await model.markReceived()"));
    expect(() => assertNative(mutated)).toThrow();
  });

  it("rejects an identifier left only in a comment instead of on its actual button", () => {
    const native = read(DETAIL);
    assertNative(native);
    for (const id of ["detail.removeReceived", "detail.removeDelivered"]) {
      const call = `.accessibilityIdentifier("${id}")`;
      const mutated = changed(native, (source) => source.replace(call, `/* ${call} */`));
      expect(() => assertNative(mutated)).toThrow();
    }
  });

  it.each(Object.keys(names).flatMap((name) => ["native", "web"].map((side) => ({ name: name as Name, side }))))("rejects a one-character $side change to $name", ({ name, side }) => {
    const native = read(DETAIL), web = readWeb();
    assertCopy(native, web);
    const value = assertNative(native).get(name)!;
    if (side === "native") {
      const mutated = changed(native, (source) => source.replace(new RegExp(`(static let ${name}\\s*=\\s*")([^"\\\\]*)"`), '$1$2改"'));
      expect(() => assertCopy(mutated, web)).toThrow();
    } else {
      const mutated = changed(web.words, (source) => source.replace(`"${value}"`, `"${value}改"`));
      expect(() => assertCopy(native, { ...web, words: mutated })).toThrow();
    }
  });

  it.each(Object.keys(names) as Name[])("accepts a coordinated one-character change to %s in the two real constant locations", (name) => {
    const native = read(DETAIL), web = readWeb();
    assertCopy(native, web);
    const value = assertNative(native).get(name)!;
    const mutatedNative = changed(native, (source) => source.replace(new RegExp(`(static let ${name}\\s*=\\s*")([^"\\\\]*)"`), '$1$2改"'));
    const mutatedWeb = changed(web.words, (source) => source.replace(`"${value}"`, `"${value}改"`));
    expect(() => assertCopy(mutatedNative, { ...web, words: mutatedWeb })).not.toThrow();
  });
});
