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
const port = 65449;
const bin = process.env.OTODOKE_PG_BINDIR ?? "";
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const A = uuid(1), B = uuid(2);
const P1 = uuid(101), P2 = uuid(102), PM = uuid(103), P3 = uuid(104), P4 = uuid(105), P5 = uuid(106), P6 = uuid(107), P7 = uuid(108), PB1 = uuid(201), PBM = uuid(202);
const E = (n) => uuid(300 + n);
const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const added = " and not exists(select 1 from public.parcel_exclusions e where e.parcel_id=p.id)";
const pinned = { mark_parcels_received: "266c7b11c6af28f28aa06cd435315db8", restore_parcel_receipts: "19d60a59dcb759c1f51b55d507d1dec8" };
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

  const tests = [];
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
    assert.equal(await call(A, `public.restore_parcel('${P1}')`), "gone"); assert.equal((await marks()).length, 0);
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
  test("R11 receive skips a marked parcel", async () => {
    await reset(); await call(A, `public.exclude_parcel('${P1}')`);
    const out = await rows("authenticated", A, `select id,outcome from public.mark_parcels_received(array['${P1}','${P2}']::uuid[])`);
    assert.equal(out.find((r) => r.id === P1).outcome, "changed"); assert.equal(out.find((r) => r.id === P2).outcome, "written");
    assert.deepEqual(await suRows(`select status,received_at from public.parcels where id='${P1}'`), [{ status: "ordered", received_at: null }]);
    assert.deepEqual(await suRows("select parcel_id from public.parcel_receipt_undos"), [{ parcel_id: P2 }]);
  });
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
  test("R14 undoing a receipt does not bring back a marked parcel", async () => {
    await reset();
    const [receipt] = await rows("authenticated", A, `select id,outcome,receipt_id from public.mark_parcels_received(array['${P1}']::uuid[])`);
    assert.equal(receipt.outcome, "written"); await call(A, `public.exclude_parcel('${P1}')`);
    const out = await rows("authenticated", A, `select id,outcome from public.restore_parcel_receipts('[{"id":"${P1}","receipt_id":"${receipt.receipt_id}"}]'::jsonb)`);
    assert.deepEqual(out, [{ id: P1, outcome: "changed" }]);
    assert.equal((await suRows(`select status from public.parcels where id='${P1}'`))[0].status, "delivered");
  });
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
  const record = () => sql(`insert into supabase_migrations.schema_migrations(version,name) values(${quote(stem.slice(0, 14))},${quote(stem.slice(15))}) on conflict(version) do nothing;`);
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
    // Footprint: only the table, the policy, the trigger function and the three functions are new.
    assert.deepEqual((await suRows("select proname from pg_proc where pronamespace='public'::regnamespace and proname in ('exclude_parcel','restore_parcel','excluded_parcels','parcel_exclusion_owner_check') order by 1")).map((r) => r.proname),
      ["exclude_parcel", "excluded_parcels", "parcel_exclusion_owner_check", "restore_parcel"]);

    if (!negative) {
      for (const [name, fn] of tests) { await fn(); console.log(`OK: ${name}`); }
      // Rollback restores the 130000 bodies and un-hides; then forward again.
      await file(`supabase/rollback/${stem}.down.sql`);
      for (const name of Object.keys(pinned)) assert.equal(await scalar(`select p.prosrc from pg_proc p where p.proname='${name}' and p.pronamespace='public'::regnamespace;`), originals[name], `${name}: rollback restores the 130000 body`);
      assert.equal(await scalar("select to_regclass('public.parcel_exclusions') is null and to_regprocedure('public.exclude_parcel(uuid)') is null;"), "t");
      await file(migrationFile);
      console.log("OK: rollback restores the 130000 bodies and removes the table/functions; forward migration applies again");
    } else {
      const red = async (label, check) => {
        let message = null;
        try { await check(); } catch (error) { message = String(error.message).split("\n")[0]; }
        assert.ok(message, `NEGATIVE CONTROL ${label} stayed green: the test cannot see this fault`);
        console.log(`NEGATIVE: ${label}: verdict=FAILED as expected (${message.slice(0, 120)})`);
      };
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
