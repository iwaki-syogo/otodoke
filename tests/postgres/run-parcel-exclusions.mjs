import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cleanEnvironment } from "./run-parcel-conflicts.mjs";
import { taggedResults } from "./run-cost-guards.mjs";

// "This is not a parcel" (parcel_exclusions): RLS, functions, receipt-function skips and lock order on a
// disposable real PostgreSQL. Scope: the SQL boundary only. R8 is an EQUIVALENT SQL of the spend page's
// read (src/app/app/spend/page.tsx), not the PostgREST call itself, so it is an "equivalent SQL" check only.
const root = fileURLToPath(new URL("../../", import.meta.url));
const stem = "20261117100000_parcel_exclusions";
const stem2 = "20261117110000_parcel_exclusions_auto";
const port = 65449;
const bin = process.env.OTODOKE_PG_BINDIR ?? "";
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const A = uuid(1), B = uuid(2);
const P1 = uuid(101), P2 = uuid(102), PM = uuid(103), P3 = uuid(104), P4 = uuid(105), P5 = uuid(106), P6 = uuid(107), P7 = uuid(108), PB1 = uuid(201), PBM = uuid(202);
const P8 = uuid(109), P9 = uuid(110), P10 = uuid(111), P11 = uuid(112), P12 = uuid(113), P13 = uuid(114), P14 = uuid(115);
const stage1Body = "23fe0c7677e6e01af5a2ba6f0cbb00ad";  // md5 of restore_parcel's body in the stage-1 migration
const E = (n) => uuid(300 + n);
const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const added = " and not exists(select 1 from public.parcel_exclusions e where e.parcel_id=p.id)";
const pinned = { mark_parcels_received: "266c7b11c6af28f28aa06cd435315db8", restore_parcel_receipts: "19d60a59dcb759c1f51b55d507d1dec8" };
const stage2Names = ["R0", "R-auto-1", "R-auto-2", "R-auto-3", "R-auto-4", "R-auto-5", "R-auto-6", "R-auto-6b", "R-auto-7", "U-compat", "R-restore-twice", "C3", "no-backfill"];
const testNames = ["R1", "R2", "R3", "R4", "R5", "R6", "R7", "R8", "R9", "R10", "R11", "R12", "R13", "R14", "R15", "R16", "R17", "R18"];
const prior = (names) => names.filter((name) => /^\d{14}_.+\.sql$/.test(name) && name.slice(0, 14) < stem.slice(0, 14)).sort();

const one = (output) => {
  const values = taggedResults(output);
  assert.equal(values.length, 1, `expected exactly one tagged JSON value: ${output}`);
  return JSON.parse(values[0]);
};
function healthy(result) {
  assert.equal(result.timedOut, false, "child timed out; never counted as success");
  assert.equal(result.signal, null, `child was interrupted: ${result.signal}`);
  assert.equal(result.code, 0, result.stderr || "child failed");
  assert.doesNotMatch(result.stderr, /\b(?:ERROR|FATAL|PANIC):/i, "SQL error even with exit zero");
  return result.stdout;
}
/** The whole run counts only with the final verdict line AND exit code 0. */
function judge(result) {
  const lines = result.stdout.trim().split(/\r?\n/);
  return result.code === 0 && result.signal === null && result.timedOut === false && lines.at(-1)?.startsWith("verdict=OK") === true
    && !/\b(?:ERROR|FATAL|PANIC):/i.test(result.stderr);
}
const verdictOf = (output) => {
  const cells = output.trim().split(/\r?\n/).at(-1).split("|");
  assert.equal(cells.length, 12, `verify row shape: ${output}`);
  for (const c of cells.slice(1, 11)) assert.match(c, /^[tf]$/);
  assert.match(cells[11], /^\d+$/);
  return { verdict: cells[0], cells };
};

const verdict2Of = (output) => {
  const cells = output.trim().split(/\r?\n/).at(-1).split("|");
  assert.equal(cells.length, 10, `stage 2 verify row shape: ${output}`);
  for (const c of cells.slice(1, 9)) assert.match(c, /^[tf]$/);
  assert.match(cells[9], /^\d+$/);
  return { verdict: cells[0], cells };
};

async function listening() {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    let settled = false;
    const finish = (value) => { if (!settled) { settled = true; socket.destroy(); resolve(value); } };
    socket.once("connect", () => finish(true)); socket.once("error", () => finish(false)); socket.setTimeout(500, () => finish(false));
  });
}

function start(executable, args, { environment, input, interactive = false, timeout = 20_000 } = {}) {
  const child = spawn(executable, args, { cwd: root, env: environment, stdio: ["pipe", "pipe", "pipe"] });
  const state = { stdout: "", stderr: "", code: null, signal: null, timedOut: false, exited: false };
  let hardStop;
  const timer = setTimeout(() => { state.timedOut = true; child.kill("SIGTERM"); hardStop = setTimeout(() => child.kill("SIGKILL"), 1000); }, timeout);
  child.stdin.on("error", () => {});
  child.stdout.on("data", (chunk) => { state.stdout += chunk; }); child.stderr.on("data", (chunk) => { state.stderr += chunk; });
  const complete = new Promise((resolve) => {
    child.on("error", (error) => { state.stderr += error.message; });
    child.on("close", (code, signal) => { clearTimeout(timer); clearTimeout(hardStop); Object.assign(state, { code, signal, exited: true }); resolve(state); });
  });
  if (interactive) child.stdin.write(input ?? ""); else child.stdin.end(input);
  return { child, state, complete };
}

async function selfTest() {
  assert.deepEqual(prior([`${stem}.sql`, "20261113140000_x.sql", "20261118000000_future.sql", "notes.md"]), ["20261113140000_x.sql"]);
  assert.equal(new Set(testNames).size, 18);
  assert.deepEqual(one('RESULT:[{"r":"ok"}]\n'), [{ r: "ok" }]);
  for (const value of ["", "RESULT:{}\nRESULT:{}\n", "RESULT:broken\n"]) assert.throws(() => one(value));
  const ok = { code: 0, signal: null, timedOut: false, stderr: "", stdout: "OK: x\nverdict=OK mode=positive\n" };
  assert.equal(judge(ok), true);
  for (const changes of [{ stdout: "OK: x\n" }, { stdout: "verdict=FAILED boom\n" }, { code: 1 }, { timedOut: true }, { signal: "SIGTERM" },
    { stderr: "ERROR: sql failed" }, { stderr: "FATAL: x" }, { stderr: "PANIC: x" }, { stdout: "verdict=OK mode=x\nextra line\n" }]) assert.equal(judge({ ...ok, ...changes }), false, JSON.stringify(changes));
  for (const changes of [{ code: 1 }, { timedOut: true }, { signal: "SIGTERM" }, { stderr: "ERROR: SQL failed" }, { stderr: "PANIC: SQL failed" }]) assert.throws(() => healthy({ ...ok, ...changes }));
  const verifyRow = (verdict) => `${verdict}|${"t|".repeat(10)}5\n`;
  assert.equal(verdictOf(verifyRow("OK")).verdict, "OK"); assert.equal(verdictOf(verifyRow("FAILED")).verdict, "FAILED");
  assert.throws(() => verdictOf("OK|t\n"));
  const source = await readFile(path.join(root, `supabase/migrations/${stem}.sql`), "utf8");
  assert.match(source, /as restrictive for select to authenticated/);
  assert.doesNotMatch(source, /as permissive/i);
  assert.equal(source.split(added).length - 1, 5, "four added conditions in the two replaced receipt functions, plus the gate's own constant");
  for (const md5 of Object.values(pinned)) assert.ok(source.includes(md5), "migration gate pins the 130000 body");
  assert.ok(source.indexOf("perform public.lock_sample_owner(v_user);") < source.indexOf("perform public.lock_parcel_owner(v_user);"), "sample owner lock comes first");
  assert.equal(new Set(stage2Names).size, 13);
  const verify2Row = (verdict) => `${verdict}|${"t|".repeat(8)}0\n`;
  assert.equal(verdict2Of(verify2Row("OK")).verdict, "OK"); assert.throws(() => verdict2Of("OK|t\n"));
  const source2 = await readFile(path.join(root, `supabase/migrations/${stem2}.sql`), "utf8");
  assert.ok(source2.includes(stage1Body), "stage 2 gate pins the stage-1 restore_parcel body");
  const ruleWriter = source2.slice(source2.indexOf("function public.mark_rule_exclusion("));
  assert.ok(ruleWriter.indexOf("perform public.lock_sample_owner(p_user);") > 0 && ruleWriter.indexOf("perform public.lock_sample_owner(p_user);") < ruleWriter.indexOf("perform public.lock_parcel_owner(p_user);")
    && ruleWriter.indexOf("perform public.lock_parcel_owner(p_user);") < ruleWriter.indexOf("insert into public.parcel_exclusions"), "mark_rule_exclusion takes the owner locks before its one statement");
  assert.match(ruleWriter, /p\.expected_text is null/);
  assert.doesNotMatch(source2, /create or replace function public\.(exclude_parcel|excluded_parcels)\(/, "stage 2 must not touch exclude_parcel / excluded_parcels");
  assert.doesNotMatch(source2, /drop function/i);
  assert.match(source2, /pg_get_function_result\(to_regprocedure\('public\.exclude_parcel\(uuid\)'\)\) is distinct from 'text'/);
  const dummy = async (code, options) => healthy(await start(process.execPath, ["-e", code], options).complete);
  await dummy("process.stdout.write('OK')");
  await assert.rejects(dummy("process.stderr.write('ERROR: synthetic');process.exit(0)"), /SQL error/);
  await assert.rejects(dummy("process.exit(1)"));
  await assert.rejects(dummy("setTimeout(()=>{},10000)", { timeout: 20 }), /timed out/);
  for (const name of [`supabase/rollback/${stem}.down.sql`, `supabase/verify/${stem}.sql`]) assert.ok((await readFile(path.join(root, name), "utf8")).length > 100);
  console.log("OK: self-test (final verdict + exit code judge, tagged JSON shape, child failure/exit-zero SQL error/timeout, migration source guards, test registry)");
  console.log("NOT RUN: PostgreSQL startup, migration/verify/rollback execution, RLS and function behavior, lock-order and race tests, negative controls");
}

async function main(negative) {
  assert.equal(await listening(), false, `dedicated port ${port} is occupied; no existing server was touched`);
  const parent = path.join(root, ".vitest/pg"); await mkdir(parent, { recursive: true });
  const scratch = await mkdtemp(path.join(parent, "exclusions-"));
  const data = path.join(scratch, "data");
  console.log(`CLUSTER: proposed 127.0.0.1:${port} data=${path.relative(root, data)}; only this new cluster will be started/stopped/deleted`);
  const environment = cleanEnvironment(scratch);
  const children = new Set(); let interrupted = false, startAttempted = false, cleanupPromise;
  const launch = (name, args, options = {}, cleanup = false) => {
    assert.ok(cleanup || !interrupted, "interrupted; no further test operation started");
    const handle = start(path.join(bin, name), args, { environment, ...options });
    children.add(handle); handle.complete.then(() => children.delete(handle)); return handle;
  };
  const command = async (name, args, options, cleanup) => healthy(await launch(name, args, options, cleanup).complete);
  const args = ["-X", "-w", "-q", "-A", "-t", "-h", "127.0.0.1", "-p", String(port), "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-v", "VERBOSITY=verbose"];
  const preamble = "set statement_timeout='12s'; set lock_timeout='8s'; set deadlock_timeout='100ms';\n";
  const sql = (input) => command("psql", args, { input: preamble + input });
  const scalar = async (input) => (await sql(input)).trim();
  const file = (name) => command("psql", [...args, "-f", path.join(root, name)], { timeout: 30_000 });
  const actor = (role, user, query) => `begin; set local role ${role}; set local request.jwt.claim.sub=${quote(user ?? "")}; set local request.headers='{}'; ${query} commit;`;
  // jsonb_agg, never json_agg: json_agg puts newlines between elements and would split the tagged line.
  const rows = async (role, user, select) => one(await sql(actor(role, user, `select 'RESULT:'||coalesce(jsonb_agg(to_jsonb(t)),'[]'::jsonb)::text from (${select}) t;`)));
  const suRows = async (select) => one(await sql(`select 'RESULT:'||coalesce(jsonb_agg(to_jsonb(t)),'[]'::jsonb)::text from (${select}) t;`));
  // A data-modifying statement with RETURNING, run with the caller's rights; the rows come back as one JSON value.
  const dml = async (role, user, command) => one(await sql(actor(role, user, `select 'RESULT:'||public.test_dml_rows(${quote(command)})::text;`)));
  const call = async (user, expr) => (await rows("authenticated", user, `select ${expr} as r`))[0].r;
  const err = async (role, user, statement) => one(await sql(actor(role, user, `select 'RESULT:'||public.test_capture_error(${quote(statement)})::text;`)));
  const visible = async (user) => (await rows("authenticated", user, "select id from public.parcels order by id")).map((r) => r.id);
  const marks = (where = "true") => suRows(`select parcel_id,user_id,kind,from_domain,relevance,counted from public.parcel_exclusions where ${where} order by parcel_id`);
  let stage2 = false, preSnapshot = null;
  // A write to parcels under the owner locks (the same two locks the real writers take).
  const st = (user, body) => sql(`begin; select public.lock_sample_owner('${user}'); select public.lock_parcel_owner('${user}'); ${body} commit;`);
  const markRule = async (parcel, domain = "shop.example", relevance = "order", user = A) =>
    (await rows("service_role", "", `select public.mark_rule_exclusion('${user}','${parcel}',${domain === null ? "null" : quote(domain)},${quote(relevance)}) as r`))[0].r;
  const addGroupParcel = (id, email, domain, relevance) => sql(`begin; select public.lock_sample_owner('${A}');
    insert into public.emails(id,user_id,provider_email_id,from_domain,sent_at,processing_status) values ('${email}','${A}','syn:${email}','${domain}','2026-11-02T00:00:00Z','processed');
    select public.lock_parcel_owner('${A}');
    insert into public.parcels(id,user_id,shop,status,ordered_at,total_amount,title,category_source,category,source) values ('${id}','${A}','Shop ${domain}','ordered','2026-11-05T00:00:00Z',100,'g','user','hobby','mail');
    insert into public.extractions(user_id,email_id,parcel_id,model,result) values ('${A}','${email}','${id}','synthetic','{"relevance":"${relevance}"}'); commit;`);
  const digest = async () => (await suRows(`select md5(coalesce((select jsonb_agg(to_jsonb(x) order by parcel_id) from public.parcel_exclusions x),'[]')::text
    ||coalesce((select jsonb_agg(to_jsonb(p) order by id) from public.parcels p),'[]')::text
    ||coalesce((select jsonb_agg(to_jsonb(s) order by user_id) from public.excluded_seen s),'[]')::text) as d`))[0].d;
  const snapshotRows = async () => ({ a: await rows("authenticated", A, "select * from public.parcels order by id"), b: await rows("authenticated", B, "select * from public.parcels order by id") });
  const waitFor = async (predicate, label, handles = []) => {
    const until = Date.now() + 6000;
    while (Date.now() < until) {
      if (interrupted) throw new Error("interrupted during wait");
      if (await predicate()) return;
      for (const handle of handles) assert.equal(handle.state.exited, false, `worker exited before ${label}: ${handle.state.stderr}`);
      await delay(10);
    }
    throw new Error(`timed out waiting for ${label}; not a completed trial`);
  };
  const interactive = (input) => launch("psql", args, { input: preamble + input, interactive: true, timeout: 20_000 });
  const release = async (handle) => { handle.child.stdin.end("rollback;\n"); return healthy(await handle.complete); };
  const stop = () => { interrupted = true; for (const handle of children) handle.child.kill("SIGTERM"); };
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  const cleanup = () => (cleanupPromise ??= (async () => {
    const pending = [...children]; pending.forEach((handle) => handle.child.kill("SIGTERM"));
    await Promise.all(pending.map((handle) => handle.complete));
    if (startAttempted) {
      const status = await launch("pg_ctl", ["-D", data, "status"], { timeout: 5000 }, true).complete;
      if (status.code === 0) await command("pg_ctl", ["-D", data, "-t", "10", "-m", "fast", "stop"], { timeout: 15_000 }, true);
      else assert.equal(status.code, 3, `cannot establish whether this disposable cluster stopped: ${status.stderr}`);
    }
    assert.equal(await listening(), false, `listener remains on 127.0.0.1:${port}; dedicated data was retained`);
    const actualParent = await realpath(parent), actualScratch = await realpath(scratch);
    assert.equal(path.dirname(actualScratch), actualParent); assert.match(path.basename(actualScratch), /^exclusions-/);
    await rm(actualScratch, { recursive: true });
    console.log(`OK: cleanup: own cluster stopped, listener=0 on 127.0.0.1:${port}, dedicated data and logs deleted`);
  })());

  // Parcels of A: P1 and P2 (mail), PM (manual), P3 (two mails, read in the opposite order to being sent),
  // P4 (first mail by sent_at is the sender's own copy), P5 (no mail), P6 (shared domain). B: PB1 and a manual PBM.
  const reset = async () => {
    // One owner per statement/transaction: the delete callback refuses two owners at once.
    await sql(`delete from auth.users where id='${A}';`); await sql(`delete from auth.users where id='${B}';`);
    await sql(`insert into auth.users(id) values ('${A}'),('${B}');
      begin; select public.lock_sample_owner('${A}');
      insert into public.emails(id,user_id,provider_email_id,from_domain,sent_at,processing_status) values
        ('${E(1)}','${A}','syn:e1','shop.example','2026-11-02T00:00:00Z','processed'),
        ('${E(2)}','${A}','syn:e2','shop2.example','2026-11-02T00:00:00Z','processed'),
        ('${E(31)}','${A}','syn:e31','old.example','2026-11-01T00:00:00Z','processed'),
        ('${E(32)}','${A}','syn:e32','new.example','2026-11-03T00:00:00Z','processed'),
        ('${E(41)}','${A}','syn:e41','carrier.example','2026-11-01T00:00:00Z','processed'),
        ('${E(42)}','${A}','syn:e42','shop4.example','2026-11-02T00:00:00Z','processed'),
        ('${E(6)}','${A}','syn:e6','gmail.com','2026-11-02T00:00:00Z','processed');
      select public.lock_parcel_owner('${A}');
      insert into public.parcels(id,user_id,shop,status,ordered_at,total_amount,title,category_source,category,source) values
        ('${P1}','${A}','Shop One','ordered','2026-11-05T00:00:00Z',1000,'one','user','hobby','mail'),
        ('${P2}','${A}','Shop Two','shipped','2026-11-06T00:00:00Z',2000,'two','user','hobby','mail'),
        ('${PM}','${A}','Typed in','ordered','2026-11-07T00:00:00Z',500,'typed','user','hobby','manual'),
        ('${P3}','${A}','Shop Three','ordered','2026-11-08T00:00:00Z',300,'three','user','hobby','mail'),
        ('${P4}','${A}','Shop Four','ordered','2026-11-09T00:00:00Z',400,'four','user','hobby','mail'),
        ('${P5}','${A}','Shop Five','ordered','2026-11-10T00:00:00Z',50,'five','user','hobby','mail'),
        ('${P6}','${A}','Shop Six','ordered','2026-11-11T00:00:00Z',60,'six','user','hobby','mail');
      insert into public.parcel_items(parcel_id,user_id,name) values ('${P1}','${A}','Synthetic item one'),('${P2}','${A}','Synthetic item two');
      insert into public.extractions(user_id,email_id,parcel_id,model,result,created_at) values
        ('${A}','${E(1)}','${P1}','synthetic','{"relevance":"order"}','2026-11-10T00:00:00Z'),
        ('${A}','${E(2)}','${P2}','synthetic','{"relevance":"shipped"}','2026-11-10T00:00:00Z'),
        ('${A}','${E(31)}','${P3}','synthetic','{"relevance":"order"}','2026-11-12T00:00:00Z'),
        ('${A}','${E(32)}','${P3}','synthetic','{"relevance":"shipped"}','2026-11-09T00:00:00Z'),
        ('${A}','${E(41)}','${P4}','synthetic','{"relevance":"other_purchase","inbound":{"value":false,"confidence":0.9}}','2026-11-09T00:00:00Z'),
        ('${A}','${E(42)}','${P4}','synthetic','{"relevance":"order","inbound":{"value":true,"confidence":0.9}}','2026-11-12T00:00:00Z'),
        ('${A}','${E(6)}','${P6}','synthetic','{"relevance":"order"}','2026-11-10T00:00:00Z');
      commit;
      begin; select public.lock_sample_owner('${B}');
      insert into public.emails(id,user_id,provider_email_id,from_domain,sent_at,processing_status) values ('${E(9)}','${B}','syn:e9','b.example','2026-11-02T00:00:00Z','processed');
      select public.lock_parcel_owner('${B}');
      insert into public.parcels(id,user_id,shop,status,ordered_at,total_amount,title,category_source,category,source) values
        ('${PB1}','${B}','B Shop','ordered','2026-11-05T00:00:00Z',700,'b one','user','hobby','mail'),
        ('${PBM}','${B}','B typed','ordered','2026-11-05T00:00:00Z',70,'b typed','user','hobby','manual');
      insert into public.extractions(user_id,email_id,parcel_id,model,result) values ('${B}','${E(9)}','${PB1}','synthetic','{"relevance":"order"}');
      commit;`);
  };
  // A parcel made from a sample mail (demo: provider id under the current generation).
  const addSample = () => sql(`begin; select public.lock_sample_owner('${A}');
    select set_config('request.headers',jsonb_build_object('x-otodoke-sample-user','${A}','x-otodoke-sample-generation',(select generation::text from public.sample_generations where user_id='${A}'))::text,true);
    insert into public.emails(id,user_id,provider_email_id,from_domain,sent_at,processing_status) values ('${E(7)}','${A}','demo:e7','sample.example','2026-11-02T00:00:00Z','processed');
    select public.lock_parcel_owner('${A}');
    insert into public.parcels(id,user_id,shop,status,ordered_at,total_amount,title,category_source,category,source) values ('${P7}','${A}','Sample shop','ordered','2026-11-12T00:00:00Z',10,'sample','user','hobby','mail');
    insert into public.extractions(user_id,email_id,parcel_id,model,result) values ('${A}','${E(7)}','${P7}','synthetic','{"relevance":"order"}');
    commit;`);

  const fixture = {
    r1: async () => { await reset(); assert.equal(await call(A, `public.exclude_parcel('${P1}')`), "ok"); const ids = await visible(A); assert.ok(!ids.includes(P1), "R1: P1 must be hidden"); return ids; },
    r4: async () => {
      const policies = await suRows("select policyname,permissive,cmd,roles::text as roles,qual from pg_policies where schemaname='public' and tablename in ('parcels','parcel_exclusions') order by policyname");
      const hide = policies.find((p) => p.policyname === "hide excluded parcels");
      assert.ok(hide, "R4: hide policy exists"); assert.equal(hide.permissive, "RESTRICTIVE"); assert.equal(hide.cmd, "SELECT"); assert.equal(hide.roles, "{authenticated}");
      const own = policies.find((p) => p.policyname === "own parcel exclusions");
      assert.equal(own.permissive, "PERMISSIVE"); assert.doesNotMatch(own.qual, /parcels/, "R4: the table's own policy must not read parcels (infinite recursion)");
    },
    r5: async () => {
      await reset(); await call(A, `public.exclude_parcel('${P1}')`);
      const denied = /permission denied for table parcel_exclusions/;
      for (const [role, user, statement] of [
        ["authenticated", A, `insert into public.parcel_exclusions(parcel_id,user_id,kind) values ('${P2}','${A}','user')`],
        ["authenticated", A, `update public.parcel_exclusions set kind='rule' where parcel_id='${P1}'`],
        ["authenticated", A, `delete from public.parcel_exclusions where parcel_id='${P1}'`],
        ["authenticated", A, "truncate public.parcel_exclusions"],
        ["anon", "", "select * from public.parcel_exclusions"],
        ["anon", "", `insert into public.parcel_exclusions(parcel_id,user_id,kind) values ('${P2}','${A}','user')`],
      ]) { const result = await err(role, user, statement); assert.equal(result.state, "42501", `R5: ${role} ${statement}`); assert.match(result.message, denied, `R5: must be a privilege error, not only RLS: ${statement}`); }
      assert.equal((await marks()).length, 1);
    },
    r18: async () => {
      await reset();
      const insert = await err("service_role", "", `insert into public.parcel_exclusions(parcel_id,user_id,kind) values ('${PB1}','${A}','user')`);
      assert.equal(insert.state, "42501", `R18: a mark whose user_id is not the parcel owner must be refused: ${JSON.stringify(insert)}`);
      assert.equal((await marks()).length, 0); assert.ok((await visible(B)).includes(PB1));
      await sql(`insert into public.parcel_exclusions(parcel_id,user_id,kind) values ('${PB1}','${B}','user')`);
      const update = await err("service_role", "", `update public.parcel_exclusions set user_id='${A}' where parcel_id='${PB1}'`);
      assert.equal(update.state, "42501", `R18: moving a mark to another user must be refused: ${JSON.stringify(update)}`);
    },
  };

  const columns11 = ["parcel_id", "kind", "excluded_at", "shop", "title", "status", "ordered_at", "expected_date", "total_amount", "carrier", "item_names"];
  fixture.r0 = async () => {
    assert.ok(preSnapshot, "R0: the snapshot was taken before the first migration");
    const now = await snapshotRows();
    assert.ok(now.a.length >= 7 && now.b.length >= 2);
    assert.deepEqual(now, preSnapshot, "R0: before any mark, the person's parcel rows are the same before and after the migration");
  };
  fixture.rAuto1 = async () => {
    await reset(); assert.equal(await markRule(P1), 1);
    assert.ok(!(await visible(A)).includes(P1), "R-auto-1: a rule mark hides the parcel");
    assert.ok((await visible(B)).includes(PB1));
    await sql(`delete from public.parcel_exclusions where parcel_id='${P1}'`);
    assert.ok((await visible(A)).includes(P1), "R-auto-1: removing the mark shows it again");
  };
  fixture.rAuto3 = async () => {
    await reset();
    const has = async (user = A) => { const r = await rows("authenticated", user, "select public.has_open_auto_exclusion() as r"); assert.equal(typeof r[0].r, "boolean"); return r[0].r; };
    assert.equal(await has(), false, "no mark");
    await call(A, `public.exclude_parcel('${P2}')`); assert.equal(await has(), false, "a person's own mark is not automatic");
    assert.equal(await markRule(P1), 1); assert.equal(await has(), true, "an automatic mark on an ordered parcel");
    await st(A, `update public.parcels set status='delivered' where id='${P1}';`); assert.equal(await has(), false, "delivered");
    await st(A, `update public.parcels set status='cancelled' where id='${P1}';`); assert.equal(await has(), false, "cancelled");
    await st(A, `update public.parcels set status='ordered' where id='${P1}';`); assert.equal(await has(), true);
    assert.equal(await has(B), false, "another person's marks");
    assert.equal((await err("anon", "", "select public.has_open_auto_exclusion()")).state, "42501");
    assert.equal((await err("authenticated", "", "select public.has_open_auto_exclusion()")).state, "42501");
    assert.equal((await suRows("select pg_get_function_result('public.has_open_auto_exclusion()'::regprocedure) as ty"))[0].ty, "boolean", "a boolean, never a count");
  };
  fixture.rAuto4 = async () => {
    await reset(); assert.equal(await markRule(P1), 1);
    const seenNow = async (user = A) => rows("authenticated", user, "select public.has_open_auto_exclusion() as r").then((r) => r[0].r);
    const t1 = `(select created_at from public.parcel_exclusions where parcel_id='${P1}')`;
    const stored = async () => (await suRows(`select auto_excluded_seen_at, auto_excluded_seen_at=${t1} as at_t1, auto_excluded_seen_at<=clock_timestamp() as not_future, auto_excluded_seen_at>${t1} as after_t1 from public.excluded_seen where user_id='${A}'`))[0];
    assert.equal(await seenNow(), true);
    assert.equal((await rows("authenticated", A, `select public.mark_auto_excluded_seen(${t1}) as r`))[0].r, "ok");
    assert.equal(await seenNow(), false, "seen up to the mark's time");
    assert.equal((await stored()).at_t1, true);
    await sql(`insert into public.parcel_exclusions(parcel_id,user_id,kind,from_domain,relevance,counted,created_at) values ('${P3}','${A}','rule','x.example','order',false,${t1}+interval '1 millisecond')`);
    assert.equal(await seenNow(), true, "a mark made after the seen time shows again");
    const unseen = await rows("authenticated", A, "select parcel_id,kind,unseen from public.excluded_parcels_unseen()");
    assert.deepEqual(unseen.map((r) => [r.parcel_id, r.unseen]), [[P3, true], [P1, false]], "unseen is per mark; newest first");
    await rows("authenticated", A, `select public.mark_auto_excluded_seen(${t1}-interval '1 day') as r`);
    assert.equal((await stored()).at_t1, true, "an older time never moves it back"); assert.equal(await seenNow(), true);
    await rows("authenticated", A, "select public.mark_auto_excluded_seen(now()+interval '1 year') as r");
    const future = await stored(); assert.equal(future.not_future, true, "a future time is rounded down to now()"); assert.equal(future.after_t1, true);
    assert.equal(await seenNow(), false);
    assert.deepEqual(await suRows(`select count(*)::int as n from public.excluded_seen where user_id='${B}'`), [{ n: 0 }], "B's row was never made");
    assert.equal(await seenNow(B), false);
    assert.equal((await rows("authenticated", A, "select user_id from public.excluded_seen")).length, 1, "A reads its own row");
    assert.equal((await rows("authenticated", B, "select user_id from public.excluded_seen")).length, 0, "B does not read A's row");
    for (const statement of [`insert into public.excluded_seen(user_id,auto_excluded_seen_at) values ('${B}',now())`, `update public.excluded_seen set auto_excluded_seen_at='2000-01-01' where user_id='${A}'`,
      `delete from public.excluded_seen where user_id='${A}'`, "truncate public.excluded_seen"]) {
      const r = await err("authenticated", A, statement); assert.equal(r.state, "42501", `R-auto-4: ${statement}`); assert.match(r.message, /permission denied for table excluded_seen/);
    }
    assert.equal((await err("anon", "", "select * from public.excluded_seen")).state, "42501");
    for (const bad of ["null", "'infinity'::timestamptz"]) assert.equal((await err("authenticated", A, `select public.mark_auto_excluded_seen(${bad})`)).state, "22023", `R-auto-4: ${bad}`);
    assert.equal((await err("anon", "", "select public.mark_auto_excluded_seen(now())")).state, "42501");
    assert.equal((await err("authenticated", "", "select public.mark_auto_excluded_seen(now())")).state, "42501");
  };
  fixture.rAuto5 = async () => {
    await reset();
    for (const id of [P8, P9, P10, P11, P12, P13, P14]) await addGroupParcel(id, E(40 + Number(id.slice(-3)) - 100), "shop.example", "order");
    assert.equal(await markRule(P1), 1, "an ordered parcel without a sign"); assert.equal(await markRule(P1), 0, "a second call adds nothing");
    const [m] = await marks(`parcel_id='${P1}'`); assert.deepEqual([m.kind, m.from_domain, m.relevance, m.counted], ["rule", "shop.example", "order", false]);
    assert.equal((await marks()).length, 1);
    assert.equal(await markRule(P2), 0, "a shipped parcel");
    await st(A, `update public.parcels set carrier='yamato' where id='${P3}'; update public.parcels set expected_text='soon' where id='${P4}';
      update public.parcels set expected_date='2026-11-20' where id='${P8}'; update public.parcels set tracking_number='123456789012' where id='${P9}';
      update public.parcels set expected_window_start='09:00' where id='${P10}'; update public.parcels set requires_presence=true where id='${P11}';
      update public.parcels set status='unknown' where id='${P12}'; update public.parcels set expected_window_end='10:00' where id='${P14}';`);
    for (const [id, why] of [[P3, "carrier"], [P4, "expected_text"], [P8, "expected_date"], [P9, "tracking_number"], [P10, "time window"], [P14, "time window end"], [P11, "requires_presence"]]) assert.equal(await markRule(id), 0, `a parcel with ${why}`);
    assert.equal(await markRule(P12), 1, "status unknown is allowed"); assert.equal(await markRule(P13), 1);
    assert.equal(await markRule(PM), 0, "a typed-in parcel"); assert.equal(await markRule(PB1), 0, "another person's parcel"); assert.equal(await markRule(uuid(999)), 0);
    for (const [role, user] of [["authenticated", A], ["anon", ""]]) assert.equal((await err(role, user, `select public.mark_rule_exclusion('${A}','${P5}','x','order')`)).state, "42501", `${role} cannot run it`);
    assert.equal((await err("service_role", "", `select public.mark_rule_exclusion(null,'${P5}','x','order')`)).state, "22023");
    assert.equal((await suRows(`select pg_get_function_result('public.mark_rule_exclusion(uuid,uuid,text,text)'::regprocedure) as ty`))[0].ty, "integer");
  };
  fixture.rAuto7 = async () => {
    await reset();
    const would = async (user, id) => (await rows("authenticated", user, `select public.auto_exclusion_would_start(${id === null ? "null" : `'${id}'`}) as r`))[0].r;
    const press = async (id) => assert.equal(await call(A, `public.exclude_parcel('${id}')`), "ok");
    await press(P1); assert.equal(await would(A, P1), false, "one pressed mark is not enough (P1 is the only parcel of its domain)");
    await addGroupParcel(P8, E(50), "shop.example", "order");
    await press(P8); assert.equal(await would(A, P8), true, "two pressed marks of an order group"); assert.equal(await would(A, P1), true);
    assert.equal(await would(B, P8), false, "another person"); assert.equal(await would(A, uuid(999)), false, "no such parcel"); assert.equal(await would(A, P3), false, "no mark");
    assert.equal(await would(A, null), false);
    await addGroupParcel(P9, E(51), "shop.example", "order");
    assert.equal(await would(A, P8), false, "an unmarked parcel of the same domain exists");
    await press(P9); assert.equal(await would(A, P8), true, "all parcels of the domain are marked again");
    await addGroupParcel(P10, E(52), "ship.example", "shipped"); await addGroupParcel(P11, E(53), "ship.example", "shipped");
    await press(P10); await press(P11); assert.equal(await would(A, P11), false, "a shipping group is never automatic");
    await addGroupParcel(P12, E(54), "pay.example", "payment"); await addGroupParcel(P13, E(55), "pay.example", "payment");
    await press(P12); await press(P13); assert.equal(await would(A, P13), true, "a payment group");
    await addGroupParcel(P14, E(56), "mail.yahoo.co.jp", "order");
    await sql(`insert into public.parcel_exclusions(parcel_id,user_id,kind,from_domain,relevance,counted) values ('${P14}','${A}','user','mail.yahoo.co.jp','order',true),('${P4}','${A}','user','mail.yahoo.co.jp','order',true)`);
    assert.equal(await would(A, P14), false, "a domain on the never-automatic list");
    assert.equal(await markRule(P3), 1); assert.equal(await would(A, P3), false, "an automatic mark is not a pressed mark");
    const before = await digest();
    for (const id of [P1, P8, P3, P14, uuid(999)]) await would(A, id);
    assert.equal(await digest(), before, "R-auto-7: the function writes nothing");
    assert.equal((await suRows("select provolatile as v from pg_proc where oid='public.auto_exclusion_would_start(uuid)'::regprocedure"))[0].v, "s");
    assert.equal((await err("anon", "", `select public.auto_exclusion_would_start('${P1}')`)).state, "42501");
    assert.equal((await err("authenticated", "", `select public.auto_exclusion_would_start('${P1}')`)).state, "42501");
  };
  fixture.uCompat = async () => {
    await reset();
    assert.equal(await call(A, `public.exclude_parcel('${P1}')`), "ok", "U-compat: the stage-1 call still returns 'ok'");
    assert.equal((await rows("authenticated", A, `select pg_typeof(public.exclude_parcel('${P2}'))::text as ty`))[0].ty, "text");
    assert.equal((await suRows("select pg_get_function_result('public.exclude_parcel(uuid)'::regprocedure) as ty"))[0].ty, "text");
    assert.deepEqual((await suRows("select proargnames as nm from pg_proc where oid='public.excluded_parcels()'::regprocedure"))[0].nm, columns11);
    const list = await rows("authenticated", A, "select * from public.excluded_parcels()");
    assert.deepEqual(Object.keys(list[0]).sort(), [...columns11].sort(), "U-compat: the stage-1 reader gets the same 11 columns");
  };
  // No backfill: applying the migrations (again), rolling stage 2 back and forward, never creates a mark on an existing row.
  const markRows = () => suRows("select * from public.parcel_exclusions order by parcel_id");
  const backfilling = async (name) => (await readFile(path.join(root, `supabase/migrations/${name}.sql`), "utf8")).replace(/\ncommit;\s*$/, `
insert into public.parcel_exclusions(parcel_id,user_id,kind,from_domain,relevance,counted)
  select p.id,p.user_id,'rule',null,null,false from public.parcels p where p.source='mail' and p.status in ('unknown','ordered') on conflict (parcel_id) do nothing;
commit;
`);
  fixture.noBackfill = async (apply1, apply2) => {
    await reset(); await call(A, `public.exclude_parcel('${P1}')`);   // A has a mark of its own, B has none; unmarked mail parcels exist
    assert.ok((await suRows("select count(*)::int as n from public.parcels where source='mail' and status in ('unknown','ordered')"))[0].n >= 4);
    const before = await markRows(); assert.equal(before.length, 1);
    await apply1(); assert.deepEqual(await markRows(), before, "no-backfill: the first migration (applied again) adds no mark");
    await apply2(); assert.deepEqual(await markRows(), before, "no-backfill: the stage-2 migration (applied again) adds no mark");
    await file(`supabase/rollback/${stem2}.down.sql`); assert.deepEqual(await markRows(), before, "no-backfill: rolling stage 2 back changes no mark");
    await apply2(); assert.deepEqual(await markRows(), before, "no-backfill: applying stage 2 forward again adds no mark");
    stage2 = true;
  };
  // The stage-2 rollback removes the automatic marks (kind='rule') and keeps the pressed ones (kind='user'); the number is printed.
  const runText = async (text) => { const r = await launch("psql", args, { input: preamble + text }).complete; healthy(r); return r.stderr + r.stdout; };
  fixture.downRemovesRule = async (downText) => {
    await reset(); await call(A, `public.exclude_parcel('${P1}')`);
    assert.equal(await markRule(P3), 1); assert.equal(await markRule(P4), 1); assert.equal(await markRule(PB1, "b.example", "order", B), 1);
    const output = await runText(downText);
    assert.match(output, /removed 3 automatic marks/, "the rollback prints how many automatic marks it removed");
    assert.deepEqual((await marks()).map((m) => [m.parcel_id, m.kind]), [[P1, "user"]], "only the pressed mark is left");
    const mine = await visible(A); assert.ok(mine.includes(P3) && mine.includes(P4), "the automatic parcels are visible again"); assert.ok(!mine.includes(P1), "the pressed one stays hidden");
    assert.ok((await visible(B)).includes(PB1));
    await file(migrationFile2); stage2 = true;
  };
  fixture.restoreTwice = async () => {
    await reset(); await call(A, `public.exclude_parcel('${P1}')`);
    assert.equal(await call(A, `public.restore_parcel('${P1}')`), "ok"); assert.equal(await call(A, `public.restore_parcel('${P1}')`), "ok", "a second press is ok");
    assert.equal(await call(A, `public.restore_parcel('${P2}')`), "ok", "a parcel of the person that was never marked");
    assert.equal(await call(A, `public.restore_parcel('${PB1}')`), "gone", "another person's parcel"); assert.equal(await call(A, `public.restore_parcel('${uuid(999)}')`), "gone", "no such parcel");
    assert.ok((await visible(A)).includes(P1));
  };

  const tests = [];
  const tests2 = [];
  const test2 = (name, fn) => tests2.push([name, fn]);
  const test = (name, fn) => tests.push([name, fn]);
  test("R1+R2 hidden / not marked stays", async () => {
    const ids = await fixture.r1();
    for (const keep of [P2, PM, P3]) assert.ok(ids.includes(keep), "R2: a parcel that was not marked stays visible");
    const [m] = await marks(`parcel_id='${P1}'`);
    assert.deepEqual([m.kind, m.from_domain, m.relevance, m.counted, m.user_id], ["user", "shop.example", "order", true, A]);
  });
  test("R3 another user's parcel", async () => {
    await reset(); assert.equal(await call(A, `public.exclude_parcel('${PB1}')`), "gone");
    assert.equal(await call(A, `public.exclude_parcel('${uuid(999)}')`), "gone");
    assert.equal((await marks()).length, 0); assert.ok((await visible(B)).includes(PB1));
    assert.equal(await call(A, `public.restore_parcel('${PB1}')`), "gone");
  });
  test("R4 restrictive policy", fixture.r4);
  test("R5 no direct writes", fixture.r5);
  test("R6 restore", async () => {
    await reset(); await call(A, `public.exclude_parcel('${P1}')`);
    assert.equal(await call(A, `public.restore_parcel('${P1}')`), "ok"); assert.ok((await visible(A)).includes(P1));
    // Stage 1: an unmarked parcel is 'gone'. From stage 2 on it is 'ok' (pressing "put back" twice); another user's parcel stays 'gone'.
    assert.equal(await call(A, `public.restore_parcel('${P1}')`), stage2 ? "ok" : "gone"); assert.equal((await marks()).length, 0);
    assert.equal(await call(A, `public.restore_parcel('${PB1}')`), "gone");
  });
  test("R7 a hidden row cannot be written", async () => {
    await reset(); await call(A, `public.exclude_parcel('${P1}')`);
    assert.deepEqual(await dml("authenticated", A, `update public.parcels set status='delivered' where id='${P1}' returning id`), []);
    assert.deepEqual(await dml("authenticated", A, `delete from public.parcels where id='${P1}' returning id`), []);
    assert.deepEqual(await suRows(`select status from public.parcels where id='${P1}'`), [{ status: "ordered" }]);
  });
  test("R8 spend read (equivalent SQL, not the PostgREST call)", async () => {
    await reset();
    const spend = async () => (await rows("authenticated", A, `select id,total_amount from public.parcels where user_id='${A}' and status<>'cancelled' and ordered_at>='2026-11-01' and ordered_at<='2026-11-30' order by ordered_at desc`));
    const before = await spend(); assert.ok(before.some((r) => r.id === P1));
    await call(A, `public.exclude_parcel('${P1}')`);
    const after = await spend(); assert.ok(!after.some((r) => r.id === P1)); assert.ok(after.some((r) => r.id === P2));
    assert.equal(before.reduce((n, r) => n + r.total_amount, 0) - after.reduce((n, r) => n + r.total_amount, 0), 1000);
  });
  test("R9 excluded parcels list", async () => {
    await reset(); await call(A, `public.exclude_parcel('${P1}')`); await delay(15); await call(A, `public.exclude_parcel('${P2}')`); await call(B, `public.exclude_parcel('${PB1}')`);
    const list = await rows("authenticated", A, "select * from public.excluded_parcels()");
    assert.deepEqual(list.map((r) => r.parcel_id), [P2, P1], "newest mark first, A's own only");
    assert.deepEqual(list.map((r) => r.kind), ["user", "user"]); assert.deepEqual(list[1].item_names, ["Synthetic item one"]);
    assert.equal(list[1].shop, "Shop One"); assert.equal(list[1].total_amount, 1000);
    assert.deepEqual((await rows("authenticated", B, "select parcel_id from public.excluded_parcels()")).map((r) => r.parcel_id), [PB1]);
    const own = await rows("authenticated", A, "select parcel_id from public.parcel_exclusions"); assert.equal(own.length, 2, "A reads only A's marks");
    for (const statement of ["select * from public.excluded_parcels()", `select public.exclude_parcel('${P3}')`, `select public.restore_parcel('${P1}')`]) {
      const denied = await err("anon", "", statement); assert.equal(denied.state, "42501", `anon must not execute: ${statement}`);
    }
    for (const statement of ["select * from public.excluded_parcels()", `select public.exclude_parcel('${P3}')`]) {
      assert.equal((await err("authenticated", "", statement)).state, "42501", "no signed-in owner is refused");
    }
  });
  test("R10 a visible row can be written", async () => {
    await reset(); await call(A, `public.exclude_parcel('${P1}')`);
    assert.deepEqual(await dml("authenticated", A, `update public.parcels set title='edited' where id='${P2}' returning id`), [{ id: P2 }]);
  });
  fixture.r11 = async () => {
    await reset(); await call(A, `public.exclude_parcel('${P1}')`);
    const out = await rows("authenticated", A, `select id,outcome from public.mark_parcels_received(array['${P1}','${P2}']::uuid[])`);
    assert.equal(out.find((r) => r.id === P1).outcome, "changed"); assert.equal(out.find((r) => r.id === P2).outcome, "written");
    assert.deepEqual(await suRows(`select status,received_at from public.parcels where id='${P1}'`), [{ status: "ordered", received_at: null }]);
    assert.deepEqual(await suRows("select parcel_id from public.parcel_receipt_undos"), [{ parcel_id: P2 }]);
  };
  test("R11 receive skips a marked parcel", fixture.r11);
  test("R12 clearing all parcels removes the marks", async () => {
    await reset(); await call(A, `public.exclude_parcel('${P1}')`); await call(B, `public.exclude_parcel('${PB1}')`);
    await sql(`select public.clear_all_parcels('${A}');`);
    assert.equal((await marks(`user_id='${A}'`)).length, 0); assert.equal((await marks(`user_id='${B}'`)).length, 1);
    assert.deepEqual(await suRows(`select count(*)::int as n from public.parcels where user_id='${A}'`), [{ n: 0 }]);
  });
  test("R13 a typed-in parcel", async () => {
    await reset(); assert.equal(await call(A, `public.exclude_parcel('${PM}')`), "manual");
    assert.equal(await call(A, `public.exclude_parcel('${PBM}')`), "gone"); assert.equal((await marks()).length, 0); assert.ok((await visible(A)).includes(PM));
  });
  fixture.r14 = async () => {
    await reset();
    const [receipt] = await rows("authenticated", A, `select id,outcome,receipt_id from public.mark_parcels_received(array['${P1}']::uuid[])`);
    assert.equal(receipt.outcome, "written"); await call(A, `public.exclude_parcel('${P1}')`);
    const out = await rows("authenticated", A, `select id,outcome from public.restore_parcel_receipts('[{"id":"${P1}","receipt_id":"${receipt.receipt_id}"}]'::jsonb)`);
    assert.deepEqual(out, [{ id: P1, outcome: "changed" }]);
    assert.equal((await suRows(`select status from public.parcels where id='${P1}'`))[0].status, "delivered");
  };
  test("R14 undoing a receipt does not bring back a marked parcel", fixture.r14);
  test("R15 a second press is ok; a rule mark becomes the person's", async () => {
    await reset();
    assert.equal(await call(A, `public.exclude_parcel('${P1}')`), "ok"); assert.equal(await call(A, `public.exclude_parcel('${P1}')`), "ok");
    assert.equal((await marks(`parcel_id='${P1}'`)).length, 1);
    await sql(`insert into public.parcel_exclusions(parcel_id,user_id,kind,from_domain,relevance,counted) values ('${P2}','${A}','rule','x.example','x',false)`);
    assert.equal(await call(A, `public.exclude_parcel('${P2}')`), "ok");
    const [m] = await marks(`parcel_id='${P2}'`); assert.deepEqual([m.kind, m.from_domain, m.relevance, m.counted], ["user", "shop2.example", "shipped", true]);
  });
  test("R16 first mail", async () => {
    await reset(); await addSample();
    for (const id of [P3, P4, P5, P6, P7]) assert.equal(await call(A, `public.exclude_parcel('${id}')`), "ok");
    const by = async (id) => (await marks(`parcel_id='${id}'`))[0];
    const m3 = await by(P3); assert.deepEqual([m3.from_domain, m3.relevance, m3.counted], ["old.example", "order", true], "oldest by sent_at, not by read time");
    const m4 = await by(P4); assert.deepEqual([m4.from_domain, m4.relevance, m4.counted], ["shop4.example", "order", true], "the sender's own copy is skipped");
    const m5 = await by(P5); assert.deepEqual([m5.from_domain, m5.relevance, m5.counted], [null, null, false], "no mail: never counted");
    assert.equal((await by(P6)).counted, false, "a shared domain is not counted");
    assert.equal((await by(P7)).counted, false, "a sample mail is not counted");
  });
  test("R17 the children of a marked parcel stay readable (intended)", async () => {
    await reset(); await call(A, `public.exclude_parcel('${P1}')`);
    assert.equal((await rows("authenticated", A, `select id from public.parcel_items where parcel_id='${P1}'`)).length, 1);
    assert.equal((await rows("authenticated", A, `select id from public.extractions where parcel_id='${P1}'`)).length, 1);
    assert.equal((await rows("authenticated", A, `select id from public.emails where id='${E(1)}'`)).length, 1);
  });
  test("R18 a mark owned by another user is refused", fixture.r18);

  test2("R-auto-1 an automatic mark hides too", fixture.rAuto1);
  test2("R-auto-2 the list shows the kind; its 11 columns", async () => {
    await reset(); await markRule(P1); await call(A, `public.exclude_parcel('${P2}')`);
    const list = await rows("authenticated", A, "select * from public.excluded_parcels()");
    assert.deepEqual(Object.fromEntries(list.map((r) => [r.parcel_id, r.kind])), { [P1]: "rule", [P2]: "user" });
    assert.deepEqual(Object.keys(list[0]).sort(), [...columns11].sort());
    assert.deepEqual(await rows("authenticated", B, "select parcel_id from public.excluded_parcels()"), []);
  });
  test2("R-auto-3 the row function", fixture.rAuto3);
  test2("R-auto-4 the seen time", fixture.rAuto4);
  test2("R-auto-5 the one statement", fixture.rAuto5);
  // A transaction holds the owner lock and moves the parcel on; the server's mark must wait for it and then see the new state.
  const heldParcelLock = async (statement, { expectWait, update = true }) => {
    await reset();
    const hold = interactive(`set application_name='excl-hold'; begin; select public.lock_parcel_owner('${A}'); ${update ? `update public.parcels set status='shipped' where id='${P1}';` : ""} select 'HELD';\n`);
    let worker;
    try {
      await waitFor(() => hold.state.stdout.includes("HELD"), "hold took the parcel owner lock", [hold]);
      worker = launch("psql", args, { input: preamble + "set application_name='excl-worker';" + actor("service_role", "", `select 'RESULT:'||(${statement})::text;`) });
      if (expectWait) {
        await waitFor(async () => Number(await scalar("select count(*) from pg_stat_activity a where a.application_name='excl-worker' and a.wait_event_type='Lock' and exists(select 1 from pg_stat_activity b where b.pid=any(pg_blocking_pids(a.pid)) and b.application_name='excl-hold');")) === 1,
          "mark_rule_exclusion waits behind the held parcel owner lock", [hold, worker]);
        assert.equal(worker.state.exited, false);
      } else await waitFor(() => worker.state.exited, "the mark does not wait", [hold]);
    } finally { hold.child.stdin.end("commit;\n"); healthy(await hold.complete); if (worker) healthy(await worker.complete); }
    return one(worker.state.stdout);
  };
  fixture.rAuto6 = async () => {
    const r = await heldParcelLock(`public.mark_rule_exclusion('${A}','${P1}','shop.example','order')`, { expectWait: true });
    assert.equal(r, 0, "after the update is committed the mark finds a shipped parcel and adds nothing");
    assert.equal((await marks()).length, 0);
  };
  test2("R-auto-6 the mark waits for an update under the same lock", fixture.rAuto6);
  // The update above also takes the sample generation fence, so it cannot tell whether the parcel owner lock itself is taken: hold that lock alone.
  fixture.rAuto6b = async () => {
    const r = await heldParcelLock(`public.mark_rule_exclusion('${A}','${P1}','shop.example','order')`, { expectWait: true, update: false });
    assert.equal(r, 1, "the lock holder changed nothing: the mark goes in once the lock is free"); assert.equal((await marks()).length, 1);
  };
  test2("R-auto-6b the mark takes the parcel owner lock itself", fixture.rAuto6b);
  test2("R-auto-7 would the next mail be marked", fixture.rAuto7);
  test2("U-compat a stage-1 call still works", fixture.uCompat);
  test2("R-restore-twice put back twice", fixture.restoreTwice);
  test2("C3 no deadlock between ingestion, exclude, restore and the server's mark", async () => {
    const run = uuid(950), email = E(60);
    for (let round = 0; round < 6; round += 1) {
      await reset();
      await sql(`begin; select public.lock_sample_owner('${A}');
        insert into public.emails(id,user_id,provider_email_id,from_domain,sent_at,processing_status,processing_run_id,processing_lease_until)
          values ('${email}','${A}','syn:e60','shop.example','2026-11-02T00:00:00Z','pending','${run}',clock_timestamp()+interval '360 seconds'); commit;`);
      const snap = one(await sql(`begin; set local role service_role; select 'RESULT:'||public.mail_parcel_snapshot('${A}')::text; commit;`));
      const row = snap.find((r) => r.id === P1); assert.ok(row, "snapshot has the parcel");
      const update = `begin; select set_config('request.headers',jsonb_build_object('x-otodoke-sample-user','${A}','x-otodoke-sample-generation',(select generation from public.sample_generations where user_id='${A}'))::text,true); set local role service_role;
        select 'RESULT:'||row_to_json(r)::text from public.update_mail_parcel(${quote(JSON.stringify(snap))}::jsonb,'${P1}',${quote(row.updated_at)}::timestamptz,'{"status":"shipped"}'::jsonb,null,'[]'::jsonb,'${email}','${run}') r; commit;`;
      const workers = [
        launch("psql", args, { input: preamble + update }),
        launch("psql", args, { input: preamble + actor("service_role", "", `select 'RESULT:'||public.mark_rule_exclusion('${A}','${P1}','shop.example','order');`) }),
        launch("psql", args, { input: preamble + actor("authenticated", A, `select 'RESULT:'||public.exclude_parcel('${P1}');`) }),
        launch("psql", args, { input: preamble + actor("authenticated", A, `select 'RESULT:'||public.restore_parcel('${P1}');`) }),
      ];
      const done = await Promise.all(workers.map((w) => w.complete));
      done.forEach((result, i) => {
        assert.equal(result.timedOut, false); assert.equal(result.signal, null);
        assert.doesNotMatch(result.stderr, /deadlock|40P01/i, `round ${round}: deadlock (worker ${i})`);
        assert.equal(result.code, 0, `round ${round}: worker ${i} failed: ${result.stderr}`);
      });
      assert.match(done[0].stdout, /"verdict":\s*"(ok|retry)"/, `round ${round}: the real ingestion update finished: ${done[0].stdout}`);
    }
  });

  // Lock order: with the owner's generation lock held elsewhere, the real writers must wait on it (they take it first).
  const heldSampleLock = async (label, statement, { expectWait }) => {
    await reset();
    const hold = interactive(`set application_name='excl-hold'; begin; select public.lock_sample_owner('${A}'); select 'HELD';\n`);
    let worker;
    try {
      await waitFor(() => hold.state.stdout.includes("HELD"), "hold took the owner's generation lock", [hold]);
      worker = launch("psql", args, { input: preamble + "set application_name='excl-worker';" + actor("authenticated", A, `select 'RESULT:'||(${statement})::text;`) });
      if (expectWait) {
        await waitFor(async () => Number(await scalar("select count(*) from pg_stat_activity a where a.application_name='excl-worker' and a.wait_event_type='Lock' and exists(select 1 from pg_stat_activity b where b.pid=any(pg_blocking_pids(a.pid)) and b.application_name='excl-hold');")) === 1,
          `${label} waits behind the held generation lock`, [hold, worker]);
        assert.equal(worker.state.exited, false);
      } else await waitFor(() => worker.state.exited, `${label} finishes without taking the generation lock`, [hold]);
    } finally { await release(hold); if (worker) healthy(await worker.complete); }
  };
  test("C1 lock order: both writers take the generation lock first", async () => {
    await heldSampleLock("exclude_parcel", `public.exclude_parcel('${P1}')`, { expectWait: true });
    await call(A, `public.exclude_parcel('${P1}')`);
    await heldSampleLock("restore_parcel", `public.restore_parcel('${P1}')`, { expectWait: true });
  });
  test("C2 no deadlock against user deletion, receive and each other", async () => {
    for (let round = 0; round < 8; round += 1) {
      await reset();
      const workers = [
        launch("psql", args, { input: preamble + actor("authenticated", A, `select 'RESULT:'||public.exclude_parcel('${P1}');`) }),
        launch("psql", args, { input: preamble + actor("authenticated", A, `select 'RESULT:'||public.restore_parcel('${P1}');`) }),
        launch("psql", args, { input: preamble + actor("authenticated", A, `select 'RESULT:'||count(*) from public.mark_parcels_received(array['${P2}']::uuid[]);`) }),
        launch("psql", args, { input: preamble + `delete from auth.users where id='${A}';` }),
      ];
      const done = await Promise.all(workers.map((w) => w.complete));
      for (const result of done) {
        assert.equal(result.timedOut, false); assert.equal(result.signal, null);
        assert.doesNotMatch(result.stderr, /deadlock|40P01/i, `round ${round}: deadlock`);
        if (result.code !== 0) assert.match(result.stderr, /\bERROR:\s+23503:/, `round ${round}: only "owner no longer exists" may fail: ${result.stderr}`);
      }
    }
  });

  const migrationFile = `supabase/migrations/${stem}.sql`;
  const migrationFile2 = `supabase/migrations/${stem2}.sql`;
  const record = () => sql(`insert into supabase_migrations.schema_migrations(version,name) values(${quote(stem.slice(0, 14))},${quote(stem.slice(15))}) on conflict(version) do nothing;`);
  const record2 = () => sql(`insert into supabase_migrations.schema_migrations(version,name) values(${quote(stem2.slice(0, 14))},${quote(stem2.slice(15))}) on conflict(version) do nothing;`);
  const reapplyAll = async () => { await file(migrationFile); await file(migrationFile2); };
  const restoreBody = () => scalar("select md5(prosrc) from pg_proc where proname='restore_parcel' and pronamespace='public'::regnamespace;");
  const run = async () => {
    assert.match(await command("initdb", ["--version"]), /PostgreSQL\) 17\./);
    await command("initdb", ["-D", data, "-U", "postgres", "--no-sync", "-c", "dynamic_shared_memory_type=mmap", "-c", "shared_memory_type=mmap"]);
    startAttempted = true;
    await command("pg_ctl", ["-D", data, "-l", path.join(scratch, "server.log"), "-t", "10", "-o",
      `-h 127.0.0.1 -p ${port} -c unix_socket_directories= -c dynamic_shared_memory_type=mmap -c shared_memory_type=mmap -c max_connections=50`, "start"], { timeout: 15_000 });
    assert.equal(await listening(), true); assert.equal(await scalar("show listen_addresses;"), "127.0.0.1");
    assert.equal(Number(await scalar("show port;")), port); assert.equal(await scalar("show data_directory;"), data);
    await file("tests/postgres/bootstrap.sql");
    await sql("create schema supabase_migrations; create table supabase_migrations.schema_migrations(version text primary key,name text,statements text[]);");
    for (const name of prior(await readdir(path.join(root, "supabase/migrations")))) {
      if (name === "20261106180000_screen_events_daily_purge.sql") {
        const source = await readFile(path.join(root, `supabase/migrations/${name}`), "utf8");
        const begin = source.indexOf("create or replace function public.is_shared_mail_domain"), end = source.indexOf("select cron.schedule");
        assert.ok(begin >= 0 && end > begin);
        await sql(source.slice(begin, end));
        await sql("create schema cron; create table cron.job(jobname text,command text,schedule text,active boolean); insert into cron.job values('otodoke-purge-old-screen-events','select public.purge_old_screen_events()','30 18 * * *',true);");
      } else {
        await file(`supabase/migrations/${name}`);
        await sql(`insert into supabase_migrations.schema_migrations(version,name) values(${quote(name.slice(0, 14))},${quote(name.slice(15, -4))}) on conflict(version) do nothing;`);
      }
    }
    // Supabase substrate, reproduced only in this disposable cluster, BEFORE the target migration:
    // existing parcel grants, and the default privileges Supabase hands every new public table and function.
    await sql("grant usage on schema public to authenticated,service_role; grant select,insert,update,delete on public.parcels to authenticated,service_role;");
    const owner = (await scalar("select current_user;")).replaceAll('"', '""');
    await sql(`alter default privileges for role "${owner}" in schema public grant all on tables to anon, authenticated, service_role;
      alter default privileges for role "${owner}" in schema public grant execute on functions to anon, authenticated, service_role;
      grant usage on schema public to anon;
      create table public.zz_default_probe(id int);`);
    assert.equal(await scalar("select has_table_privilege('anon','public.zz_default_probe','INSERT') and has_table_privilege('authenticated','public.zz_default_probe','DELETE');"), "t", "the default-privilege fixture must really grant (else R5 is vacuous)");
    await sql("drop table public.zz_default_probe;");
    await sql(`create function public.test_capture_error(p_sql text) returns jsonb language plpgsql as $$
      declare v_state text; v_message text; begin execute p_sql; return jsonb_build_object('state','00000','message','statement completed');
      exception when others then get stacked diagnostics v_state=returned_sqlstate,v_message=message_text;
        return jsonb_build_object('state',v_state,'message',v_message); end $$;`);
    await sql(`create function public.test_dml_rows(p_cmd text) returns jsonb language plpgsql as $$
      declare v jsonb; begin execute format('with c as (%s) select coalesce(jsonb_agg(to_jsonb(c)),''[]''::jsonb) from c',p_cmd) into v; return v; end $$;`);
    console.log("BOOTSTRAP: Supabase default privileges (tables all, functions execute) and parcel grants reproduced in the disposable cluster before the target migration");

    await reset(); preSnapshot = await snapshotRows();  // R0: the person's rows before the first migration
    const originals = {};
    for (const name of Object.keys(pinned)) originals[name] = await scalar(`select p.prosrc from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='${name}';`);
    for (const [name, md5] of Object.entries(pinned)) assert.equal(await scalar(`select md5(prosrc) from pg_proc where proname='${name}' and pronamespace='public'::regnamespace;`), md5, `${name}: 130000 body is what the migration pins`);
    await file(migrationFile); await record(); await file(migrationFile);  // twice: idempotent
    console.log("OK: migration applied twice (second run is a no-op rewrite) after the 130000/140000 prerequisites");
    for (const name of Object.keys(pinned)) {
      const body = await scalar(`select p.prosrc from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='${name}';`);
      assert.equal(body.replaceAll(added, ""), originals[name], `${name}: only the added conditions differ`);
      assert.equal(body.split(added).length - 1, 2);
    }
    console.log("OK: mark_parcels_received / restore_parcel_receipts differ from 130000 only by the added conditions (2 each)");
    const verified = verdictOf(await file(`supabase/verify/${stem}.sql`)); assert.equal(verified.verdict, "OK", `verify row: ${verified.cells}`);
    console.log("OK: supabase/verify/" + stem + ".sql verdict OK");
    await fixture.r0(); console.log("OK: R0 the person's parcel rows are the same before and after the first migration");
    assert.equal((await markRows()).length, 0, "no-backfill: the first migration made no mark on the existing parcels"); console.log("OK: no-backfill: the first migration made no mark on existing parcels");
    // Footprint: only the table, the policy, the trigger function and the three functions are new.
    assert.deepEqual((await suRows("select proname from pg_proc where pronamespace='public'::regnamespace and proname in ('exclude_parcel','restore_parcel','excluded_parcels','parcel_exclusion_owner_check') order by 1")).map((r) => r.proname),
      ["exclude_parcel", "excluded_parcels", "parcel_exclusion_owner_check", "restore_parcel"]);

    const applyStage2 = async () => {
      await reset(); await call(A, `public.exclude_parcel('${P1}')`); const marksBefore = await markRows();
      await file(migrationFile2); await record2(); await file(migrationFile2);  // twice: idempotent
      assert.deepEqual(await markRows(), marksBefore, "no-backfill: the first application of stage 2 adds no mark to existing rows");
      const v2 = verdict2Of(await file(`supabase/verify/${stem2}.sql`)); assert.equal(v2.verdict, "OK", `stage 2 verify row: ${v2.cells}`);
      console.log("OK: stage 2 migration applied twice; supabase/verify/" + stem2 + ".sql verdict OK");
    };
    if (!negative) {
      for (const [name, fn] of tests) { await fn(); console.log(`OK: ${name}`); }
      await applyStage2(); stage2 = true;
      assert.deepEqual((await suRows("select proname from pg_proc where pronamespace='public'::regnamespace and proname in ('has_open_auto_exclusion','mark_auto_excluded_seen','excluded_parcels_unseen','auto_exclusion_would_start','mark_rule_exclusion') order by 1")).map((x) => x.proname),
        ["auto_exclusion_would_start", "excluded_parcels_unseen", "has_open_auto_exclusion", "mark_auto_excluded_seen", "mark_rule_exclusion"]);
      for (const [name, fn] of tests) { await fn(); console.log(`OK: ${name} (stage 2)`); }
      for (const [name, fn] of tests2) { await fn(); console.log(`OK: ${name}`); }
      await fixture.downRemovesRule(await readFile(path.join(root, `supabase/rollback/${stem2}.down.sql`), "utf8")); console.log("OK: the stage-2 rollback removes the automatic marks and keeps the pressed ones");
      await fixture.noBackfill(() => file(migrationFile), () => file(migrationFile2)); console.log("OK: no-backfill: applying the migrations again, and stage 2 rollback then forward, create no mark on existing rows");
      // Stage 2 rollback: restore_parcel is the stage-1 body again, the new objects are gone, the stage-1 shapes did not move.
      const down2 = async () => {
        await file(`supabase/rollback/${stem2}.down.sql`);
        assert.equal(await restoreBody(), stage1Body, "rollback 2 restores the stage-1 restore_parcel body");
        assert.equal(await scalar("select to_regclass('public.excluded_seen') is null and to_regprocedure('public.mark_rule_exclusion(uuid,uuid,text,text)') is null and to_regprocedure('public.has_open_auto_exclusion()') is null and to_regprocedure('public.auto_exclusion_would_start(uuid)') is null;"), "t");
        assert.equal(await scalar("select to_regprocedure('public.exclude_parcel(uuid)') is not null and to_regclass('public.parcel_exclusions') is not null;"), "t");
        stage2 = false;
      };
      await down2();
      await tests.find(([n]) => n.startsWith("R6"))[1]();  // the stage-1 expectation ('gone' on a second restore) holds again
      console.log("OK: stage 2 rollback restores the stage-1 restore_parcel (R6 'gone' again) and removes the new objects");
      await file(migrationFile2); await file(`supabase/verify/${stem2}.sql`); stage2 = true; await fixture.restoreTwice();
      // Both rollbacks, newest first; then forward again.
      await down2();
      await file(`supabase/rollback/${stem}.down.sql`);
      for (const name of Object.keys(pinned)) assert.equal(await scalar(`select p.prosrc from pg_proc p where p.proname='${name}' and p.pronamespace='public'::regnamespace;`), originals[name], `${name}: rollback restores the 130000 body`);
      assert.equal(await scalar("select to_regclass('public.parcel_exclusions') is null and to_regprocedure('public.exclude_parcel(uuid)') is null;"), "t");
      await reapplyAll(); stage2 = true;
      console.log("OK: rollback restores the 130000 bodies and removes the table/functions; forward migrations apply again");
    } else {
      const red = async (label, check) => {
        let message = null;
        try { await check(); } catch (error) { message = String(error.message).split("\n")[0]; }
        assert.ok(message, `NEGATIVE CONTROL ${label} stayed green: the test cannot see this fault`);
        console.log(`NEGATIVE: ${label}: verdict=FAILED as expected (${message.slice(0, 120)})`);
      };
      // R0 (before any other test touches the rows): a hiding policy that hides everything is seen.
      await sql(`drop policy "hide excluded parcels" on public.parcels; create policy "hide excluded parcels" on public.parcels as restrictive for select to authenticated using (false);`);
      await red("R0 with a policy that hides every row", fixture.r0);
      await file(migrationFile); await fixture.r0();
      // 1. permissive instead of restrictive hides nothing: R1 and R4 go red.
      await sql(`drop policy "hide excluded parcels" on public.parcels; create policy "hide excluded parcels" on public.parcels for select to authenticated
        using (not exists (select 1 from public.parcel_exclusions e where e.parcel_id = parcels.id));`);
      await red("R1 with a permissive policy", fixture.r1); await red("R4 with a permissive policy", fixture.r4);
      await file(migrationFile); await fixture.r1(); await fixture.r4();
      // 2. the revokes missing under Supabase default privileges: R5 goes red.
      await sql("grant insert, update, delete on public.parcel_exclusions to authenticated; grant select on public.parcel_exclusions to anon;");
      await red("R5 with the revokes missing", fixture.r5);
      await file(migrationFile); await fixture.r5();
      // 3. without the owner check trigger a mismatched mark is accepted: R18 goes red.
      await sql("drop trigger parcel_exclusion_owner_check on public.parcel_exclusions;");
      await red("R18 without the owner check", fixture.r18);
      await file(migrationFile); await fixture.r18();
      // 4. an exclude_parcel / restore_parcel that does not take the generation lock does not wait behind it.
      for (const [fn, signature, statement] of [["exclude_parcel", "uuid", `public.exclude_parcel('${P1}')`], ["restore_parcel", "uuid", `public.restore_parcel('${P1}')`]]) {
        const real = await scalar(`select pg_get_functiondef('public.${fn}(${signature})'::regprocedure);`);
        const fake = real.replace("perform public.lock_sample_owner(v_user);", "");
        assert.notEqual(fake, real, `fake ${fn} must remove the actual lock call`);
        try {
          await sql(fake);
          await red(`C1 ${fn} without lock_sample_owner (it does not wait behind the held generation lock)`, () => heldSampleLock(fn, statement, { expectWait: true }));
        } finally { await file(migrationFile); }
        await heldSampleLock(fn, statement, { expectWait: true });
      }
      // 5. the receipt functions without the added skip (B-11r low 1): R11 and R14 go red.
      for (const [fn, signature, fixtureName] of [["mark_parcels_received", "uuid[]", "r11"], ["restore_parcel_receipts", "jsonb", "r14"]]) {
        const real = await scalar(`select pg_get_functiondef('public.${fn}(${signature})'::regprocedure);`);
        const fake = real.replaceAll(added, "");
        assert.notEqual(fake, real, `fake ${fn} must remove the added conditions`);
        try { await sql(fake); await red(`${fixtureName.toUpperCase()} ${fn} without the skip of marked rows`, fixture[fixtureName]); } finally { await file(migrationFile); }
        await fixture[fixtureName]();
      }

      // ---- stage 2 ----
      await applyStage2(); stage2 = true;
      const fake = async (signature, changes) => {
        const real = await scalar(`select pg_get_functiondef('${signature}'::regprocedure);`);
        let text = real;
        for (const [from, to] of changes) { assert.ok(text.includes(from), `fake of ${signature}: "${from}" must be in the real function`); text = text.replace(from, to); }
        assert.notEqual(text, real); await sql(text);
      };
      const fault = async (label, fixtureFn, make) => {
        try { await make(); await red(label, fixtureFn); } finally { await reapplyAll(); }
        await fixtureFn();
      };
      await fault("R-auto-1 with a permissive policy", fixture.rAuto1, () => sql(`drop policy "hide excluded parcels" on public.parcels; create policy "hide excluded parcels" on public.parcels for select to authenticated
        using (not exists (select 1 from public.parcel_exclusions e where e.parcel_id = parcels.id));`));
      const hasOpen = "public.has_open_auto_exclusion()";
      await fault("R-auto-3 has_open without the arrived/cancelled filter", fixture.rAuto3, () => fake(hasOpen, [["and p.status not in ('delivered','cancelled')", ""]]));
      await fault("R-auto-3 has_open counting the person's own marks", fixture.rAuto3, () => fake(hasOpen, [["x.kind='rule' and ", ""]]));
      await fault("R-auto-4 has_open ignoring the seen time", fixture.rAuto4, () => fake(hasOpen, [["and (v_seen is null or x.created_at>v_seen)", ""]]));
      await fault("R-auto-4 unseen ignoring the seen time", fixture.rAuto4, () => fake("public.excluded_parcels_unseen()", [["(v_seen is null or x.created_at>v_seen)", "true"]]));
      await fault("R-auto-4 seen time not rounded to now()", fixture.rAuto4, () => fake("public.mark_auto_excluded_seen(timestamptz)", [["least(p_seen_until,now())", "p_seen_until"]]));
      await fault("R-auto-4 seen time moving back", fixture.rAuto4, () => fake("public.mark_auto_excluded_seen(timestamptz)", [["greatest(s.auto_excluded_seen_at,excluded.auto_excluded_seen_at)", "excluded.auto_excluded_seen_at"]]));
      await fault("R-auto-4 a null time reaching least()", fixture.rAuto4, () => fake("public.mark_auto_excluded_seen(timestamptz)", [["if p_seen_until is null or not isfinite(p_seen_until) then", "if false then"]]));
      await fault("R-auto-4 excluded_seen writable by the person", fixture.rAuto4, () => sql("grant insert, update, delete on public.excluded_seen to authenticated;"));
      const rule = "public.mark_rule_exclusion(uuid,uuid,text,text)";
      await fault("R-auto-5 mark without the status condition", fixture.rAuto5, () => fake(rule, [["and p.status in ('unknown','ordered')", ""]]));
      await fault("R-auto-5 mark without the carrier condition", fixture.rAuto5, () => fake(rule, [["and p.tracking_number is null and p.carrier is null", "and p.tracking_number is null"]]));
      await fault("R-auto-5 mark without the expected_text condition", fixture.rAuto5, () => fake(rule, [[" and p.expected_text is null", ""]]));
      await fault("R-auto-5 mark without the window end condition", fixture.rAuto5, () => fake(rule, [[" and p.expected_window_end is null", ""]]));
      await fault("R-auto-5 mark without the owner condition", fixture.rAuto5, () => fake(rule, [["and p.user_id=p_user", ""]]));
      await fault("R-auto-5 mark executable by the person", fixture.rAuto5, () => sql("grant execute on function public.mark_rule_exclusion(uuid,uuid,text,text) to authenticated;"));
      await fault("R-auto-6b mark without the parcel owner lock", fixture.rAuto6b, () => fake(rule, [["perform public.lock_parcel_owner(p_user);", ""]]));
      await fault("R-auto-6 mark that ignores a shipped parcel after the wait", fixture.rAuto6, () => fake(rule, [["and p.status in ('unknown','ordered')", ""]]));
      const would = "public.auto_exclusion_would_start(uuid)";
      await fault("R-auto-7 would_start without the never-automatic list", fixture.rAuto7, () => fake(would, [["if v_domain = any(array['mail.yahoo.co.jp']) then return false; end if;", ""]]));
      await fault("R-auto-7 would_start counting one mark", fixture.rAuto7, () => fake(would, [["x.relevance=v_relevance) < 2", "x.relevance=v_relevance) < 1"]]));
      await fault("R-auto-7 would_start ignoring unmarked parcels of the domain", fixture.rAuto7, () => fake(would, [["if exists(select 1 from public.parcels p where p.user_id=v_user", "if false and exists(select 1 from public.parcels p where p.user_id=v_user"]]));
      await fault("R-auto-7 would_start ignoring the kind of mail", fixture.rAuto7, () => fake(would, [["if v_relevance not in ('order','payment') then return false; end if;", ""]]));
      await fault("R-auto-7 would_start that writes", fixture.rAuto7, () => fake(would, [["\n STABLE", ""], ["  return true;\nend $function$", "  update public.parcel_exclusions set created_at=now() where parcel_id=p_parcel_id; return true;\nend $function$"]]));
      await fault("R-restore-twice restore answering 'gone' for an unmarked parcel", fixture.restoreTwice, () => fake("public.restore_parcel(uuid)", [["x.user_id=v_user;", "x.user_id=v_user; if not found then return 'gone'; end if;"]]));
      // U-compat: an exclude_parcel that changes its return type, and an excluded_parcels with other columns.
      try {
        await sql("drop function public.exclude_parcel(uuid); create function public.exclude_parcel(p uuid) returns jsonb language sql as $$ select '\"ok\"'::jsonb $$;");
        await red("U-compat with exclude_parcel returning another type", fixture.uCompat);
      } finally { await sql("drop function if exists public.exclude_parcel(uuid);"); await reapplyAll(); }
      await fixture.uCompat();
      try {
        await sql("drop function public.excluded_parcels(); create function public.excluded_parcels() returns table(parcel_id uuid, kind text, excluded_at timestamptz, unseen boolean) language sql as $$ select null::uuid,null::text,null::timestamptz,false where false $$;");
        await red("U-compat with excluded_parcels returning other columns", fixture.uCompat);
      } finally { await sql("drop function if exists public.excluded_parcels();"); await reapplyAll(); }
      await fixture.uCompat();
      // The stage-2 rollback: one that leaves the automatic marks, one that removes the pressed marks too.
      const downText = await readFile(path.join(root, `supabase/rollback/${stem2}.down.sql`), "utf8");
      const ruleDelete = "delete from public.parcel_exclusions where kind='rule';";
      assert.ok(downText.includes(ruleDelete));
      for (const [label, text] of [["leaves the automatic marks", downText.replace(ruleDelete, "")], ["removes the pressed marks too", downText.replace(ruleDelete, "delete from public.parcel_exclusions;")]]) {
        try { await red(`down-removes-rule with a rollback that ${label}`, () => fixture.downRemovesRule(text)); } finally { await reapplyAll(); await sql("delete from public.parcel_exclusions;"); }
      }
      await fixture.downRemovesRule(downText);
      // No backfill: a migration that marks existing rows by itself is seen (each of the two migrations in turn).
      const bad1 = await backfilling(stem), bad2 = await backfilling(stem2);
      for (const [label, apply1, apply2] of [["stage 1", () => sql(bad1), () => file(migrationFile2)], ["stage 2", () => file(migrationFile), () => sql(bad2)]]) {
        try { await red(`no-backfill with a ${label} migration that marks existing parcels`, () => fixture.noBackfill(apply1, apply2)); } finally { await reapplyAll(); await sql("delete from public.parcel_exclusions;"); }
      }
      await fixture.noBackfill(() => file(migrationFile), () => file(migrationFile2));
    }
  };
  try { await run(); } finally { await cleanup(); }
  // The verdict is the LAST line, printed only after the cluster is stopped and deleted.
  console.log(`verdict=OK mode=${negative ? "negative-control" : "positive"}`);
}

const help = `Usage: node tests/postgres/run-parcel-exclusions.mjs [--self-test | --negative-control]
(no flag): start a disposable PostgreSQL on 127.0.0.1:${port}, apply the real migrations, run R1-R18 and the lock tests.
--self-test: no PostgreSQL; checks the judge/parsers and the migration source guards.
--negative-control: inject each fault (permissive policy, missing revokes, missing owner check, missing generation lock) and require the matching test to go red.
Success is the last line "verdict=OK" together with exit code 0.`;
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const flags = process.argv.slice(2);
  if (flags.some((flag) => !["--help", "--self-test", "--negative-control"].includes(flag)) || flags.length > 1) { console.error(help); process.exitCode = 2; }
  else if (flags.includes("--help")) console.log(help);
  else (flags.includes("--self-test") ? selfTest() : main(flags.includes("--negative-control"))).then(() => { if (flags.includes("--self-test")) console.log("verdict=OK mode=self-test"); }).catch((error) => {
    console.error(`verdict=FAILED ${error.stack ?? error}`); process.exitCode = 1;
  });
}
