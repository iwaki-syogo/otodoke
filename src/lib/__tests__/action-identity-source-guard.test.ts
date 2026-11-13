import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

type Policy = { kind: "guard" | "rows" | "owner-rpc" | "public" | "identity-read"; reason: string };
const guard: Policy = { kind: "guard", reason: "The displayed identity must match the verified current user before acting." };
const rows: Policy = { kind: "rows", reason: "An immutable row id and the current owner condition cannot retarget an A row to a B row." };
const ownerRpc: Policy = { kind: "owner-rpc", reason: "A SECURITY DEFINER RPC takes the owner from auth.uid() and filters every parcel and journal row by it; the action only forwards immutable ids through the signed-in client." };
const publicAuth: Policy = { kind: "public", reason: "An explicit public authentication request names its own input address, not the cookie owner." };
const policies: Record<string, Policy> = {
  "app/category-actions.ts#setCategory": rows,
  "app/parcel-actions.ts#markDelivered": ownerRpc,
  "app/parcel-actions.ts#markDeliveredForUndo": ownerRpc,
  "app/parcel-actions.ts#restoreStatuses": ownerRpc,
  "app/parcel-actions.ts#markNotDelivered": rows,
  "app/parcel-actions.ts#markNotReceived": rows,
  "app/parcel-actions.ts#dismissCheck": rows,
  "app/parcels/manual-actions.ts#createManualParcel": guard,
  "app/parcels/manual-actions.ts#updateManualParcel": rows,
  "app/parcels/manual-actions.ts#deleteManualParcel": rows,
  "app/reading/actions.ts#setAiReadingDecision": guard,
  "app/settings/account-actions.ts#deleteAccount": guard,
  "app/settings/actions.ts#loadDemo": guard,
  "app/settings/actions.ts#readWaitingMail": guard,
  "app/settings/actions.ts#markWronglyDropped": guard,
  "app/settings/actions.ts#forgetSender": guard,
  "app/settings/actions.ts#clearAllParcels": guard,
  "app/settings/actions.ts#dismissIntakeNotice": guard,
  "app/settings/key-actions.ts#registerMailKey": guard,
  "app/settings/key-actions.ts#activateMailKey": guard,
  "app/settings/key-actions.ts#rewrapMailKey": guard,
  "app/settings/key-actions.ts#readMailKey": guard,
  "app/settings/key-actions.ts#readRetiredMailKeys": guard,
  "app/settings/key-actions.ts#readSealedMail": guard,
  "app/settings/password-actions.ts#changeLoginSecret": guard,
  "app/settings/password-actions.ts#signInForKey": guard,
  "login/actions.ts#signInWithAuthSecret": publicAuth,
  "login/actions.ts#signUpWithAuthSecret": publicAuth,
  "login/actions.ts#resendConfirmation": publicAuth,
  "login/actions.ts#sendResetMail": publicAuth,
  "login/session-actions.ts#readSignedInAddress": guard,
  "reset-password/actions.ts#finishReset": guard,
};

const app = path.resolve(__dirname, "../../app");
function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? sourceFiles(file) : /\.[cm]?[jt]sx?$/.test(entry.name) ? [file] : [];
  });
}
const realSources = () => new Map(sourceFiles(app).map((file) => [path.relative(app, file), readFileSync(file, "utf8")]));
const parse = (name: string, source: string) => ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true, name.endsWith("tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
const compact = (node: ts.Node) => node.getText().replace(/\s+/g, "");
const hasModifier = (node: ts.Node, kind: ts.SyntaxKind) => ts.canHaveModifiers(node) && ts.getModifiers(node)?.some((m) => m.kind === kind);
const directive = (node: ts.Node): boolean => ts.isExpressionStatement(node) && ts.isStringLiteral(node.expression) && node.expression.text === "use server";

function nodes<T extends ts.Node>(root: ts.Node, predicate: (node: ts.Node) => node is T): T[] {
  const found: T[] = [];
  function visit(node: ts.Node) { if (predicate(node)) found.push(node); ts.forEachChild(node, visit); }
  visit(root);
  return found;
}
const callName = (call: ts.CallExpression) => ts.isIdentifier(call.expression) ? call.expression.text : ts.isPropertyAccessExpression(call.expression) ? call.expression.name.text : "";
const namedFunction = (file: ts.SourceFile, name: string) => file.statements.find((n): n is ts.FunctionDeclaration => ts.isFunctionDeclaration(n) && n.name?.text === name);

/** Row ownership alone is not an exemption for a privileged client or a helper that takes one. */
function usesAdminData(file: ts.SourceFile, fn: ts.FunctionDeclaration, seen = new Set<string>()): boolean {
  const identity = `${file.fileName}#${fn.name?.text}`;
  if (seen.has(identity)) return false;
  seen.add(identity);
  const bindings = new Map<string, { module: string; imported: string }>();
  const adminTypes = new Set<string>();
  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || !statement.importClause) continue;
    const modulePath = statement.moduleSpecifier.text;
    const clause = statement.importClause;
    if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const binding of clause.namedBindings.elements) {
        const imported = binding.propertyName?.text ?? binding.name.text;
        if (modulePath === "@/lib/supabase/admin" && imported === "AdminClient") adminTypes.add(binding.name.text);
        if (!clause.isTypeOnly && !binding.isTypeOnly) bindings.set(binding.name.text, { module: modulePath, imported });
      }
    } else if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings) && !clause.isTypeOnly) {
      bindings.set(clause.namedBindings.name.text, { module: modulePath, imported: "*" });
    }
    if (clause.name && !clause.isTypeOnly) bindings.set(clause.name.text, { module: modulePath, imported: "default" });
  }
  if (fn.parameters.some((parameter) => parameter.type && nodes(parameter.type, ts.isTypeReferenceNode).some((type) => ts.isIdentifier(type.typeName) && adminTypes.has(type.typeName.text)))) return true;

  for (const call of nodes(fn, ts.isCallExpression)) {
    const callee = call.expression;
    const local = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) ? callee.expression.text : null;
    if (!local) continue;
    const binding = bindings.get(local);
    if (!binding) {
      const helper = ts.isIdentifier(callee) ? namedFunction(file, local) : undefined;
      if (helper && usesAdminData(file, helper, seen)) return true;
      continue;
    }
    if (binding.module === "@/lib/supabase/admin") return true;
    // Follow only local TypeScript modules; never packages, runtime values, or environment files.
    const base = binding.module.startsWith("@/") ? path.resolve(app, "..", binding.module.slice(2))
      : binding.module.startsWith(".") ? path.resolve(app, path.dirname(file.fileName), binding.module) : null;
    if (!base || !base.startsWith(path.resolve(app, "..") + path.sep) || /(?:^|[/\\])(?:env|config|fixtures)(?:[/\\.]|$)/.test(base) || /\.config$/.test(base)) continue;
    const helperFile = [base + ".ts", path.join(base, "index.ts")].find(existsSync);
    if (!helperFile) continue;
    const parsed = parse(helperFile, readFileSync(helperFile, "utf8"));
    const exported = binding.imported === "*" && ts.isPropertyAccessExpression(callee) ? callee.name.text : binding.imported;
    const helper = namedFunction(parsed, exported);
    if (helper && usesAdminData(parsed, helper, seen)) return true;
  }
  return false;
}

/** Every mutation chain must retain both the immutable row id and the server's current owner. */
function rowScopeErrors(fn: ts.FunctionDeclaration): string[] {
  const calls = nodes(fn, ts.isCallExpression);
  const writes = calls.filter((call) => ["update", "delete", "insert", "upsert"].includes(callName(call)));
  if (writes.length === 0) return ["no row-scoped mutations found"];
  const errors: string[] = [];
  for (const write of writes) {
    let chain: ts.Node = write;
    while (ts.isPropertyAccessExpression(chain.parent) || ts.isCallExpression(chain.parent)) chain = chain.parent;
    const filters = nodes(chain, ts.isCallExpression);
    const owner = filters.some((call) => callName(call) === "eq" && ts.isStringLiteral(call.arguments[0]) && call.arguments[0].text === "user_id" && ["user.id", "session.userId"].includes(compact(call.arguments[1])));
    const id = filters.some((call) => ["eq", "in"].includes(callName(call)) && ts.isStringLiteral(call.arguments[0]) && call.arguments[0].text === "id");
    if (!owner || !id) errors.push("mutation lost immutable id/current owner filters");
  }
  if (calls.some((call) => ["fetch", "rpc", "signOut", "deleteUser", "insert"].includes(callName(call)))) errors.push("an account-wide effect cannot use the row exemption");
  return errors;
}

function audit(sources: Map<string, string>, decisions = policies): string[] {
  const errors: string[] = [];
  const actions = new Map<string, { fn: ts.FunctionDeclaration; file: ts.SourceFile }>();
  for (const [name, source] of sources) {
    const file = parse(name, source);
    for (const block of nodes(file, ts.isBlock)) if (block.statements.some(directive)) errors.push(`${name}: inline action needs an explicit policy`);
    if (!file.statements.some(directive)) continue;
    for (const statement of file.statements) {
      if (!hasModifier(statement, ts.SyntaxKind.ExportKeyword) && !ts.isExportDeclaration(statement) && !ts.isExportAssignment(statement)) continue;
      if (ts.isTypeAliasDeclaration(statement) || ts.isInterfaceDeclaration(statement)) continue;
      if (!ts.isFunctionDeclaration(statement) || !statement.name || !statement.body || !hasModifier(statement, ts.SyntaxKind.AsyncKeyword) || hasModifier(statement, ts.SyntaxKind.DefaultKeyword)) {
        errors.push(`${name}: unsupported export`);
        continue;
      }
      actions.set(`${name}#${statement.name.text}`, { fn: statement, file });
    }
  }
  if (actions.size === 0) errors.push("no Server Actions were scanned");
  for (const key of Object.keys(decisions)) if (!actions.has(key)) errors.push(`${key}: policy has no action`);
  for (const [key, { fn, file }] of actions) {
    const policy = decisions[key];
    if (!policy?.reason) { errors.push(`${key}: unclassified action`); continue; }
    if (policy.kind === "guard") {
      const calls = nodes(fn, ts.isCallExpression).filter((call) => callName(call) === "requireDisplayedUser");
      const expected = key.endsWith("#finishReset") ? "input?.expectedUserId" : fn.parameters.some((p) => p.name.getText() === "formData") ? 'formData.get("expectedUserId")' : "expectedUserId";
      const importsGuard = file.statements.some((s) => ts.isImportDeclaration(s) && ts.isStringLiteral(s.moduleSpecifier) && s.moduleSpecifier.text === "@/lib/action-identity" && s.importClause?.namedBindings && ts.isNamedImports(s.importClause.namedBindings) && s.importClause.namedBindings.elements.some((e) => e.name.text === "requireDisplayedUser" && !e.propertyName));
      const call = calls[0];
      if (!importsGuard || calls.length !== 1 || !call || compact(call.arguments[1]) !== expected) { errors.push(`${key}: missing identity precondition`); continue; }
      // A nested callback/try/catch or an always-false branch cannot masquerade as a guard.
      let parent: ts.Node = call.parent;
      while (parent !== fn.body && parent !== fn && !ts.isSourceFile(parent)) {
        if (ts.isTryStatement(parent) || ts.isFunctionLike(parent) || (ts.isIfStatement(parent) && compact(parent.expression) !== 'current.state==="signed_in"')) errors.push(`${key}: conditional identity precondition`);
        parent = parent.parent;
      }
      const before = nodes(fn.body!, ts.isCallExpression).filter((c) => c.pos < call.pos);
      const allowed = new Set(["now", "createClient", "getUser", "signedIn", "valuesOf", "freshCookieSession", "refusal", "readCookieSession", "sessionUserOrStop"]);
      if (before.some((c) => !allowed.has(callName(c)))) errors.push(`${key}: effect before identity precondition`);
    } else if (policy.kind === "public") {
      const delegates: Record<string, string> = {
        "login/actions.ts#signInWithAuthSecret": "signIn",
        "login/actions.ts#signUpWithAuthSecret": "signUp",
        "login/actions.ts#resendConfirmation": "resendSignupMail",
        "login/actions.ts#sendResetMail": "requestResetMail",
      };
      if (!delegates[key] || compact(fn.body!) !== `{return${delegates[key]}(input);}`) errors.push(`${key}: public exception was forged`);
    } else if (policy.kind === "identity-read") {
      if (key !== "login/session-actions.ts#readSignedInAddress" || nodes(fn, ts.isCallExpression).some((call) => callName(call) !== "getUser")) errors.push(`${key}: read exception was forged`);
    } else if (policy.kind === "rows") {
      const permitted = new Set([
        "app/category-actions.ts#setCategory", "app/parcel-actions.ts#markNotDelivered", "app/parcel-actions.ts#markNotReceived", "app/parcel-actions.ts#dismissCheck", "app/parcels/manual-actions.ts#updateManualParcel", "app/parcels/manual-actions.ts#deleteManualParcel",
      ]);
      if (!permitted.has(key)) { errors.push(`${key}: row exception was forged`); continue; }
      if (usesAdminData(file, fn)) errors.push(`${key}: admin-backed action cannot use the row exemption`);
      errors.push(...rowScopeErrors(fn).map((e) => `${key}: ${e}`));
    } else if (policy.kind === "owner-rpc") {
      const rpcs: Record<string, string> = {
        "app/parcel-actions.ts#markDelivered": "mark_parcels_received",
        "app/parcel-actions.ts#markDeliveredForUndo": "mark_parcels_received",
        "app/parcel-actions.ts#restoreStatuses": "restore_parcel_receipts",
      };
      const rpc = rpcs[key];
      if (!rpc) { errors.push(`${key}: owner-rpc exception was forged`); continue; }
      let target = fn;
      if (!key.endsWith("#restoreStatuses")) {
        const body = compact(fn.body!);
        if (body !== "{return(awaitdeliver(ids)).saved;}" && body !== "{returnawaitdeliver(ids);}") errors.push(`${key}: rpc wrapper changed`);
        target = namedFunction(file, "deliver")!;
      }
      if (usesAdminData(file, fn) || usesAdminData(file, target)) errors.push(`${key}: admin-backed action cannot use the owner-rpc exemption`);
      const calls = nodes(target, ts.isCallExpression);
      const rpcCalls = calls.filter((call) => callName(call) === "rpc");
      if (rpcCalls.length !== 1 || compact(rpcCalls[0].expression) !== "session.supabase.rpc" || !ts.isStringLiteral(rpcCalls[0].arguments[0]) || rpcCalls[0].arguments[0].text !== rpc) errors.push(`${key}: must call only ${rpc} through the signed-in client`);
      if (!calls.some((call) => callName(call) === "signedIn")) errors.push(`${key}: signed-in session is not required`);
      if (calls.some((call) => ["from", "update", "insert", "upsert", "fetch", "signOut", "deleteUser"].includes(callName(call)))) errors.push(`${key}: direct table or account effect cannot use the owner-rpc exemption`);
      // The ownership argument lives in SQL: the function must derive the owner from the session.
      const sql = readFileSync(path.resolve(app, "../../supabase/migrations/20261113130000_received_receipts.sql"), "utf8");
      const start = sql.indexOf(`function public.${rpc}(`);
      const end = sql.indexOf("create or replace function", start + 1);
      const definition = start < 0 ? "" : sql.slice(start, end < 0 ? undefined : end);
      if (!/security definer set search_path=''/.test(definition) || !definition.includes("v_user := auth.uid();") || !definition.includes("p.user_id=v_user")) errors.push(`${key}: ${rpc} does not take the owner from auth.uid()`);
    } else errors.push(`${key}: unsupported policy`);
  }
  return errors;
}

describe("every Web Server Action has an executable identity policy", () => {
  it("scans the real AST universe and checks every exported action", () => {
    expect(audit(realSources())).toEqual([]);
  });

  it("rejects an empty scan, a new unclassified action, an unknown export and an inline action", () => {
    expect(audit(new Map())).toContain("no Server Actions were scanned");
    for (const addition of ['export async function forgotten() {}', 'export const forgotten = async () => {};', 'async function outer() { "use server"; }']) {
      const sources = realSources();
      sources.set("new.ts", `"use server";\n${addition}`);
      expect(audit(sources).length).toBeGreaterThan(0);
    }
  });

  it("rejects removing, bypassing or moving an identity guard after an effect", () => {
    const name = "app/settings/account-actions.ts";
    const source = realSources().get(name)!;
    const statement = 'requireDisplayedUser(user, formData.get("expectedUserId"), "/app/settings/delete");';
    expect(source).toContain(statement);
    for (const replacement of ["", `if (false) ${statement}`, 'requireDisplayedUser(user, user.id, "/app");', `await createAdminClient().auth.admin.deleteUser(user!.id); ${statement}`]) {
      const sources = realSources();
      sources.set(name, source.replace(statement, replacement));
      expect(audit(sources).some((error) => error.startsWith(`${name}#deleteAccount:`))).toBe(true);
    }
  });

  it("cannot relabel an account effect as public, read-only or row-scoped", () => {
    for (const kind of ["public", "identity-read", "rows", "owner-rpc"] as const) {
      expect(audit(realSources(), { ...policies, "app/settings/account-actions.ts#deleteAccount": { kind, reason: "pretending this is an exception" } }).some((error) => error.includes("forged"))).toBe(true);
    }
  });

  it("requires the displayed identity for marking dropped mail and refuses its former row exemption", () => {
    const key = "app/settings/actions.ts#markWronglyDropped";
    const sources = realSources();
    const name = "app/settings/actions.ts";
    const statement = 'requireDisplayedUser(user, formData.get("expectedUserId"), "/app/settings/dropped");';
    const source = sources.get(name)!;
    const file = parse(name, source);
    const mark = namedFunction(file, "markWronglyDropped")!;
    const declaration = mark.getText(file);
    expect(declaration).toContain(statement);
    sources.set(name, source.slice(0, mark.getStart(file)) + declaration.replace(statement, "") + source.slice(mark.end));
    expect(audit(sources)).toContain(`${key}: missing identity precondition`);
    expect(audit(realSources(), { ...policies, [key]: rows })).toContain(`${key}: row exception was forged`);
  });

  it("rejects privileged clients and shared admin helpers even on an otherwise correctly row-scoped action", () => {
    const name = "app/category-actions.ts";
    const original = realSources().get(name)!;
    for (const [imports, effect] of [
      ['import { createAdminClient as privilegedDb } from "@/lib/supabase/admin";', "privilegedDb();"],
      ['import * as privileged from "@/lib/supabase/admin";', "privileged.createAdminClient();"],
      ['import { runMarkWronglyDropped as mark } from "@/lib/mail-run";', "await mark({} as never, user.id, undefined, id);"],
      ['import { createAdminClient as privilegedDb } from "@/lib/supabase/admin";\nfunction privilegedWrapper() { return privilegedDb(); }', "privilegedWrapper();"],
    ]) {
      const sources = realSources();
      sources.set(name, original.replace('"use server";', `"use server";\n${imports}`).replace("return { ok: true };", `${effect}\nreturn { ok: true };`));
      expect(audit(sources)).toContain(`${name}#setCategory: admin-backed action cannot use the row exemption`);
    }
  });

  it("rejects loss of an existing current-owner condition rather than trusting the exemption label", () => {
    const sources = realSources();
    sources.set("app/category-actions.ts", sources.get("app/category-actions.ts")!.replace('.eq("user_id", user.id)', ""));
    expect(audit(sources)).toContain("app/category-actions.ts#setCategory: mutation lost immutable id/current owner filters");
  });

  it("holds the owner-scoped RPC actions to the signed-in client, the named RPC and no direct table access", () => {
    const name = "app/parcel-actions.ts";
    const original = realSources().get(name)!;
    const mutations: Array<[string, string, string]> = [
      ['rpc("mark_parcels_received"', 'rpc("mark_parcels_received_x"', "app/parcel-actions.ts#markDeliveredForUndo"],
      ['rpc("restore_parcel_receipts"', 'rpc("mark_parcels_received"', "app/parcel-actions.ts#restoreStatuses"],
      ["session.supabase.rpc(\"mark_parcels_received\"", "(await createClient()).rpc(\"mark_parcels_received\"", "app/parcel-actions.ts#markDelivered"],
      ["const session = await signedIn();\n  if (!session) return { saved: 0, written: [] };", "const session = { supabase: await createClient(), userId: \"x\" };", "app/parcel-actions.ts#markDelivered"],
      ["  try {\n    const { data, error } = await session.supabase.rpc(\"mark_parcels_received\"", "  await session.supabase.from(\"parcels\").update({ received_at: null }).eq(\"id\", clean[0]);\n  try {\n    const { data, error } = await session.supabase.rpc(\"mark_parcels_received\"", "app/parcel-actions.ts#markDelivered"],
    ];
    for (const [from, to, key] of mutations) {
      expect(original).toContain(from);
      const sources = realSources();
      sources.set(name, original.replace(from, to));
      expect(audit(sources).some((error) => error.startsWith(`${key}:`))).toBe(true);
    }
  });
});
