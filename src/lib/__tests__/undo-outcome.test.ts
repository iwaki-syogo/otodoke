import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { CANNOT_UNDO_NOTE, UNDO_CHANGED_NOTICE, UNDO_FAILED_NOTICE } from "@/lib/format";
import { runUndo } from "@/lib/undo-outcome";

const receipt = { id: "parcel", receipt_id: "opaque-receipt" };

describe("what 元に戻す knows", () => {
  it("all restored: returns the confirmed restored IDs", async () => {
    expect(await runUndo(async () => ({ restored: [receipt.id], changed: [], failed: [] }), [receipt])).toEqual({ restored: [receipt.id], changed: [], failed: [] });
  });
  it("a change elsewhere says nothing about whether a parcel is still received", async () => {
    expect(await runUndo(async () => ({ restored: [], changed: [receipt.id], failed: [] }), [receipt])).toEqual({ restored: [], changed: [receipt.id], failed: [] });
    expect(UNDO_CHANGED_NOTICE).not.toContain("受け取り済みのまま");
  });
  it("a thrown request is unconfirmed without guessing whether it was sent", async () => {
    expect(await runUndo(async () => { throw new Error("offline"); }, [receipt])).toEqual({ restored: [], changed: [], failed: [], unconfirmed: [receipt.id] });
    expect(UNDO_FAILED_NOTICE).toBe("元に戻せませんでした");
  });
  it("an explicit refusal stays failed beside an explicitly unconfirmed result", async () => {
    const other = { id: "other", receipt_id: "other-receipt" };
    expect(await runUndo(async () => ({ restored: [], changed: [], failed: [receipt.id], unconfirmed: [other.id] }), [receipt, other]))
      .toEqual({ restored: [], changed: [], failed: [receipt.id], unconfirmed: [other.id] });
  });
  it("a malformed, missing or contradictory group does not erase valid facts or become a refusal", async () => {
    const other = { id: "other", receipt_id: "other-receipt" }, missing = { id: "missing", receipt_id: "missing-receipt" };
    expect(await runUndo(async () => ({ restored: [receipt.id], changed: [other.id], failed: [other.id] }), [receipt, other, missing]))
      .toEqual({ restored: [receipt.id], changed: [], failed: [], unconfirmed: [other.id, missing.id] });
  });
});

type SwiftBlock = { start: number; open: number; end: number };
type UndoBranch = "done" | "partly" | "failed" | "unconfirmed";
type PhantomKind = "line comment" | "block comment" | "raw string" | "multiline string";

/** Both views have identical offsets: declarations retain literals, executable code blanks them. */
function swiftCode(source: string, keepStrings = true): string {
  let code = "", at = 0, blockDepth = 0;
  let stringEnd: string | null = null, stringEscape = "";
  const literal = (value: string) => keepStrings ? value : value.replace(/[^\r\n]/g, " ");
  while (at < source.length) {
    if (stringEnd !== null) {
      if (source.startsWith(stringEnd, at)) {
        code += literal(stringEnd); at += stringEnd.length; stringEnd = null;
      } else if (source.startsWith(stringEscape, at)) {
        const end = Math.min(source.length, at + stringEscape.length + 1);
        code += literal(source.slice(at, end)); at = end;
      } else code += literal(source[at++]);
    } else if (blockDepth > 0) {
      if (source.startsWith("/*", at)) { blockDepth++; at += 2; }
      else if (source.startsWith("*/", at)) { blockDepth--; at += 2; }
      else { if (source[at] === "\n") code += "\n"; at++; }
    } else if (source.startsWith("//", at)) {
      code += " ";
      while (at < source.length && source[at] !== "\n") at++;
    } else if (source.startsWith("/*", at)) {
      code += " "; blockDepth = 1; at += 2;
    } else {
      const opening = source[at] === '"' || source[at] === "#" ? source.slice(at).match(/^(#+)?("""|")/) : null;
      if (opening) {
        const hashes = opening[1] ?? "";
        stringEnd = opening[2] + hashes; stringEscape = "\\" + hashes;
        code += literal(opening[0]); at += opening[0].length;
      } else code += source[at++];
    }
  }
  if (blockDepth > 0 || stringEnd !== null) throw new Error("unterminated Swift source");
  return code;
}

function singleBlock(code: string, pattern: RegExp, from = 0, to = code.length): SwiftBlock {
  const matches = [...code.slice(from, to).matchAll(pattern)];
  expect(matches, "one executable Swift block must own the binding").toHaveLength(1);
  const match = matches[0], start = from + match.index!;
  const open = code.indexOf("{", start);
  expect(open).toBeLessThan(to);
  let depth = 0;
  for (let at = open; at < to; at++) {
    if (code[at] === "{") depth++;
    if (code[at] === "}" && --depth === 0) return { start, open, end: at + 1 };
  }
  throw new Error("missing closing Swift brace");
}

function realLiteral(text: string, calls: string, owner: SwiftBlock, pattern: RegExp): string {
  const candidates = [...text.slice(owner.open + 1, owner.end - 1).matchAll(pattern)].filter((match) => {
    const at = owner.open + 1 + match.index!;
    return calls.slice(at, at + match[0].length) === swiftCode(match[0], false);
  });
  expect(candidates, "one real declaration, not a declaration inside a string").toHaveLength(1);
  return JSON.parse(candidates[0][1]) as string;
}

function nativeUndo(model: string) {
  const text = swiftCode(model), calls = swiftCode(model, false);
  expect(calls.length).toBe(text.length);
  const owner = singleBlock(calls, /\bfinal\s+class\s+ParcelListModel\b[^{]*\{/g);
  const changed = realLiteral(text, calls, owner, /\bstatic let undoChangedText\s*=\s*("(?:[^"\\]|\\.)*")/g);
  const cannot = realLiteral(text, calls, owner, /\bstatic func cannotUndoNote\([^)]*\)\s*->\s*String\s*\{\s*("(?:[^"\\]|\\.)*")\s*\}/g);
  const failed = realLiteral(text, calls, owner, /\bstatic let undoFailedText\s*=\s*("(?:[^"\\]|\\.)*")/g);
  const unconfirmed = realLiteral(text, calls, owner, /\bstatic let unconfirmedText\s*=\s*("(?:[^"\\]|\\.)*")/g);
  const undo = singleBlock(calls, /\bfunc\s+undo\(\)\s+async\s*\{/g, owner.open + 1, owner.end - 1);
  const flow = calls;
  const presentation = singleBlock(flow, /\bswitch\s+outcome\s*\{/g, undo.open + 1, undo.end - 1);
  const labels: { name: string; start: number; body: number }[] = [];
  let depth = 0;
  for (let at = presentation.open + 1; at < presentation.end - 1; at++) {
    const label = depth === 0 ? flow.slice(at).match(/^case\s+\.(\w+)\s*:/) : null;
    if (label) {
      labels.push({ name: label[1], start: at, body: at + label[0].length });
      at += label[0].length - 1;
    } else if (flow[at] === "{") depth++;
    else if (flow[at] === "}") depth--;
  }
  expect(labels.map((label) => label.name)).toEqual(["done", "partly", "failed", "unconfirmed"]);
  const branches = Object.fromEntries(labels.map((label, index) => [
    label.name, flow.slice(label.body, labels[index + 1]?.start ?? presentation.end - 1),
  ])) as Record<UndoBranch, string>;
  expect(text.slice(owner.open, owner.end)).not.toContain("受け取り済みのまま");
  const deliver = singleBlock(calls, /\bfunc\s+deliverAll\(\)\s+async\s*\{/g, owner.open + 1, owner.end - 1);
  return { text, calls, changed, cannot, failed, unconfirmed, presentation, branches, deliver: calls.slice(deliver.open + 1, deliver.end - 1) };
}

function assertUndoPresentation(actual: ReturnType<typeof nativeUndo>) {
  expect(actual.branches.partly.trim()).toMatch(/^showToast\(ListToast\(text:\s*conflicted\s*\?\s*Self\.undoChangedText\s*:\s*Self\.cannotUndoNote\(keeps\),\s*canUndo:\s*false\),\s*undo:\s*\[\]\)$/);
  expect(actual.branches.done.trim()).toMatch(/^if keeps > 0\s*\{\s*showToast\(ListToast\(text:\s*Self\.cannotUndoNote\(keeps\),\s*canUndo:\s*false\),\s*undo:\s*\[\]\)\s*\}\s*else\s*\{\s*hideToast\(\)\s*\}$/);
  expect(actual.branches.failed.trim()).toMatch(/^showToast\(ListToast\(text:\s*Self\.undoFailedText,\s*canUndo:\s*false\),\s*undo:\s*\[\],\s*note:\s*conflicted\s*\?\s*Self\.undoChangedText\s*:\s*nil\)$/);
  expect(actual.branches.unconfirmed.trim()).toMatch(/^showToast\(ListToast\(text:\s*Self\.unconfirmedText,\s*canUndo:\s*false\),\s*undo:\s*\[\],\s*note:\s*conflicted\s*\?\s*Self\.undoChangedText\s*:\s*nil\)$/);
}

/** Break a real branch, then leave a complete good switch only in non-executable source. */
function phantomUndo(model: string, target: UndoBranch, kind: PhantomKind): string {
  const original = nativeUndo(model), branch = original.branches[target];
  const broken = target === "partly" ? branch.replace("conflicted ? Self.undoChangedText : Self.cannotUndoNote(keeps)", "Self.undoChangedText")
    : branch.replace(target === "done" ? "Self.cannotUndoNote(keeps)" : target === "failed" ? "Self.undoFailedText" : "Self.unconfirmedText", "Self.undoChangedText");
  expect(broken).not.toBe(branch);
  const changed = original.text.replace(branch, broken);
  expect(changed).not.toBe(original.text);
  const location = nativeUndo(changed).presentation.end;
  const good = original.calls.slice(original.presentation.start, original.presentation.end);
  const phantom = kind === "line comment" ? good.split("\n").map((line) => "// " + line).join("\n")
    : kind === "block comment" ? "/*\n" + good + "\n*/"
      : kind === "raw string" ? 'let phantom = #"' + good.replace(/\s+/g, " ") + '"#'
        : 'let phantom = """\n' + good + '\n"""';
  return changed.slice(0, location) + "\n" + phantom + "\n" + changed.slice(location);
}

const phantomCases = (["partly", "done", "failed", "unconfirmed"] as const).flatMap((branch) =>
  (["line comment", "block comment", "raw string", "multiline string"] as const).map((kind) => [kind, branch] as const));


const nativeModel = readFileSync(path.resolve(__dirname, "../../../ios/Otodoke/Screens/Parcels/ParcelListModel.swift"), "utf8");
const nativeFormat = readFileSync(path.resolve(__dirname, "../../../src/lib/format.ts"), "utf8");
function actualWebText(name: string): string {
  const file = ts.createSourceFile("format.ts", nativeFormat, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  for (const statement of file.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const entry of statement.declarationList.declarations) {
      if (ts.isIdentifier(entry.name) && entry.name.text === name && entry.initializer && ts.isStringLiteral(entry.initializer)) return entry.initializer.text;
    }
  }
  throw new Error("actual Web 97be text is missing: " + name);
}
function assertActiveNative(model: string) {
  const actual = nativeUndo(model);
  expect(actual.changed).toBe(UNDO_CHANGED_NOTICE);
  expect(actual.cannot).toBe(CANNOT_UNDO_NOTE);
  expect(actual.failed).toBe(actualWebText("UNDO_FAILED_NOTICE"));
  expect(actual.unconfirmed).toBe(actualWebText("UNDO_UNCONFIRMED_NOTICE"));
  assertUndoPresentation(actual);
}

// A dead constant anywhere in the app cannot establish parity with the actual native toast.
describe("iOS parity of active undo notices", () => {
  it("the actual partial and old-keeps paths use the two Web notices without asserting current receipt state", () => {
    assertActiveNative(nativeModel);
  });
  it.each(phantomCases)("rejects a %s phantom after breaking the actual %s branch", (kind, branch) => {
    assertActiveNative(nativeModel);
    const mutated = phantomUndo(nativeModel, branch, kind);
    expect(mutated).not.toBe(nativeModel);
    expect(() => assertActiveNative(mutated)).toThrow();
  });
});
