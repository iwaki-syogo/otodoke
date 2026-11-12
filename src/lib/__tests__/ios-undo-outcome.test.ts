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

// The native legacy contract stays distinct from the new Web result presentation.
function assertNativeMessage(model: string, format: string, controls: string) {
  const note = exportedText(format, "CANNOT_UNDO_NOTE");
  const nativeNote = model.match(/static func cannotUndoNote\([^)]*\)\s*->\s*String\s*\{\s*("(?:[^"\\]|\\.)*")\s*\}/);
  expect(nativeNote, "read the native note actually used by deliverAll").toBeTruthy();
  expect(JSON.parse(nativeNote![1])).toBe(note);
  const deliverAll = model.slice(model.indexOf("func deliverAll() async {"), model.indexOf("func dismissCheck("));
  expect(deliverAll).toMatch(/note:\s*canUndo && confirmed > 0 \? Self\.cannotUndoNote\(confirmed\) : nil/);
  expect(controls).toMatch(/note:\s*undo\.length > 0 && undo\.length < done\.saved \? CANNOT_UNDO_NOTE : null/);
  const notice = exportedText(format, "PARTLY_RESTORED_NOTICE");
  const nativeNotice = model.match(/static func undoneButKeptText\([^)]*\)\s*->\s*String\s*\{\s*("(?:[^"\\]|\\.)*")\s*\}/);
  expect(nativeNotice, "read the native notice actually used by undo").toBeTruthy();
  expect(JSON.parse(nativeNotice![1])).toBe(notice);
  const undo = model.slice(model.indexOf("func undo() async {"), model.indexOf("func clearForSignOut()"));
  const presentation = undo.slice(undo.lastIndexOf("switch outcome {"));
  const partly = presentation.match(/case \.partly:\s*([\s\S]*?)(?=\n        case |\n        \})/);
  expect(partly, "known remaining receipts have their own result branch").toBeTruthy();
  expect(partly![1]).toContain("Self.undoneButKeptText(");
  expect(partly![1]).toContain("canUndo: false");
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

describe("native legacy copy and the actual Web receipt boundary", () => {
  it("actual actions and helper use opaque RPC keys and preserve restored, changed and failed facts", async () => {
    const valid = await world();
    expect(await runUndo(restoreStatuses, valid.receipts)).toEqual({ restored: [id(1), id(2)], changed: [], failed: [] });
    expect(undoCalls(valid.db).map((call) => call.args)).toEqual([{ p_receipts: keys(valid.receipts) }]);
    expect(valid.db.rows("parcels").every((row) => row.status === "shipped" && row.received_at === null)).toBe(true);

    const changed = await world();
    await changed.db.from("parcels").update({ category: "hobby" }).eq("id", id(2));
    expect(await runUndo(restoreStatuses, changed.receipts)).toEqual({ restored: [id(1)], changed: [id(2)], failed: [] });
    expect(changed.db.find("parcels", id(2))!.received_at).not.toBeNull();

    const failed = await world();
    failed.db.rpc = async () => ({ data: null, error: { message: "local RPC refusal" } });
    expect(await runUndo(restoreStatuses, failed.receipts)).toEqual({ restored: [], changed: [], failed: [id(1), id(2)] });
  });

  it("keeps the native partial branch, shared copy and cannot-undo action contract", () => {
    assertNativeMessage(model, format, controls);
    expect(PARTLY_RESTORED_NOTICE).not.toBe(UNDO_CHANGED_NOTICE);
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

  it.each(["changed", "failed", "mixed", "restored"] as const)("the actual Web toast presents %s after the real action and helper finish", async (kind) => {
    const { db, receipts } = await world(3);
    if (kind === "changed") await db.from("parcels").update({ category: "hobby" }).eq("id", id(2));
    if (kind === "failed") state.userId = null;
    if (kind === "mixed") db.rpc = async () => ({ data: [{ id: id(1), outcome: "restored" }, { id: id(2), outcome: "changed" }], error: null });
    const view = mount(() => DeliveredToastProvider({ children: null }));
    state.publish({ text: "受け取り済みにしました", undo: receipts });
    await vi.waitFor(() => expect(view.text()).toContain("元に戻す"));
    press(button(view, "元に戻す"));
    if (kind === "restored") await vi.waitFor(() => expect(view.hosts((node) => node.props.role === "status")).toHaveLength(0));
    else {
      await vi.waitFor(() => expect(view.text()).toContain(kind === "changed" ? UNDO_CHANGED_NOTICE : UNDO_FAILED_NOTICE));
      if (kind === "mixed") expect(view.text()).toContain(UNDO_CHANGED_NOTICE);
      expect(view.text()).not.toContain(PARTLY_RESTORED_NOTICE);
      expect(view.hosts((node) => node.type === "button")).toHaveLength(0);
    }
    if (kind !== "failed" && kind !== "mixed") expect(undoCalls(db)[0].args).toEqual({ p_receipts: keys(receipts) });
    view.unmount();
  });

  it("negative control: changing the Web's legacy partial notice breaks the native comparison", () => {
    const notice = exportedText(format, "PARTLY_RESTORED_NOTICE");
    const changed = format.replace(JSON.stringify(notice), '"changed remaining notice"');
    expect(changed).not.toBe(format);
    expect(() => assertNativeMessage(model, changed, controls)).toThrow();
  });

  it("negative control: changing the shared cannot-undo note breaks the native comparison", () => {
    const note = exportedText(format, "CANNOT_UNDO_NOTE");
    const changed = format.replace(JSON.stringify(note), '"changed cannot-undo note"');
    expect(changed).not.toBe(format);
    expect(() => assertNativeMessage(model, changed, controls)).toThrow();
  });

  it("negative control: changing the native actual notice is detected without editing Swift", () => {
    const notice = exportedText(format, "PARTLY_RESTORED_NOTICE");
    const changed = model.replace(JSON.stringify(notice), '"changed native notice"');
    expect(changed).not.toBe(model);
    expect(() => assertNativeMessage(changed, format, controls)).toThrow();
  });

  it("negative control: routing the native partial branch to another result is detected", () => {
    const changed = model.replace("case .partly:", "case .failed:");
    expect(changed).not.toBe(model);
    expect(() => assertNativeMessage(changed, format, controls)).toThrow();
  });
});
