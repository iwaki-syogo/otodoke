import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CANNOT_UNDO_NOTE, PARTLY_RESTORED_NOTICE, UNDO_CHANGED_NOTICE, UNDO_FAILED_NOTICE } from "@/lib/format";
import { markReceivedInChunks } from "@/lib/receipt-client";
import { runUndo } from "@/lib/undo-outcome";
import type { ReceiptKey, ReceivedReceipt } from "@/lib/receipt";
import { FakeDb } from "./fake-db";
import { fakeEvent, hostText, type Host } from "./element-tree";
import { mount, type Mounted } from "./hook-harness";

const ROOT = path.resolve(__dirname, "../../..");
const USER = "00000000-0000-4000-8000-00000000000a";
const state = vi.hoisted(() => ({ db: null as unknown, userId: "00000000-0000-4000-8000-00000000000a" as string | null,
  publish: (value: unknown) => { void value; } }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => {
  const db = state.db as FakeDb;
  const auth = { getUser: async () => ({ data: { user: state.userId ? { id: state.userId } : null }, error: null }) };
  Object.assign(db, { auth });
  return { auth, rpc: db.rpc.bind(db), from: () => { throw new Error("receipt actions must use the RPC boundary"); } };
} }));
vi.mock("react", async (original) => {
  const actual = await original<typeof import("react")>();
  const { harnessHooks } = await import("./hook-harness");
  return { ...harnessHooks(actual), useTransition: () => [false, (work: () => unknown) => void work()],
    createContext: (initial: unknown) => {
      const context = actual.createContext(initial);
      Object.defineProperty(context, "Provider", { value: ({ value, children }: { value: typeof state.publish; children: unknown }) => {
        state.publish = value;
        return children;
      } });
      return context;
    },
  };
});
const { markDeliveredForUndo, restoreStatuses } = await import("@/app/app/parcel-actions");
const { DeliveredToastProvider } = await import("@/app/app/delivered-controls");
const read = (name: string) => readFileSync(path.join(ROOT, name), "utf8");
const format = read("src/lib/format.ts");
const controls = read("src/app/app/delivered-controls.tsx");
const model = read("ios/Otodoke/Screens/Parcels/ParcelListModel.swift");
const id = (n: number) => "00000000-0000-4000-8000-" + n.toString(16).padStart(12, "0");
const keys = (receipts: ReceivedReceipt[]): ReceiptKey[] => receipts.map(({ id, receipt_id }) => ({ id, receipt_id }));
const button = (view: Mounted, text: string) => view.host((node) => node.type === "button" && hostText(node).trim() === text);
const press = (node: Host) => (node.props.onClick as (event: unknown) => void)(fakeEvent());

function exportedText(source: string, name: string): string {
  const file = ts.createSourceFile("source.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  for (const statement of file.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const entry of statement.declarationList.declarations) {
      if (ts.isIdentifier(entry.name) && entry.name.text === name && entry.initializer && ts.isStringLiteral(entry.initializer)) return entry.initializer.text;
    }
  }
  throw new Error(`actual Web text is missing: ${name}`);
}

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


// Check the active native display paths, not an unused legacy sentence left in Swift.
function assertNativeMessage(model: string, format: string, controls: string) {
  const actual = nativeUndo(model);
  const note = exportedText(format, "CANNOT_UNDO_NOTE");
  expect(actual.cannot).toBe(note);
  expect(actual.deliver).toMatch(/note:\s*canUndo && confirmed > 0 \? Self\.cannotUndoNote\(confirmed\) : nil/);
  expect(controls).toMatch(/note:\s*undo\.length > 0 && undo\.length < done\.saved \? CANNOT_UNDO_NOTE : null/);
  expect(actual.changed).toBe(exportedText(format, "UNDO_CHANGED_NOTICE"));
  expect(actual.failed).toBe(exportedText(format, "UNDO_FAILED_NOTICE"));
  // This is deliberately read in a test: an old Web tree reports its missing 97be contract, not an import/type failure.
  expect(actual.unconfirmed).toBe(exportedText(format, "UNDO_UNCONFIRMED_NOTICE"));
  assertUndoPresentation(actual);
}

async function world(size = 2) {
  const rows = Array.from({ length: size }, (_, n) => ({ id: id(n + 1), user_id: USER, status: "shipped", received_at: null,
    updated_at: "2026-11-01T00:00:00.000Z", created_at: "2026-11-01T00:00:00.000Z" }));
  const db = new FakeDb({ parcels: rows });
  state.db = db;
  const marked = await markReceivedInChunks(rows.map((row) => row.id), markDeliveredForUndo);
  expect(marked.written).toHaveLength(size);
  return { db, receipts: marked.written };
}
const undoCalls = (db: FakeDb) => db.rpcCalls.filter((call) => call.name === "restore_parcel_receipts");

beforeEach(() => {
  state.userId = USER;
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.stubGlobal("fetch", () => { throw new Error("external fetch is forbidden in undo contract tests"); });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("native neutral undo copy and the actual Web receipt boundary", () => {
  it("actual actions and helper use opaque RPC keys and distinguish refusal from unconfirmed replies", async () => {
    const valid = await world();
    expect(await runUndo(restoreStatuses, valid.receipts)).toEqual({ restored: [id(1), id(2)], changed: [], failed: [] });
    expect(undoCalls(valid.db).map((call) => call.args)).toEqual([{ p_receipts: keys(valid.receipts) }]);
    expect(valid.db.rows("parcels").every((row) => row.status === "shipped" && row.received_at === null)).toBe(true);

    const changed = await world();
    await changed.db.from("parcels").update({ category: "hobby" }).eq("id", id(2));
    expect(await runUndo(restoreStatuses, changed.receipts)).toEqual({ restored: [id(1)], changed: [id(2)], failed: [] });
    expect(changed.db.find("parcels", id(2))!.received_at).not.toBeNull();

    const unconfirmed = await world();
    unconfirmed.db.rpc = async () => ({ data: null, error: { message: "local RPC error" } });
    expect(await runUndo(restoreStatuses, unconfirmed.receipts)).toEqual({ restored: [], changed: [], failed: [], unconfirmed: [id(1), id(2)] });
  });

  it("binds both active native notices to the actual Web constants and preserves uncertain outcomes", () => {
    assertNativeMessage(model, format, controls);
    expect(UNDO_CHANGED_NOTICE).toBe("ほかで変更された荷物があります");
    expect(CANNOT_UNDO_NOTE).toBe("元に戻せない荷物があります");
  });

  it("negative control: a legacy payload without a receipt token cannot reach the undo RPC", async () => {
    const { db, receipts } = await world(1);
    const legacy = { id: receipts[0].id, status: "shipped", received_at: null, written_at: receipts[0].received_at };
    expect(await restoreStatuses([legacy as unknown as ReceiptKey])).toEqual({ restored: [], changed: [], failed: [id(1)] });
    expect(undoCalls(db)).toHaveLength(0);
    expect(db.find("parcels", id(1))!.received_at).not.toBeNull();
  });

  it("negative control: a different opaque receipt token cannot grant another operation's undo", async () => {
    const { db, receipts } = await world(1);
    const before = structuredClone(db.find("parcels", id(1)));
    const forged = { id: id(1), receipt_id: id(9999) };
    expect(await runUndo(restoreStatuses, [forged])).toEqual({ restored: [], changed: [id(1)], failed: [] });
    expect(db.find("parcels", id(1))).toEqual(before);
    expect(undoCalls(db)[0].args).toEqual({ p_receipts: [forged] });
    expect(forged.receipt_id).not.toBe(receipts[0].receipt_id);
  });

  it.each(["changed", "failed", "mixed", "restored", "unconfirmed", "mixed-refusal"] as const)("the actual Web toast presents %s after the real action and helper finish", async (kind) => {
    const { db, receipts } = await world(3);
    if (kind === "changed") await db.from("parcels").update({ category: "hobby" }).eq("id", id(2));
    if (kind === "failed") state.userId = null;
    if (kind === "mixed") db.rpc = async () => ({ data: [{ id: id(1), outcome: "restored" }, { id: id(2), outcome: "changed" }], error: null });
    if (kind === "unconfirmed") db.rpc = async () => ({ data: null, error: { message: "synthetic missing reply" } });
    if (kind === "mixed-refusal") db.rpc = async () => ({ data: [{ id: id(1), outcome: "restored" }, { id: id(2), outcome: "changed" }, { id: id(3), outcome: "failed" }], error: null });
    const view = mount(() => DeliveredToastProvider({ children: null }));
    state.publish({ text: "受け取り済みにしました", undo: receipts });
    await vi.waitFor(() => expect(view.text()).toContain("元に戻す"));
    press(button(view, "元に戻す"));
    if (kind === "restored") await vi.waitFor(() => expect(view.hosts((node) => node.props.role === "status")).toHaveLength(0));
    else {
      await vi.waitFor(() => expect(view.hosts((node) => node.type === "button")).toHaveLength(0));
      const unknown = kind === "mixed" || kind === "unconfirmed";
      expect(view.text()).toContain(unknown ? exportedText(format, "UNDO_UNCONFIRMED_NOTICE") : kind === "changed" ? UNDO_CHANGED_NOTICE : UNDO_FAILED_NOTICE);
      if (unknown) expect(view.text()).not.toContain(UNDO_FAILED_NOTICE);
      if (kind === "mixed" || kind === "mixed-refusal") expect(view.text()).toContain(UNDO_CHANGED_NOTICE);
      expect(view.text()).not.toContain(PARTLY_RESTORED_NOTICE);
      expect(view.hosts((node) => node.type === "button")).toHaveLength(0);
    }
    if (kind === "changed" || kind === "restored") expect(undoCalls(db)[0].args).toEqual({ p_receipts: keys(receipts) });
    view.unmount();
  });

  it.each(["error", "throw"] as const)("a committed undo with a lost RPC reply (%s) leaves the real Web toast unconfirmed", async (failure) => {
    const { db, receipts } = await world(1);
    const rpc = db.rpc.bind(db);
    db.rpc = async (name, args) => {
      const reply = await rpc(name, args);
      if (name !== "restore_parcel_receipts") return reply;
      if (failure === "throw") throw new Error("synthetic lost reply");
      return { data: null, error: { message: "synthetic lost reply" } };
    };
    const view = mount(() => DeliveredToastProvider({ children: null }));
    state.publish({ text: "受け取り済みにしました", undo: receipts });
    await vi.waitFor(() => expect(view.text()).toContain("元に戻す"));
    press(button(view, "元に戻す"));
    await vi.waitFor(() => expect(view.hosts((node) => node.type === "button")).toHaveLength(0));
    expect(db.find("parcels", id(1))).toMatchObject({ status: "shipped", received_at: null });
    expect(view.text()).not.toContain(UNDO_FAILED_NOTICE);
    expect(view.text()).toContain(exportedText(format, "UNDO_UNCONFIRMED_NOTICE"));
    expect(undoCalls(db)).toHaveLength(1);
    view.unmount();
  });

  it.each(["UNDO_CHANGED_NOTICE", "CANNOT_UNDO_NOTE", "UNDO_FAILED_NOTICE", "UNDO_UNCONFIRMED_NOTICE"])("negative control: changing the active Web %s breaks the native comparison", (name) => {
    assertNativeMessage(model, format, controls);
    const notice = exportedText(format, name);
    const changed = format.replace("export const " + name + " = " + JSON.stringify(notice) + ";", "export const " + name + ' = "changed Web notice";');
    expect(changed).not.toBe(format);
    expect(() => assertNativeMessage(model, changed, controls)).toThrow();
  });

  it("positive control: the unused Web legacy sentence is no longer the native copy contract", () => {
    assertNativeMessage(model, format, controls);
    const legacy = exportedText(format, "PARTLY_RESTORED_NOTICE");
    const changed = format.replace(JSON.stringify(legacy), '"changed unused legacy notice"');
    expect(changed).not.toBe(format);
    assertNativeMessage(model, changed, controls);
  });

  it.each(["UNDO_CHANGED_NOTICE", "CANNOT_UNDO_NOTE", "UNDO_FAILED_NOTICE", "UNDO_UNCONFIRMED_NOTICE"])("negative control: changing the active native %s is detected without editing Swift", (name) => {
    assertNativeMessage(model, format, controls);
    const notice = exportedText(format, name);
    const changed = model.replace(JSON.stringify(notice), '"changed native notice"');
    expect(changed).not.toBe(model);
    expect(() => assertNativeMessage(changed, format, controls)).toThrow();
  });

  it("negative control: routing the native partial branch to another result is detected", () => {
    assertNativeMessage(model, format, controls);
    const changed = model.replace("case .partly:", "case .failed:");
    expect(changed).not.toBe(model);
    expect(() => assertNativeMessage(changed, format, controls)).toThrow();
  });

  it("negative control: correct constants cannot hide an unconditional changed notice", () => {
    assertNativeMessage(model, format, controls);
    const changed = model.replace("conflicted ? Self.undoChangedText : Self.cannotUndoNote(keeps)", "Self.undoChangedText");
    expect(changed).not.toBe(model);
    expect(() => assertNativeMessage(changed, format, controls)).toThrow();
  });

  it("negative control: old keeps cannot be routed to a changed or received-state assertion", () => {
    assertNativeMessage(model, format, controls);
    const changed = model.replace("text: Self.cannotUndoNote(keeps)", "text: Self.undoChangedText");
    expect(changed).not.toBe(model);
    expect(() => assertNativeMessage(changed, format, controls)).toThrow();
  });

  it("negative control: an unknown result whose read failed cannot become a changed notice", () => {
    assertNativeMessage(model, format, controls);
    const changed = model.replace("case .unconfirmed: showToast(ListToast(text: Self.unconfirmedText,", "case .unconfirmed: showToast(ListToast(text: Self.undoChangedText,");
    expect(changed).not.toBe(model);
    expect(() => assertNativeMessage(changed, format, controls)).toThrow();
  });

  it.each(phantomCases)("rejects a %s phantom after breaking the actual %s branch", (kind, branch) => {
    assertNativeMessage(model, format, controls);
    const mutated = phantomUndo(model, branch, kind);
    expect(mutated).not.toBe(model);
    expect(() => assertNativeMessage(mutated, format, controls)).toThrow();
  });
});
