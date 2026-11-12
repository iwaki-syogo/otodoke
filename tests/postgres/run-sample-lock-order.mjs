import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cleanEnvironment } from "./run-parcel-conflicts.mjs";
import { taggedResults } from "./run-cost-guards.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const target = "20261113110000_sample_generation.sql";
const legacy = "20261113100000_parcel_write_conflicts.sql";
const functions = ["create_mail_parcel", "update_mail_parcel", "ensure_mail_parcel_items"];
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const user = uuid(1);
const other = uuid(2);
const parcel = uuid(30);
const otherParcel = uuid(31);
const emails = [10, 11, 12].map(uuid);
const runs = [20, 21, 22].map(uuid);
const gate = "183765134, 1";
const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
const json = (value) => `${quote(JSON.stringify(value))}::jsonb`;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const prefix = "otodoke-sample-lock-";
const items = [{ name: "Synthetic parcel item", quantity: 1, unit_price: 1000, evidence: "Synthetic" }];

export function trialCount(value = "360") {
  const count = Number(value);
  assert.ok(Number.isSafeInteger(count) && count >= 360 && count <= 2000, "natural trials must be an integer from 360 to 2000");
  return count;
}

export function migrationFiles(names) {
  return names.filter((name) => /^\d{14}_.+\.sql$/.test(name) && (name.slice(0, 14) < target.slice(0, 14) || name === target)).sort();
}

export function originalFunctions(source) {
  return functions.map((name) => {
    const found = source.match(new RegExp(`^create or replace function public\\.${name}\\([\\s\\S]+?end \\$\\$;`, "m"));
    assert.ok(found, `original ${name} must exist`);
    assert.match(found[0], /for update;[\s\S]+public\.lock_parcel_owner\(v_mail\.user_id\)/);
    assert.doesNotMatch(found[0], /pg_advisory_xact_lock/);
    assert.doesNotMatch(found[0], /lock_sample_owner|assert_sample_generation/);
    return found[0];
  });
}

export function classify(result, worker) {
  if (result.timedOut || result.signal) return { kind: "timeout", signal: result.signal ?? "deadline" };
  const errors = [...result.stderr.matchAll(/\b(?:ERROR|FATAL|PANIC):\s+([A-Z0-9]{5}):/g)].map((m) => m[1]);
  if (errors.length || result.code !== 0 || /\b(?:ERROR|FATAL|PANIC):/i.test(result.stderr)) {
    const state = errors.length === 1 ? errors[0] : "unparsed";
    if (state === "40P01") return { kind: "deadlock", state };
    if (["55P03", "57014"].includes(state)) return { kind: "timeout", state };
    const lease = state === "42501" && /mail run no longer owns the lease/.test(result.stderr);
    const generation = state === "55000" && /sample (?:load was cleared; load it again|generation or owner is missing)/.test(result.stderr);
    if (worker.kind !== "clear" && (lease || (worker.sample && generation))) return { kind: "expected_refusal", state };
    return { kind: "sql_error", state, message: result.stderr.split(/\r?\n/).find((line) => /ERROR|FATAL|PANIC/.test(line)) ?? `process exit ${result.code}` };
  }
  const tagged = taggedResults(result.stdout);
  if (tagged.length !== 1) return { kind: "invalid_result", message: `expected one result, got ${tagged.length}` };
  try {
    const value = JSON.parse(tagged[0]);
    if (worker.kind === "clear" && value.verdict === "cleared" && /^[0-9a-f-]{36}$/.test(value.generation)) return { kind: "ok", value };
    if (worker.kind !== "clear" && ["ok", "retry"].includes(value.verdict)) return { kind: value.verdict, value };
    return { kind: "invalid_result", message: "unexpected verdict" };
  } catch { return { kind: "invalid_result", message: "malformed JSON result" }; }
}

function one(output) {
  const results = taggedResults(output);
  assert.equal(results.length, 1, "query must return exactly one tagged result");
  return JSON.parse(results[0]);
}

export function startChild(executable, args, { environment, input, interactive = false, timeout = 20_000 } = {}) {
  const child = spawn(executable, args, { cwd: root, env: environment, stdio: ["pipe", "pipe", "pipe"] });
  const state = { stdout: "", stderr: "", code: null, signal: null, timedOut: false, exited: false };
  const timer = setTimeout(() => { state.timedOut = true; child.kill("SIGTERM"); }, timeout);
  child.stdin.on("error", () => {});
  child.stdout.on("data", (chunk) => { state.stdout += chunk; });
  child.stderr.on("data", (chunk) => { state.stderr += chunk; });
  const complete = new Promise((resolve) => {
    child.on("error", (error) => { state.stderr += error.message; });
    child.on("close", (code, signal) => { clearTimeout(timer); Object.assign(state, { code, signal, exited: true }); resolve(state); });
  });
  if (interactive) child.stdin.write(input);
  else child.stdin.end(input);
  return { child, state, complete };
}

function workerQuery(kind, seeded) {
  const at = quote(seeded.version);
  const snap = json(seeded.snapshot);
  const mailIds = seeded.emails ?? emails;
  const runIds = seeded.runs ?? runs;
  if (kind === "clear") return `select 'RESULT:' || jsonb_build_object('verdict','cleared','generation',public.clear_all_parcels('${user}'))::text;`;
  if (kind === "create-shipped") return `select 'RESULT:' || row_to_json(r)::text from public.create_mail_parcel(${snap},${json({ user_id: user, shop: "Synthetic shop", order_number: "SYNTHETIC-NEW", status: "shipped" })},${json(items)},'${mailIds[0]}','${runIds[0]}') r;`;
  if (kind === "ensure") return `select 'RESULT:' || row_to_json(r)::text from (select * from public.ensure_mail_parcel_items('${parcel}',${at}::timestamptz,${json(items)},'${mailIds[0]}','${runIds[0]}')) r;`;
  const index = kind === "update-delivered" ? 2 : 1;
  const values = kind === "update-delivered" ? { status: "delivered", last_email_at: "2026-11-12T02:00:00Z" } : { status: "shipped", last_email_at: "2026-11-12T01:00:00Z" };
  return `select 'RESULT:' || row_to_json(r)::text from public.update_mail_parcel(${snap},'${parcel}',${at}::timestamptz,${json(values)},null,'[]'::jsonb,'${mailIds[index]}','${runIds[index]}') r;`;
}

function header(sample, generation) {
  const value = sample ? { "x-otodoke-sample-user": user, "x-otodoke-sample-generation": generation } : {};
  return `set local request.headers=${quote(JSON.stringify(value))};`;
}

async function selfTest() {
  assert.equal(trialCount(), 360);
  for (const value of ["", "0", "359", "360.5", "NaN", "2001"]) assert.throws(() => trialCount(value));
  assert.deepEqual(migrationFiles([target, legacy, "20261113110000_another.sql", "20261113120000_future.sql", "notes.md"]), [legacy, target]);
  const env = cleanEnvironment("synthetic-scratch", { PGHOST: "remote.invalid", PGPORT: "5432", PGSERVICE: "production", PGPASSWORD: "unused", PATH: "test" });
  assert.equal(env.PGHOST, undefined);
  assert.equal(env.PGPASSWORD, undefined);
  assert.equal(env.PGSERVICE, undefined);
  assert.equal(env.PGPASSFILE, path.join("synthetic-scratch", "no-password-file"));
  const result = (changes) => ({ code: 0, signal: null, timedOut: false, stdout: 'RESULT:{"verdict":"ok"}\n', stderr: "", ...changes });
  const mail = { kind: "create-shipped", sample: true };
  assert.equal(classify(result({}), mail).kind, "ok");
  assert.equal(classify(result({ stderr: "ERROR:  40P01: deadlock detected", code: 3 }), mail).kind, "deadlock");
  assert.equal(classify(result({ stderr: "ERROR:  55P03: canceling statement due to lock timeout", code: 3 }), mail).kind, "timeout");
  assert.equal(classify(result({ stderr: "ERROR:  57014: canceling statement due to statement timeout", code: 3 }), mail).kind, "timeout");
  assert.equal(classify(result({ stderr: "ERROR:  42501: mail run no longer owns the lease", code: 3 }), mail).kind, "expected_refusal");
  assert.equal(classify(result({ stderr: "ERROR:  42501: permission denied", code: 3 }), mail).kind, "sql_error");
  assert.equal(classify(result({ stderr: "ERROR:  55000: sample load was cleared; load it again", code: 3 }), mail).kind, "expected_refusal");
  assert.equal(classify(result({ stderr: "ERROR:  55000: sample load was cleared; load it again", code: 3 }), { ...mail, sample: false }).kind, "sql_error");
  assert.equal(classify(result({ stderr: "ERROR:  42501: mail run no longer owns the lease", code: 3 }), { kind: "clear" }).kind, "sql_error");
  assert.equal(classify(result({ stderr: "ERROR:  40P01: deadlock detected", timedOut: true }), mail).kind, "timeout");
  for (const stdout of ["", "RESULT:{}\n", 'RESULT:{"verdict":"ok"}\nRESULT:{"verdict":"ok"}\n', "RESULT:broken\n"]) assert.equal(classify(result({ stdout }), mail).kind, "invalid_result");
  assert.equal(classify(result({ stderr: "ERROR:  42601: syntax error" }), mail).kind, "sql_error");
  assert.equal(classify(result({ code: 2, stderr: "connection failed" }), mail).kind, "sql_error");
  const source = await readFile(path.join(root, "supabase/migrations", legacy), "utf8");
  assert.equal(originalFunctions(source).length, 3);
  assert.throws(() => originalFunctions(source.replace("public.create_mail_parcel(", "public.missing_create(")));
  assert.throws(() => originalFunctions(source.replaceAll("public.lock_parcel_owner(v_mail.user_id)", "pg_catalog.pg_advisory_xact_lock(62803,0)")), "an old global key is not the shared-helper lock-order negative control");
  assert.match(workerQuery("ensure", { snapshot: [], version: "2026-11-12T00:00:00Z" }), /from \(select \* from public\.ensure_mail_parcel_items/);
  const dummy = (source, options = {}) => startChild(process.execPath, ["-e", source], options).complete;
  assert.equal(classify(await dummy("process.stdout.write('RESULT:{\"verdict\":\"ok\"}\\n')"), mail).kind, "ok");
  assert.equal(classify(await dummy("process.stderr.write('ERROR:  42601: synthetic error\\n')"), mail).kind, "sql_error");
  assert.equal(classify(await dummy("process.exit(1)"), mail).kind, "sql_error");
  assert.equal(classify(await dummy("setTimeout(() => {}, 10000)", { timeout: 20 }), mail).kind, "timeout");
  console.log("OK: self-test (360 minimum, PG isolation, SQLSTATE classification, timeouts/missing results fail, original RPC extraction, single-column result shape)");
  console.log("NOT RUN: PostgreSQL migrations or concurrency");
}

async function main(negative, controlsOnly = false) {
  assert.ok(process.argv.includes("--external-test-server"), "use --external-test-server for an explicitly supplied disposable loopback cluster");
  const port = Number(process.env.OTODOKE_SAMPLE_PG_PORT);
  assert.ok(Number.isSafeInteger(port) && port >= 1024 && port <= 65535, "OTODOKE_SAMPLE_PG_PORT must name the dedicated test server port");
  const rounds = trialCount(process.env.OTODOKE_SAMPLE_LOCK_ROUNDS ?? "360");
  const parent = path.join(root, ".vitest/pg");
  await mkdir(parent, { recursive: true });
  const scratch = await mkdtemp(path.join(parent, "sample-lock-"));
  const environment = cleanEnvironment(scratch);
  const executable = path.join(process.env.OTODOKE_PG_BINDIR ?? "", "psql");
  const database = `otodoke_lock_order_${Date.now()}_${process.pid}`;
  let databaseCreated = false;
  assert.match(database, /^otodoke_lock_order_\d+_\d+$/);
  const args = (db) => ["-X", "-w", "-q", "-A", "-t", "-h", "127.0.0.1", "-p", String(port), "-U", "postgres", "-d", db, "-v", "ON_ERROR_STOP=1", "-v", "VERBOSITY=verbose"];
  const children = new Set();
  let interrupted = false;
  const launch = (input, { db = database, interactive = false, timeout = 20_000 } = {}) => {
    assert.equal(interrupted, false, "runner was interrupted");
    const handle = startChild(executable, args(db), { environment, input, interactive, timeout });
    children.add(handle.child);
    handle.complete.then(() => children.delete(handle.child));
    return handle;
  };
  const preamble = "set statement_timeout='12s'; set lock_timeout='8s'; set deadlock_timeout='100ms';\n";
  const sql = async (input, db = database) => {
    const result = await launch(preamble + input, { db }).complete;
    assert.equal(result.timedOut, false, "psql timed out");
    assert.equal(result.code, 0, result.stderr || "psql failed");
    assert.doesNotMatch(result.stderr, /\b(?:ERROR|FATAL|PANIC):/i);
    return result.stdout;
  };
  const scalar = async (input) => (await sql(input)).trim();
  const waitFor = async (check, label, handles = []) => {
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      if (await check()) return;
      for (const handle of handles) assert.equal(handle.state.exited, false, `worker exited before ${label}: ${handle.state.stderr}`);
      await delay(5);
    }
    throw new Error(`timeout waiting for ${label}; not counted as a completed trial`);
  };
  const summary = { mode: negative ? "negative-control" : controlsOnly ? "controls-only" : "natural", trials_started: 0, trials_completed: 0, operations_started: 0, operations_completed: 0,
    outcomes: { ok: 0, retry: 0, expected_refusal: 0, deadlock: 0, sql_error: 0, timeout: 0, invalid_result: 0 }, sqlstates: {}, gate_workers_observed: 0, production_waiters_observed: 0,
    controls: { single: 0, old_lease_refusal: 0, fresh_intake: 0, fresh_parcel: 0 }, target_sha256: null, negative_source_sha256: null,
    sql_sha256: {}, sql_source: "working tree", negative_order: negative ? "local 100000 E -> per-user L -> 110000 G, without the public G prefix" : null };
  const record = (value) => {
    summary.operations_completed++;
    summary.outcomes[value.kind]++;
    if (value.state) summary.sqlstates[value.state] = (summary.sqlstates[value.state] ?? 0) + 1;
  };
  const seed = async (sample) => one(await sql(`select public.clear_all_parcels('${user}'); select public.clear_all_parcels('${other}');
    begin;
    select set_config('request.headers',jsonb_build_object('x-otodoke-sample-user','${other}',
      'x-otodoke-sample-generation',public.begin_sample_load('${other}'))::text,true);
    insert into public.parcels(id,user_id,shop,status) values('${otherParcel}','${other}','Other synthetic shop','ordered');
    commit; begin;
    select set_config('request.headers',jsonb_build_object('x-otodoke-sample-user','${user}',
      'x-otodoke-sample-generation',public.begin_sample_load('${user}'))::text,true);
    insert into public.emails(id,user_id,provider_email_id,processing_status,processing_run_id,processing_lease_until) values
      ${emails.map((email, index) => `('${email}','${user}','${sample ? "demo:" : "synthetic:"}lock-${index}','pending','${runs[index]}',clock_timestamp()+interval '360 seconds')`).join(",")};
    insert into public.parcels(id,user_id,shop,status) values('${parcel}','${user}','Synthetic shop','ordered');
    select 'RESULT:' || jsonb_build_object('snapshot',public.mail_parcel_snapshot('${user}'),'version',(select updated_at from public.parcels where id='${parcel}'),
      'generation',(select generation from public.sample_generations where user_id='${user}'),
      'other_generation',(select generation from public.sample_generations where user_id='${other}'))::text; commit;`));
  const workersFor = (seeded, sample) => ["clear", "create-shipped", "update-shipped", "update-delivered"].map((kind) => ({ kind, sample: kind !== "clear" && sample, query: workerQuery(kind, seeded) }));
  const controls = async () => {
    for (const kind of ["create-shipped", "update-shipped", "update-delivered", "ensure", "clear"]) {
      const seeded = await seed(false);
      const value = classify(await launch(preamble + `begin; set local role service_role; ${header(false)} ${workerQuery(kind, seeded)} commit;`).complete, { kind, sample: false });
      assert.equal(value.kind, "ok", `single control ${kind}: ${JSON.stringify(value)}`);
      summary.controls.single++;
    }
    console.log("OK: single controls executed actual create/shipped-update/delivered-update/ensure/clear queries");
  };
  const postClearControls = async () => {
    for (const sample of [false, true]) {
      const seeded = await seed(sample);
      const cleared = one(await sql(`begin; set local role service_role; ${header(false)} ${workerQuery("clear", seeded)} commit;`));
      assert.notEqual(cleared.generation, seeded.generation, "clear must rotate this generation");
      for (const kind of ["create-shipped", "update-shipped", "ensure"]) {
        const value = classify(await launch(preamble + `begin; set local role service_role; ${header(sample, seeded.generation)} ${workerQuery(kind, seeded)} commit;`).complete, { kind, sample });
        assert.equal(value.kind, "expected_refusal", `old cleared ${kind} lease must fail: ${JSON.stringify(value)}`);
        summary.controls.old_lease_refusal++;
      }
      const freshMail = uuid(13);
      const freshRun = uuid(23);
      const intake = one(await sql(`begin; set local role service_role; ${header(sample, cleared.generation)}
        select 'RESULT:' || row_to_json(r)::text from public.store_mail_run('${user}','${freshMail}','${freshRun}',
        ${json({ provider_email_id: `${sample ? "demo:" : "synthetic:"}fresh-after-clear`, processing_status: "pending", text_body: "Synthetic new arrival", body_state: "plain" })},null,
        ${json({ user_count: 1000, global_count: 1000, user_bytes: 1000000, global_bytes: 1000000 })}) r; commit;`));
      assert.equal(intake.verdict, "ok");
      summary.controls.fresh_intake++;
      const fresh = { ...seeded, snapshot: [], emails: [freshMail], runs: [freshRun] };
      const created = one(await sql(`begin; set local role service_role; ${header(sample, cleared.generation)} ${workerQuery("create-shipped", fresh)} commit;`));
      assert.equal(created.verdict, "ok", "a new arrival after clear must create its parcel");
      summary.controls.fresh_parcel++;
      assert.equal(Number(await scalar(`select count(*) from public.parcels where id='${otherParcel}' and user_id='${other}';`)), 1);
      assert.equal(await scalar(`select generation from public.sample_generations where user_id='${other}';`), seeded.other_generation);
    }
    console.log("OK: after-clear old leases rejected, real/sample new intake and parcel creation accepted, other user/generation preserved");
  };
  const synchronizedNegative = async (kind) => {
    const seeded = await seed(false);
    const clearName = `${prefix}negative-clear`;
    const writerName = `${prefix}negative-writer`;
    // Use the actual owner/auth-row -> generation prefix, including any cascade protection.
    // Only then run clear's remaining production path to 62803; no unrelated lock is added.
    const clearer = launch(preamble + `set application_name='${clearName}'; begin; select public.lock_sample_owner('${user}'); select 'GENERATION-HELD';\n`, { interactive: true });
    await waitFor(() => clearer.state.stdout.includes("GENERATION-HELD"), "clear generation row lock", [clearer]);
    const writer = launch(preamble + `set application_name='${writerName}'; begin; set local role service_role; ${header(false)} ${workerQuery(kind, seeded)} commit;`);
    summary.trials_started++;
    summary.operations_started += 2;
    await waitFor(async () => Number(await scalar(`select count(*) from pg_stat_activity a join pg_locks l on l.pid=a.pid where a.application_name='${writerName}' and a.datname=current_database()
      and a.wait_event_type='Lock' and a.wait_event in ('transactionid','tuple')
      and exists(select 1 from pg_stat_activity b where b.pid=any(pg_blocking_pids(a.pid)) and b.application_name='${clearName}' and b.datname=current_database())
      and l.locktype='advisory' and l.classid=62803
      and l.objid::bigint=(pg_catalog.hashtext('${user}'::uuid::text)::bigint+4294967296)%4294967296 and l.granted;`)) === 1,
    "old writer owns this user's 62803 key and waits for generation", [writer, clearer]);
    summary.production_waiters_observed++;
    clearer.child.stdin.end(`${workerQuery("clear", seeded)} commit;\n`);
    const values = (await Promise.all([clearer.complete, writer.complete])).map((result, index) => classify(result, { kind: index === 0 ? "clear" : kind, sample: false }));
    values.forEach(record);
    assert.equal(values.filter((value) => value.kind === "deadlock").length, 1, `real generation/62803 inverse order must deadlock (${kind})`);
    assert.equal(values.filter((value) => value.kind === "ok").length, 1, `the surviving transaction must finish (${kind})`);
    summary.trials_completed++;
    console.log(`OK: old ${kind} versus clear reproduced SQLSTATE 40P01`);
  };
  const natural = async (index) => {
    const sample = index % 2 === 0;
    const seeded = await seed(sample);
    const workers = workersFor(seeded, sample);
    summary.trials_started++;
    const controller = launch(preamble + `begin; select pg_advisory_xact_lock(${gate}); select 'GATE-HELD';\n`, { interactive: true });
    await waitFor(() => controller.state.stdout.includes("GATE-HELD"), "start gate", [controller]);
    const pending = workers.map((worker, slot) => launch(preamble + `set application_name='${prefix}worker-${slot}'; begin; set local role service_role;
      ${header(worker.sample, seeded.generation)} select pg_advisory_xact_lock_shared(${gate}); ${worker.query} select pg_sleep(0.03); commit;`));
    summary.operations_started += pending.length;
    await waitFor(async () => Number(await scalar(`select count(*) from pg_stat_activity where datname=current_database() and application_name like '${prefix}worker-%' and wait_event='advisory';`)) === 4,
      "all four workers at start gate", pending);
    summary.gate_workers_observed += 4;
    controller.child.stdin.end("commit;\n");
    const gateResult = await controller.complete;
    assert.equal(gateResult.code, 0, "start gate controller failed");
    // Commit delay only holds locks acquired by the real RPC; no production lock order is injected.
    summary.production_waiters_observed += Number(await scalar(`select count(*) from pg_stat_activity a where a.datname=current_database() and a.application_name like '${prefix}worker-%'
      and a.wait_event_type='Lock' and exists(select 1 from pg_stat_activity b where b.pid=any(pg_blocking_pids(a.pid)) and b.datname=current_database() and b.application_name like '${prefix}worker-%');`));
    const values = (await Promise.all(pending.map((handle) => handle.complete))).map((result, slot) => classify(result, workers[slot]));
    values.forEach(record);
    assert.equal(values.length, 4, "every worker must return a terminal result");
    assert.equal(values[0].kind, "ok", `clear failed: ${JSON.stringify(values[0])}`);
    for (const value of values) assert.ok(["ok", "retry", "expected_refusal"].includes(value.kind), `unexpected outcome: ${JSON.stringify(value)}`);
    assert.equal(Number(await scalar(`select count(*) from public.parcels where user_id='${user}';`)), 0, "clear must leave no resurrected parcel");
    assert.equal(Number(await scalar(`select count(*) from public.emails where user_id='${user}';`)), 0, "clear must leave no old mail lease");
    assert.equal(Number(await scalar(`select count(*) from public.parcels where id='${otherParcel}' and user_id='${other}';`)), 1, "other user remains untouched");
    assert.equal(await scalar(`select generation from public.sample_generations where user_id='${other}';`), seeded.other_generation, "other generation remains unchanged");
    summary.trials_completed++;
    if ((index + 1) % 30 === 0) console.log(`PROGRESS: ${summary.trials_completed}/${rounds} trials; ${summary.operations_completed} terminal operations; 40P01=${summary.outcomes.deadlock}`);
  };
  const stop = () => { interrupted = true; for (const child of children) child.kill("SIGTERM"); };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    assert.equal((await sql("show listen_addresses;", "postgres")).trim(), "127.0.0.1", "only an explicitly loopback-bound test server is allowed");
    assert.match(await sql("show server_version;", "postgres"), /^17\./);
    assert.equal((await sql("show port;", "postgres")).trim(), String(port));
    await sql(`create database "${database}";`, "postgres");
    databaseCreated = true;
    assert.equal(Number(await scalar("select count(*) from pg_roles where rolname in ('anon','authenticated','service_role');")), 3, "test roles must already exist; runner never changes cluster-wide roles");
    const bootstrap = (await readFile(path.join(root, "tests/postgres/bootstrap.sql"), "utf8")).replace(/^create role (?:anon|authenticated|service_role)\b[^;]*;\s*/gm, "");
    await sql(bootstrap);
    const migrations = migrationFiles(await readdir(path.join(root, "supabase/migrations")));
    assert.ok(migrations.includes(target));
    for (const name of migrations) {
      if (name === "20261106180000_screen_events_daily_purge.sql") console.log(`SKIP: ${name} (pg_cron-only schedule)`);
      else {
        const source = await readFile(path.join(root, "supabase/migrations", name), "utf8");
        if (name === target || name === legacy) summary.sql_sha256[name] = createHash("sha256").update(source).digest("hex");
        if (name === target) summary.target_sha256 = createHash("sha256").update(source).digest("hex");
        await sql(source);
      }
    }
    await sql(`insert into auth.users(id) values('${user}'),('${other}'); select public.begin_sample_load('${user}'); select public.begin_sample_load('${other}');`);
    if (negative) {
      const source = await readFile(path.join(root, "supabase/migrations", legacy), "utf8");
      summary.negative_source_sha256 = createHash("sha256").update(source).digest("hex");
      for (const definition of originalFunctions(source)) await sql(definition);
      console.log("NEGATIVE CONTROL: local 100000 E -> per-user L bodies replace the public G-prefix wrappers only in this scratch database; source files unchanged");
      await controls();
      for (const kind of ["create-shipped", "update-shipped", "ensure"]) await synchronizedNegative(kind);
    } else {
      await controls();
      await postClearControls();
      if (controlsOnly) console.log("NOT RUN: the 360 natural concurrent trials (controls-only smoke)");
      else {
        for (let index = 0; index < rounds; index++) await natural(index);
        assert.equal(summary.trials_completed, rounds);
        assert.equal(summary.operations_completed, rounds * 4);
        assert.equal(summary.gate_workers_observed, rounds * 4);
        assert.ok(summary.production_waiters_observed > 0, "actual production-lock contention must be observed, not just a synthetic start gate");
        assert.equal(summary.outcomes.deadlock, 0);
      }
    }
    console.log(`SUMMARY:${JSON.stringify(summary)}`);
    console.log("verdict=OK");
  } catch (error) {
    console.error(`SUMMARY:${JSON.stringify(summary)}`);
    throw error;
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    for (const child of children) child.kill("SIGTERM");
    await writeFile(path.join(scratch, "summary.json"), JSON.stringify({ ...summary, database, port }, null, 2));
    console.log(databaseCreated ? `Retained scratch database ${database}; external test cluster was not stopped` : "Scratch database was not created; external test cluster was not stopped");
    console.log(`Local summary: ${path.relative(root, path.join(scratch, "summary.json"))}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const allowed = new Set(["--self-test", "--negative-control", "--external-test-server", "--controls-only"]);
  if (args.some((arg) => !allowed.has(arg)) || new Set(args).size !== args.length || (args.includes("--self-test") && args.length !== 1) || (args.includes("--negative-control") && args.includes("--controls-only"))) {
    console.error("Usage: node tests/postgres/run-sample-lock-order.mjs --self-test | --external-test-server [--negative-control|--controls-only]");
    process.exitCode = 2;
  } else (args.includes("--self-test") ? selfTest() : main(args.includes("--negative-control"), args.includes("--controls-only"))).catch((error) => {
    console.error(`verdict=FAILED: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
