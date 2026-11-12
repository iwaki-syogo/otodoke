import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "../../..");
const read = (file: string) => readFileSync(path.join(ROOT, file), "utf8");
const sources = {
  reader: read("ios/Otodoke/Data/ParcelReader.swift"),
  models: read("ios/Otodoke/Data/Models.swift"),
  mail: read("ios/Otodoke/Logic/MailBody.swift"),
  detail: read("ios/Otodoke/Screens/Detail/ParcelDetailView.swift"),
  notices: read("src/lib/mail-notices.ts"),
  web: read("src/app/app/parcels/[id]/page.tsx"),
};
type Sources = typeof sources;

/** Keep declarations readable, but never count comments or string-literal code as a display call. */
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
        stringEnd = opening[2] + hashes; stringEscape = `\\${hashes}`;
        code += literal(opening[0]); at += opening[0].length;
      } else code += source[at++];
    }
  }
  if (blockDepth > 0 || stringEnd !== null) throw new Error("unterminated Swift source");
  return code;
}

function parsed(source: string, kind = ts.ScriptKind.TSX) {
  return ts.createSourceFile("actual-source.tsx", source, ts.ScriptTarget.Latest, true, kind);
}
function descendants(node: ts.Node): ts.Node[] {
  const result: ts.Node[] = [];
  node.forEachChild((child) => { result.push(child, ...descendants(child)); });
  return result;
}
function comparison(node: ts.Expression, property: string): string | undefined {
  if (!ts.isBinaryExpression(node) || node.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken) return;
  if (ts.isPropertyAccessExpression(node.left) && node.left.expression.getText() === "email"
    && node.left.name.text === property && ts.isStringLiteral(node.right)) return node.right.text;
}
function webContract(input: Sources) {
  const declarations = descendants(parsed(input.notices)).filter(ts.isVariableDeclaration)
    .filter((node) => ts.isIdentifier(node.name) && node.name.text === "CONSENT_WAIT_EXPIRED_NOTICE");
  expect(declarations).toHaveLength(1);
  const initializer = declarations[0].initializer;
  if (!initializer || !ts.isStringLiteral(initializer)) throw new Error("missing actual Web expiry sentence");
  const dropped = descendants(parsed(input.web)).filter(ts.isConditionalExpression)
    .filter((node) => comparison(node.condition, "body_state") === "dropped");
  expect(dropped).toHaveLength(1);
  const reasons = descendants(dropped[0].whenTrue).filter(ts.isConditionalExpression)
    .filter((node) => comparison(node.condition, "error") !== undefined);
  expect(reasons).toHaveLength(1);
  const reason = comparison(reasons[0].condition, "error")!;
  expect(ts.isIdentifier(reasons[0].whenTrue) && reasons[0].whenTrue.text).toBe("CONSENT_WAIT_EXPIRED_NOTICE");
  if (!ts.isStringLiteral(reasons[0].whenFalse)) throw new Error("missing actual Web neutral sentence");
  return { reason, expired: initializer.text, neutral: reasons[0].whenFalse.text };
}

/** Embedded column tokens, not a substring satisfied by a comment or an error in another SELECT. */
function assertProjection(input: Sources): void {
  const code = swiftCode(input.reader);
  const select = code.match(/static let extractionColumns\s*=\s*"([^"\n]+)"/)?.[1];
  expect(select).toBeTruthy();
  const mailColumns = select?.match(/\bemails\(([^)]+)\)/)?.[1].split(",").map((column) => column.trim());
  expect(mailColumns?.filter((column) => column === "error")).toEqual(["error"]);
  expect(mailColumns).toContain("body_state");
  expect(mailColumns).not.toContain("body_envelope");
  expect(swiftCode(input.reader, false)).toMatch(/from\(\s*\)\.select\(Self\.extractionColumns\)/);
  const webSelect = descendants(parsed(input.web)).filter(ts.isCallExpression)
    .filter((node) => ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "select")
    .flatMap((node) => node.arguments.filter(ts.isStringLiteral).map((argument) => argument.text));
  const webMailColumns = webSelect.find((select) => /\bemails\(/.test(select))?.match(/\bemails\(([^)]+)\)/)?.[1]
    .split(",").map((column) => column.trim());
  expect(webMailColumns).toEqual(mailColumns);
}

function assertDisplay(input: Sources): void {
  const web = webContract(input), code = swiftCode(input.mail), calls = swiftCode(input.mail, false);
  const constants = new Map([...code.matchAll(/static let (\w+)\s*=\s*"([^"\\]*)"/g)].map((match) => [match[1], match[2]]));
  expect(constants.get("droppedDetail")).toBe(web.neutral);
  const start = calls.indexOf("case .dropped:"), end = calls.indexOf("case .unknown:", start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  const branch = code.slice(start, end);
  const selected = branch.match(/detail:\s*(?:email\.error\s*==\s*"([^"]+)"|JSText\.equal\(email\.error\s*\?\?\s*"",\s*"([^"]+)"\))\s*\?\s*(\w+)\s*:\s*(\w+)/);
  expect(selected, "the dropped return selects the actual two constants").toBeTruthy();
  const activeBranch = calls.slice(start, end), selectionAt = selected?.index ?? -1;
  // The same source span must be executable Swift, in the returned MailDisplay's detail argument.
  // A raw/multiline string containing a ternary is not a rendered choice.
  expect(activeBranch.slice(selectionAt, selectionAt + selected![0].length)).toBe(swiftCode(selected![0], false));
  expect(activeBranch.slice(0, selectionAt)).toMatch(/^case \.dropped:\s*return MailDisplay\([^;{}]*,\s*$/);
  expect(activeBranch.slice(selectionAt + selected![0].length)).toMatch(/^\s*\)\s*$/);
  expect(selected?.[1] ?? selected?.[2]).toBe(web.reason);
  expect(constants.get(selected?.[3] ?? "")).toBe(web.expired);
  expect(constants.get(selected?.[4] ?? "")).toBe(web.neutral);
  expect(calls.match(/email\.error\b/g)).toHaveLength(1);
  const model = swiftCode(input.models).match(/struct EmailSummary\b[\s\S]*?\n\}/)?.[0] ?? "";
  expect(model).toMatch(/var error:\s*String\?\s*(?:= nil)?/);
  expect(model).toMatch(/case error\b/);
  expect(swiftCode(input.detail, false)).toMatch(/case \.dropped:\s*Text\(entry\.mail\?\.detail\s*\?\?\s*MailBody\.droppedDetail\)/);
  expect(code + swiftCode(input.detail)).not.toContain("パスワードでログインする前に届いたメールです。");
}

function changed(input: Sources, key: keyof Sources, mutate: (source: string) => string): Sources {
  const next = mutate(input[key]);
  expect(next, "negative control must change the actual source").not.toBe(input[key]);
  return { ...input, [key]: next };
}

describe("A24: iOS dropped-mail reasons follow the actual Web branch", () => {
  it("requests the persisted reason in the real embedded SELECT", () => assertProjection(sources));
  it("uses the actual Web expiry and neutral sentences only in the dropped display and fallback", () => assertDisplay(sources));

  it("rejects removing error from the actual SELECT even though the fake would return the seeded reason", () => {
    assertProjection(sources);
    const mutated = changed(sources, "reader", (source) => source.replace(/(static let extractionColumns\s*=\s*"[^"\n]*\bemails\([^"\n]*?),\s*error(?=\s*[,\)])/, "$1"));
    expect(() => assertProjection(mutated)).toThrow();
  });

  it.each(["expired", "neutral"] as const)("rejects a one-character change in the actual native %s sentence", (kind) => {
    assertDisplay(sources);
    const web = webContract(sources), sentence = kind === "expired" ? web.expired : web.neutral;
    const declaration = [...swiftCode(sources.mail).matchAll(/static let (\w+)\s*=\s*"([^"\\]*)"/g)]
      .find((match) => kind === "neutral" ? match[1] === "droppedDetail" : match[2] === sentence);
    expect(declaration).toBeTruthy();
    const mutated = changed(sources, "mail", (source) => source.replace(declaration![0], declaration![0].replace(`"${sentence}"`, `"${sentence}改"`)));
    expect(() => assertDisplay(mutated)).toThrow();
  });

  it("rejects a one-character change in the actual Web constant rather than comparing two test copies", () => {
    assertDisplay(sources);
    const mutated = changed(sources, "notices", (source) => source.replace(/(CONSENT_WAIT_EXPIRED_NOTICE = ")([^"]+)/, "$1$2改"));
    expect(() => assertDisplay(mutated)).toThrow();
  });

  it.each(["line comment", "block comment", "raw string", "multiline string"] as const)("rejects a %s pretending to select the expiry sentence", (kind) => {
    assertDisplay(sources);
    const realBranch = sources.mail.match(/case \.dropped:\s*(return MailDisplay\([^\n]+\))/);
    expect(realBranch).toBeTruthy();
    const statement = realBranch![1];
    const neutralReturn = statement.replace(/detail: JSText\.equal\(email\.error \?\? "", "[^"]+"\) \? \w+ : \w+/, "detail: droppedDetail");
    expect(neutralReturn).not.toBe(statement);
    const phantom = kind === "line comment" ? `// ${statement}`
      : kind === "block comment" ? `/* ${statement} */`
        : kind === "raw string" ? `let phantom = #"${statement}"#`
          : `let phantom = """\n${statement}\n"""`;
    // Keep a real error read, so counting that identifier alone cannot reject the fake binding.
    const mutated = changed(sources, "mail", (source) => source.replace(realBranch![0], `case .dropped:\n            let _ = email.error\n            ${phantom}\n            ${neutralReturn}`));
    expect(() => assertDisplay(mutated)).toThrow();
  });
});
