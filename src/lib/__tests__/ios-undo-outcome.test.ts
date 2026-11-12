import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { z } from "zod";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "../../..");
// Cross-branch validation reads an exact Web export. A missing source is an integration failure.
const WEB_ROOT = process.env.OTODOKE_UNDO_WEB_ROOT ?? ROOT;
const read = (root: string, name: string) => {
  const file = path.join(root, name);
  if (!existsSync(file)) throw new Error(`undo comparison source is missing: ${file}`);
  return readFileSync(file, "utf8");
};
const parse = (source: string) => ts.createSourceFile("source.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

function declaration(source: string, name: string): string {
  const file = parse(source);
  for (const statement of file.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name?.text === name) return statement.getText(file).replace(/^export\s+/, "");
    if (ts.isVariableStatement(statement) && statement.declarationList.declarations.some((entry) => ts.isIdentifier(entry.name) && entry.name.text === name)) {
      return statement.getText(file).replace(/^export\s+/, "");
    }
  }
  throw new Error(`actual Web declaration is missing: ${name}`);
}

function exportedText(source: string, name: string): string {
  const file = parse(source);
  for (const statement of file.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const entry of statement.declarationList.declarations) {
      if (ts.isIdentifier(entry.name) && entry.name.text === name && entry.initializer && ts.isStringLiteral(entry.initializer)) return entry.initializer.text;
    }
  }
  throw new Error(`actual Web text is missing: ${name}`);
}

type RestoreItem = { id: string; status: string; received_at: null; written_at?: string };
type Stored = { id: string; user_id: string; status: string; received_at: string | null };
type Result = { leftReceived: boolean };

/** Execute the actual Web function with local query replies; no Web implementation is copied here. */
function restoreWorld(actions: string, failAt = 0, changed = false) {
  const at = "2026-11-04T03:00:00.000Z";
  const items: RestoreItem[] = [
    { id: "a", status: "shipped", received_at: null, written_at: at },
    { id: "b", status: "ordered", received_at: null, written_at: at },
  ];
  const stored: Stored[] = items.map(({ id }) => ({ id, user_id: "me", status: "delivered", received_at: changed ? "2026-11-04T03:00:02.000Z" : at }));
  const requests: { column: string; value: unknown }[][] = [];
  const supabase = {
    from(table: string) {
      expect(table).toBe("parcels");
      return {
        update(values: { status: string; received_at: string | null }) {
          const predicates: { column: string; value: unknown }[] = [];
          let ids: string[] = [];
          const query = {
            in(column: string, value: string[]) { expect(column).toBe("id"); ids = value; return query; },
            eq(column: string, value: unknown) { predicates.push({ column, value }); return query; },
            async select(columns: string) {
              expect(columns).toBe("id");
              requests.push(predicates);
              if (requests.length === failAt) return { data: null, error: { message: "local refusal" } };
              const matched = stored.filter((row) => ids.includes(row.id) && predicates.every(({ column, value }) => row[column as keyof Stored] === value));
              for (const row of matched) Object.assign(row, values);
              return { data: matched.map(({ id }) => ({ id })), error: null };
            },
          };
          return query;
        },
      };
    },
  };
  const names = ["RESTORABLE", "MAX_AT_ONCE", "PreviousReceivedAt", "WrittenAt", "restoreStatuses"];
  const js = ts.transpileModule(names.map((name) => declaration(actions, name)).join("\n"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  const restore = new Function("z", "signedIn", "revalidatePath", "console", `${js}\nreturn restoreStatuses;`)(
    z, async () => ({ supabase, userId: "me" }), () => {}, { error: () => {} },
  ) as (items: RestoreItem[]) => Promise<Result>;
  return { items, stored, requests, restore };
}

async function assertWebReceiptContract(actions: string) {
  const valid = restoreWorld(actions);
  expect(await valid.restore(valid.items)).toEqual({ leftReceived: false });
  expect(valid.stored.every((row) => row.received_at === null)).toBe(true);
  for (const conditions of valid.requests) expect(conditions).toContainEqual({ column: "received_at", value: valid.items[0].written_at });

  const changed = restoreWorld(actions, 0, true);
  expect(await changed.restore(changed.items)).toEqual({ leftReceived: true });
  expect(changed.stored.every((row) => row.received_at !== null)).toBe(true);

  const invalid = restoreWorld(actions);
  expect(await invalid.restore([{ ...invalid.items[0], written_at: undefined }])).toEqual({ leftReceived: true });
  expect(invalid.requests, "an absent written receipt must be refused before writing").toHaveLength(0);

  const partial = restoreWorld(actions, 2);
  expect(await partial.restore(partial.items)).toEqual({ leftReceived: true });
  expect(partial.stored.filter((row) => row.received_at === null)).toHaveLength(1);

  const failed = restoreWorld(actions, 1);
  await expect(failed.restore(failed.items)).rejects.toThrow("local refusal");
}

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
  expect(controls).toMatch(/outcome === "partly"\)\s*setToast\(\{ text: PARTLY_RESTORED_NOTICE, undo: null \}\)/);
}

describe("iOS undo agrees with the actual Web remaining-receipt contract", () => {
  const actions = read(WEB_ROOT, "src/app/app/parcel-actions.ts");
  const format = read(WEB_ROOT, "src/lib/format.ts");
  const controls = read(WEB_ROOT, "src/app/app/delivered-controls.tsx");
  const outcome = read(WEB_ROOT, "src/lib/undo-outcome.ts");
  const model = read(ROOT, "ios/Otodoke/Screens/Parcels/ParcelListModel.swift");

  it("the Web restores only this receipt, distinguishes partial/error, and requires written_at", async () => {
    await assertWebReceiptContract(actions);
    const js = ts.transpileModule(declaration(outcome, "runUndo"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
    const run = new Function(`${js}\nreturn runUndo;`)() as (restore: () => Promise<Result>) => Promise<string>;
    expect(await run(async () => ({ leftReceived: true }))).toBe("partly");
    expect(await run(async () => ({ leftReceived: false }))).toBe("done");
    expect(await run(async () => { throw new Error("local failure"); })).toBe("failed");
  });

  it("both actual presentation branches show the same notice with no undo action", () => {
    assertNativeMessage(model, format, controls);
  });

  it("negative control: removing written_at validation is detected by an attempted write", async () => {
    const changed = actions.replace(" || !written.success", "");
    expect(changed).not.toBe(actions);
    await expect(assertWebReceiptContract(changed)).rejects.toThrow();
  });

  it("negative control: removing the received_at ownership condition is detected", async () => {
    const changed = actions.replace('.eq("received_at", written_at)', "");
    expect(changed).not.toBe(actions);
    await expect(assertWebReceiptContract(changed)).rejects.toThrow();
  });

  it("negative control: changing the Web's actual notice is detected", () => {
    const notice = exportedText(format, "PARTLY_RESTORED_NOTICE");
    const changed = format.replace(JSON.stringify(notice), '"changed remaining notice"');
    expect(changed).not.toBe(format);
    expect(() => assertNativeMessage(model, changed, controls)).toThrow();
  });

  it("negative control: changing the Web's actual cannot-undo note is detected", () => {
    const note = exportedText(format, "CANNOT_UNDO_NOTE");
    const changed = format.replace(JSON.stringify(note), '"changed cannot-undo note"');
    expect(changed).not.toBe(format);
    expect(() => assertNativeMessage(model, changed, controls)).toThrow();
  });

  it("negative control: routing the native partial branch to another result is detected", () => {
    const changed = model.replace("case .partly:", "case .failed:");
    expect(changed).not.toBe(model);
    expect(() => assertNativeMessage(changed, format, controls)).toThrow();
  });
});
