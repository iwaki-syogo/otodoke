import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cleanEnvironment } from "./run-parcel-conflicts.mjs";
import { requireVerdict, taggedResults } from "./run-cost-guards.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const stem = "20261113130000_received_receipts";
const port = 65444;
const gate = "183765135,1";
const bin = process.env.OTODOKE_PG_BINDIR ?? "";
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const owner = uuid(1), other = uuid(2), parcel = uuid(30), otherParcel = uuid(31), mail = uuid(10), run = uuid(20);
const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
const json = (value) => `${quote(JSON.stringify(value))}::jsonb`;
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const markQuery = (ids = [parcel]) => `select 'RESULT:'||coalesce(jsonb_agg(to_jsonb(r)),'[]'::jsonb)::text from (select * from public.mark_parcels_received(array[${ids.map(quote).join(",")}]::uuid[])) r;`;
const undoQuery = (keys) => `select 'RESULT:'||coalesce(jsonb_agg(to_jsonb(r)),'[]'::jsonb)::text from (select * from public.restore_parcel_receipts(${json(keys)})) r;`;
const actor = (role, query, user = owner) => `begin; set local role ${role}; set local request.jwt.claim.sub=${quote(user)}; set local request.headers='{}'; ${query} commit;`;
const keyOf = (receipt) => ({ id: receipt.id, receipt_id: receipt.receipt_id });
const prior = (names) => names.filter((name) => /^\d{14}_.+\.sql$/.test(name) && name.slice(0, 14) < stem.slice(0, 14)).sort();
const prerequisites = ["20261113110000", "20261113120000", "20261113121000"];
async function applyAndRecord(name, apply, record) {
  assert.match(name, /^\d{14}_.+\.sql$/);
  await apply(`supabase/migrations/${name}`);
  // The platform history records only an actual, successfully executed application migration.
  await record(`insert into supabase_migrations.schema_migrations(version,name) values(${quote(name.slice(0, 14))},${quote(name.slice(15, -4))}) on conflict(version) do nothing;`);
}
const plan = [
  ["verify", `supabase/verify/${stem}.before.sql`],
  ["file", `supabase/migrations/${stem}.sql`],
  ["verify", `supabase/verify/${stem}.before.sql`],
  ["file", `supabase/migrations/${stem}.sql`],
  ["verify", `supabase/verify/${stem}.sql`],
];

function one(output) {
  const values = taggedResults(output);
  assert.equal(values.length, 1, `expected exactly one tagged JSON value: ${output}`);
  return JSON.parse(values[0]);
}

function healthy(result) {
  assert.equal(result.timedOut, false, "child timed out; never counted as a successful SQL operation");
  assert.equal(result.signal, null, `child was interrupted: ${result.signal}`);
  assert.equal(result.code, 0, result.stderr || "child failed");
  assert.doesNotMatch(result.stderr, /\b(?:ERROR|FATAL|PANIC):/i, "SQL error even with exit zero");
  return result.stdout;
}

function expectedError(output, state, message) {
  const value = one(output);
  assert.equal(value.state, state, `expected SQLSTATE ${state}: ${JSON.stringify(value)}`);
  if (message) assert.match(value.message, message);
  return value;
}

function oldCore(source) {
  const definition = source.match(/create or replace function public\.update_mail_parcel_without_sample_fence\([\s\S]*?end \$\$;/)?.[0];
  assert.ok(definition, "rollback must contain the real previous private mail core");
  assert.doesNotMatch(definition, /v_changes = '\{\}'::jsonb then v_changes/);
  return definition;
}

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
  assert.deepEqual(prior([`${stem}.sql`, "20261113130000_same.sql", "20261114090000_future.sql", "notes.md", "20261113110000_sample_generation.sql"]), ["20261113110000_sample_generation.sql"]);
  assert.equal(plan.filter(([kind]) => kind === "file").length, 2);
  const applied = [];
  await applyAndRecord("20261113110000_sample_generation.sql", async (name) => applied.push(["apply", name]), async (query) => applied.push(["record", query]));
  assert.deepEqual(applied.map(([kind]) => kind), ["apply", "record"]);
  assert.match(applied[1][1], /20261113110000/);
  let recorded = false;
  await assert.rejects(applyAndRecord("20261113110000_sample_generation.sql", async () => { throw new Error("DDL failed"); }, async () => { recorded = true; }), /DDL failed/);
  assert.equal(recorded, false, "a failed or skipped migration must never acquire a history row");
  const environment = cleanEnvironment("synthetic-scratch", { PGHOST: "remote.invalid", PGPORT: "5432", PGSERVICE: "production", PGPASSWORD: "unused", PATH: "test" });
  for (const name of ["PGHOST", "PGPORT", "PGSERVICE", "PGPASSWORD"]) assert.equal(environment[name], undefined);
  assert.equal(environment.PGPASSFILE, path.join("synthetic-scratch", "no-password-file"));
  assert.deepEqual(one('RESULT:[{"id":"synthetic","outcome":"restored"}]\n'), [{ id: "synthetic", outcome: "restored" }]);
  for (const value of ["", "RESULT:{}\nRESULT:{}\n", "RESULT:broken\n"]) assert.throws(() => one(value));
  for (const output of ["", "FAILED|f\n", "OK|t\nERROR: broken\n"]) assert.throws(() => requireVerdict(output, "bad verdict"));
  requireVerdict("OK|t|passed\n", "good verdict");
  const result = (changes) => ({ code: 0, signal: null, timedOut: false, stderr: "", stdout: "OK", ...changes });
  for (const changes of [{ code: 1 }, { timedOut: true }, { signal: "SIGTERM" }, { stderr: "ERROR: SQL failed", code: 0 }]) assert.throws(() => healthy(result(changes)));
  expectedError('RESULT:{"state":"22023","message":"receipt request"}', "22023", /receipt/);
  for (const state of ["00000", "42601", "55P03", "40P01"]) assert.throws(() => expectedError(`RESULT:{"state":"${state}"}`, "22023"));
  assert.match(markQuery(), /from \(select \* from public\.mark_parcels_received/);
  assert.match(undoQuery([{ id: parcel, receipt_id: uuid(99) }]), /from \(select \* from public\.restore_parcel_receipts/);
  const source = await readFile(path.join(root, `supabase/rollback/${stem}.down.sql`), "utf8");
  assert.match(oldCore(source), /else v_saved := to_jsonb\(v_parcel\)/);
  assert.throws(() => oldCore(source.replace("public.update_mail_parcel_without_sample_fence(", "public.missing(")));
  const dummy = async (code, options) => healthy(await start(process.execPath, ["-e", code], options).complete);
  await dummy("process.stdout.write('OK')");
  await assert.rejects(dummy("process.stderr.write('ERROR: synthetic SQL error');process.exit(0)"), /SQL error/);
  await assert.rejects(dummy("process.exit(1)"));
  await assert.rejects(dummy("setTimeout(()=>{},10000)", { timeout: 20 }), /timed out/);
  console.log("OK: self-test (dependency boundary, apply-before-history and failed-DDL-no-record orchestration, 1-column JSON shape, final verdict, expected SQLSTATE, PG isolation, child failure/exit-zero SQL error/timeout)");
  console.log("NOT RUN: PostgreSQL startup, missing-prerequisite before/DDL guards, TTL/cleanup/replay, migrations/verifiers/rollback, temporal SQL, production-lock concurrency, SQL negative controls, stop/listener/delete lifecycle");
}

async function main(negative) {
  assert.equal(await listening(), false, `dedicated port ${port} is occupied; no existing server was touched`);
  const rounds = Number(process.env.OTODOKE_RECEIPT_PG_ROUNDS ?? "10");
  assert.ok(Number.isSafeInteger(rounds) && rounds >= 2 && rounds <= 100, "OTODOKE_RECEIPT_PG_ROUNDS must be an integer from 2 to 100");
  const parent = path.join(root, ".vitest/pg"); await mkdir(parent, { recursive: true });
  const scratch = await mkdtemp(path.join(parent, "received-"));
  const data = path.join(scratch, "data");
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
  const verify = async (name) => { const output = await file(name); requireVerdict(output, name); console.log(`OK: ${name}: ${output.trim().split(/\r?\n/).at(-1)}`); };
  const footprint = async () => one(await sql(`select 'RESULT:'||jsonb_build_object(
    'functions',(select jsonb_agg(jsonb_build_object('oid',p.oid,'definition',pg_get_functiondef(p.oid),'acl',p.proacl) order by p.oid)
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prokind='f'),
    'relations',(select jsonb_agg(jsonb_build_object('oid',c.oid,'name',c.relname,'kind',c.relkind,'rls',c.relrowsecurity,'acl',c.relacl) order by c.oid)
      from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public'),
    'columns',(select jsonb_agg(to_jsonb(a) order by a.attrelid,a.attnum) from pg_attribute a join pg_class c on c.oid=a.attrelid
      join pg_namespace n on n.oid=c.relnamespace where n.nspname='public'),
    'constraints',(select jsonb_agg(to_jsonb(k) order by k.oid) from pg_constraint k join pg_namespace n on n.oid=k.connamespace where n.nspname='public'),
    'triggers',(select jsonb_agg(to_jsonb(t) order by t.oid) from pg_trigger t join pg_class c on c.oid=t.tgrelid
      join pg_namespace n on n.oid=c.relnamespace where n.nspname='public')
    )::text;`));
  const missingPrerequisites = async () => {
    const beforeName = `supabase/verify/${stem}.before.sql`, migrationName = `supabase/migrations/${stem}.sql`;
    const oldPurge = await scalar("select pg_get_functiondef('public.purge_old_screen_events()'::regprocedure);");
    const oldSetter = await scalar("select pg_get_functiondef('public.set_ai_reading(text,text)'::regprocedure);");
    const wrongSetter = oldSetter.replace(/perform\s+public\.lock_sample_owner\(v_user\);/, "perform 1;");
    assert.notEqual(wrongSetter, oldSetter, "definition fault must remove the actual setter owner prefix");
    const oldClaim = await scalar("select pg_get_functiondef('public.claim_claude_call_v2(uuid,integer,integer)'::regprocedure);");
    const wrongClaim = oldClaim.replace(/perform\s+public\.assert_claude_claim_consent\(p_user_id\);/, "perform 1;");
    assert.notEqual(wrongClaim, oldClaim, "definition fault must remove the actual claim consent check");
    const faults = [
      ["history table absent", "alter table supabase_migrations.schema_migrations rename to receipt_saved_history;", "alter table supabase_migrations.receipt_saved_history rename to schema_migrations;"],
      ["history version column absent", "alter table supabase_migrations.schema_migrations rename column version to receipt_saved_version;", "alter table supabase_migrations.schema_migrations rename column receipt_saved_version to version;"],
      ...prerequisites.map((version) => [`history ${version} absent`, `delete from supabase_migrations.schema_migrations where version='${version}';`,
        `insert into supabase_migrations.schema_migrations(version,name) select version,name from receipt_saved_history_rows where version='${version}';`]),
      ...[["lock_sample_owner", "uuid"], ["ai_consent_waiting_retention", ""], ["assert_claude_claim_consent", "uuid"]].map(([name, signature]) =>
        [`footprint ${name} absent`, `alter function public.${name}(${signature}) rename to ${name}_receipt_fault;`, `alter function public.${name}_receipt_fault(${signature}) rename to ${name};`]),
      ["purge consent definition missing", "create or replace function public.purge_old_screen_events() returns integer language plpgsql security definer set search_path='' as $$begin return 0; end$$;", oldPurge],
      ["setter owner prefix missing", wrongSetter, oldSetter],
      ["claim consent definition missing", wrongClaim, oldClaim],
      ["consent deadline column absent", "alter table public.emails rename column consent_waiting_until to receipt_saved_until;", "alter table public.emails rename column receipt_saved_until to consent_waiting_until;"],
    ];
    await sql("create table receipt_saved_history_rows as select version,name from supabase_migrations.schema_migrations;");
    try {
      for (const [label, remove, restore] of faults) {
        await sql(remove);
        try {
          const snapshot = await footprint();
          const output = await file(beforeName);
          assert.equal(output.trim().split(/\r?\n/).at(-1)?.split("|")[0], "FAILED", `${label}: before must return FAILED without SQL errors`);
          assert.deepEqual(await footprint(), snapshot, `${label}: read-only before changed the database footprint`);
          const result = await launch("psql", [...args, "-f", path.join(root, migrationName)]).complete;
          assert.equal(result.timedOut, false); assert.equal(result.signal, null); assert.notEqual(result.code, 0, `${label}: DDL must refuse`);
          assert.match(result.stderr, /\bERROR:\s+55000:/, `${label}: refuse with the prerequisite error, not an unrelated SQL error`);
          assert.deepEqual(await footprint(), snapshot, `${label}: refused migration changed existing definitions, columns, ACLs or triggers`);
        } finally { await sql(restore); }
      }
    } finally { await sql("drop table receipt_saved_history_rows;"); }
    console.log(`OK: ${faults.length} isolated prerequisite faults (missing history table/each version/function or changed definition) refuse before/DDL without changing public catalog footprint`);
  };
  const row = async () => one(await sql(`select 'RESULT:'||to_jsonb(p)::text from public.parcels p where p.id='${parcel}';`));
  const journalCount = () => scalar(`select count(*) from public.parcel_receipt_undos where user_id='${owner}';`);
  const mark = async () => one(await sql(actor("authenticated", markQuery())))[0];
  const undo = async (receipt, user = owner) => one(await sql(actor("authenticated", undoQuery([keyOf(receipt)]), user)))[0];
  const capture = (query) => `select 'RESULT:'||public.test_capture_receipt_error(${quote(query)})::text;`;
  const reset = async (status = "shipped") => {
    await sql(`delete from auth.users where id in('${owner}','${other}'); insert into auth.users(id) values('${owner}'),('${other}');
      insert into public.emails(id,user_id,provider_email_id,processing_status,processing_run_id,processing_lease_until) values
        ('${mail}','${owner}','synthetic:receipt','pending','${run}',clock_timestamp()+interval '360 seconds');
      insert into public.parcels(id,user_id,shop,status,updated_at,category_source,category) values
        ('${parcel}','${owner}','Synthetic shop',${quote(status)},'2026-11-01T00:00:00Z','user','hobby'),
        ('${otherParcel}','${other}','Other synthetic shop','ordered','2026-11-01T00:00:00Z','user','hobby');`);
  };
  const mailQuery = async (values) => {
    const before = one(await sql(`select 'RESULT:'||jsonb_build_object('snapshot',public.mail_parcel_snapshot('${owner}'),'version',(select updated_at from public.parcels where id='${parcel}'))::text;`));
    return `select 'RESULT:'||to_jsonb(r)::text from (select * from public.update_mail_parcel(${json(before.snapshot)},'${parcel}',${quote(before.version)}::timestamptz,${json(values)},null,'[]'::jsonb,'${mail}','${run}')) r;`;
  };
  const mailUpdate = async (values) => {
    const value = one(await sql(actor("service_role", await mailQuery(values)))); assert.equal(value.verdict, "ok"); return value;
  };
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
    assert.equal(path.dirname(actualScratch), actualParent); assert.match(path.basename(actualScratch), /^received-/);
    await rm(actualScratch, { recursive: true });
    console.log(`OK: cleanup: own cluster stopped, listener=0 on 127.0.0.1:${port}, dedicated data and logs deleted`);
  })());
  try {
    assert.match(await command("initdb", ["--version"]), /PostgreSQL\) 17\./);
    await command("initdb", ["-D", data, "-U", "postgres", "--no-sync", "-c", "dynamic_shared_memory_type=mmap", "-c", "shared_memory_type=mmap"]);
    startAttempted = true;
    // Disable Unix sockets: long worktree names must not exceed the OS socket-path limit.
    await command("pg_ctl", ["-D", data, "-l", path.join(scratch, "server.log"), "-t", "10", "-o",
      `-h 127.0.0.1 -p ${port} -c unix_socket_directories= -c dynamic_shared_memory_type=mmap -c shared_memory_type=mmap`, "start"], { timeout: 15_000 });
    assert.equal(await listening(), true); assert.equal(await scalar("show listen_addresses;"), "127.0.0.1");
    assert.equal(Number(await scalar("show port;")), port); assert.equal(await scalar("show unix_socket_directories;"), "");
    assert.equal(await scalar("show data_directory;"), data);
    await file("tests/postgres/bootstrap.sql");
    await sql("create schema supabase_migrations; create table supabase_migrations.schema_migrations(version text primary key,name text,statements text[]);");
    for (const name of prior(await readdir(path.join(root, "supabase/migrations")))) {
      if (name === "20261106180000_screen_events_daily_purge.sql") {
        const source = await readFile(path.join(root, `supabase/migrations/${name}`), "utf8");
        const begin = source.indexOf("create or replace function public.is_shared_mail_domain"), end = source.indexOf("select cron.schedule");
        assert.ok(begin >= 0 && end > begin, "real domain/purge definitions must exist before the scheduler");
        await sql(source.slice(begin, end));
        await sql("create schema cron; create table cron.job(jobname text,command text,schedule text,active boolean); insert into cron.job values('otodoke-purge-old-screen-events','select public.purge_old_screen_events()','30 18 * * *',true);");
        console.log(`PARTIAL PLATFORM MOCK: ${name} real domain/purge definitions executed; pg_cron extension/schedule omitted and local schedule catalog reproduced; NO applied history recorded`);
      } else await applyAndRecord(name, file, sql);
    }
    // Supabase-managed existing table grants are substrate fixtures, never part of target DDL.
    // Keep the actual authenticated native direct writer; do not substitute an owner bypass.
    await sql("grant usage on schema public to authenticated,service_role; grant select,insert,update,delete on public.parcels to authenticated,service_role;");
    console.log("BOOTSTRAP: existing Supabase parcel grants reproduced only in disposable fixture; target migration must preserve them");
    await missingPrerequisites();
    const parcelGrants = await scalar("select coalesce(relacl::text,'') from pg_class where oid='public.parcels'::regclass;");
    const originalPurge = await scalar("select pg_get_functiondef('public.purge_old_screen_events()'::regprocedure);");
    for (const [kind, name] of plan) await (kind === "verify" ? verify(name) : file(name));
    await sql(`insert into supabase_migrations.schema_migrations(version,name) values('${stem.slice(0, 14)}','received_receipts') on conflict(version) do nothing;`);
    assert.equal(await scalar("select coalesce(relacl::text,'') from pg_class where oid='public.parcels'::regclass;"), parcelGrants, "target must not change existing native parcel grants");
    await sql(`create function public.test_capture_receipt_error(p_sql text) returns jsonb language plpgsql as $$
      declare v_state text; v_message text; begin execute p_sql; return jsonb_build_object('state','00000','message','statement completed');
      exception when others then get stacked diagnostics v_state=returned_sqlstate,v_message=message_text;
        return jsonb_build_object('state',v_state,'message',v_message); end $$;`);
    console.log("SCOPE: actual SQL RPC/trigger boundary; Supabase auth roles are local substrate mocks; full Web/Swift/Claude pipeline is not executed");
    console.log("P1 OWNER HELPER: this runner targets the current provisional 62803 seams. P1 SHA/helper integration and owner-key concurrency must be reviewed and measured separately before release");

    if (negative) {
      await reset(); await mailUpdate({ status: "delivered" }); const receipt = await mark();
      assert.equal(receipt.previous_status, "delivered");
      // Reproduce the old stale-rendered-status PATCH, using the real table/trigger/RLS.
      const changed = one(await sql(actor("authenticated", `with changed as(update public.parcels set status='shipped',received_at=null where id='${parcel}'
        and user_id='${owner}' and status='delivered' and received_at=${quote(receipt.received_at)}::timestamptz returning *)
        select 'RESULT:'||jsonb_build_object('count',count(*))::text from changed;`)));
      assert.equal(changed.count, 1); const demoted = await row(); assert.equal(demoted.status, "shipped");
      assert.throws(() => assert.equal(demoted.status, "delivered"), /shipped/);
      console.log("OK: NEGATIVE CONTROL: real old client-status restore demoted a delivery mail; the delivered invariant rejected it");
      await sql(oldCore(await readFile(path.join(root, `supabase/rollback/${stem}.down.sql`), "utf8")));
      await reset(); const oldReceipt = await mark(); const oldVersion = (await row()).updated_at;
      await mailUpdate({}); assert.equal((await row()).updated_at, oldVersion, "real old private empty merge must skip the update");
      assert.equal((await undo(oldReceipt)).outcome, "restored"); const oldState = await row(); assert.equal(oldState.status, "shipped");
      assert.throws(() => assert.equal(oldState.status, "delivered"), /shipped/);
      console.log("OK: NEGATIVE CONTROL: real pre-fix no-op mail core left the version unchanged and allowed journal undo to demote it");
      const restoreSource = await scalar("select pg_get_functiondef('public.restore_parcel_receipts(jsonb)'::regprocedure);");
      const expiry = /v_receipt\.expires_at\s*<=\s*clock_timestamp\(\)/;
      assert.match(restoreSource, expiry, "negative control must remove the actual runtime expiry check");
      try {
        await sql(restoreSource.replace(expiry, "false")); await reset(); const expired = await mark();
        await sql(`update public.parcel_receipt_undos set expires_at=clock_timestamp()-interval '1 second',created_at=clock_timestamp()-interval '1 second'-public.parcel_receipt_retention() where parcel_id='${parcel}';`);
        assert.equal((await undo(expired)).outcome, "restored"); assert.equal((await row()).status, "shipped");
        console.log("OK: NEGATIVE CONTROL: removing the real SQL expiry check lets an expired receipt restore the old status; the required failed/no-change invariant is violated");
      } finally { await sql(restoreSource); }
    } else {
      await reset(); await mailUpdate({ status: "delivered" }); const beforeMail = await mark();
      assert.equal(beforeMail.outcome, "written"); assert.equal(beforeMail.previous_status, "delivered"); assert.equal(beforeMail.previous_received_at, null);
      assert.equal((await undo(beforeMail)).outcome, "restored"); assert.equal((await row()).status, "delivered"); assert.equal((await row()).received_at, null);
      await reset(); const afterMail = await mark(); await mailUpdate({ status: "delivered", last_email_at: "2026-11-12T02:00:00Z" });
      assert.equal((await undo(afterMail)).outcome, "changed"); assert.equal((await row()).status, "delivered");
      await reset(); const noop = await mark(); const oldVersion = (await row()).updated_at; await mailUpdate({});
      assert.notEqual((await row()).updated_at, oldVersion); assert.equal((await undo(noop)).outcome, "changed");
      assert.equal((await row()).status, "delivered"); assert.equal(await scalar(`select count(*) from public.extractions where email_id='${mail}';`), "0");
      console.log("OK: B1 separate-transaction mail-before/after-mark and empty-merge-before-extraction preserve delivered");

      // Isolate BOTH fences. Same-transaction now() deliberately holds updated_at constant
      // while an actual authenticated native UPDATE changes only received_at.
      await reset();
      const receivedOnly = one(await sql(actor("authenticated", `create temporary table receipt_native on commit drop as select * from public.mark_parcels_received(array['${parcel}']::uuid[]);
        update public.parcels set received_at=clock_timestamp()+interval '1 second' where id='${parcel}' and user_id='${owner}';
        select 'RESULT:'||to_jsonb(r)::text from receipt_native r;`)));
      const receivedChanged = await row(); assert.equal(receivedChanged.updated_at, receivedOnly.updated_at); assert.notEqual(receivedChanged.received_at, receivedOnly.received_at);
      assert.equal((await undo(receivedOnly)).outcome, "changed"); assert.deepEqual(await row(), receivedChanged);
      await reset(); const versionOnly = await mark(); await sql(actor("authenticated", `update public.parcels set title='Synthetic native classification' where id='${parcel}' and user_id='${owner}';`));
      const versionChanged = await row(); assert.equal(versionChanged.received_at, versionOnly.received_at); assert.notEqual(versionChanged.updated_at, versionOnly.updated_at);
      assert.equal((await undo(versionOnly)).outcome, "changed"); assert.deepEqual(await row(), versionChanged);
      console.log("OK: authenticated native direct UPDATE independently exercises received_at-only and updated_at-only fences; native grants preserved");

      const deadline = async () => one(await sql(`select 'RESULT:'||jsonb_build_object('created_at',created_at,'expires_at',expires_at) ::text from public.parcel_receipt_undos where parcel_id='${parcel}';`));
      await reset(); const timed = await mark(); const fixed = await deadline();
      assert.equal(await scalar(`select expires_at=created_at+public.parcel_receipt_retention() from public.parcel_receipt_undos where parcel_id='${parcel}';`), "t");
      assert.equal(await scalar("select public.parcel_receipt_retention()=interval '24 hours';"), "t");
      assert.equal((await mark()).outcome, "already_received"); assert.deepEqual(await deadline(), fixed);
      assert.equal((await undo(timed)).outcome, "restored"); assert.deepEqual(await deadline(), fixed);
      assert.equal((await undo(timed)).outcome, "restored"); assert.deepEqual(await deadline(), fixed);
      await sql(`update public.parcel_receipt_undos set expires_at=clock_timestamp(),created_at=clock_timestamp()-public.parcel_receipt_retention() where parcel_id='${parcel}';`);
      const expiredRestoredRow = await row(), expiredDeadline = await deadline();
      assert.equal((await undo(timed)).outcome, "failed"); assert.deepEqual(await row(), expiredRestoredRow); assert.deepEqual(await deadline(), expiredDeadline);

      for (const stage of ["G", "J"]) {
        await reset(); const waiting = await mark();
        // Synthetic creation age keeps the real retention interval intact; no 24-hour sleep.
        await sql(`with cutoff as(select clock_timestamp()+interval '2 seconds' as at)
          update public.parcel_receipt_undos set created_at=cutoff.at-public.parcel_receipt_retention(),expires_at=cutoff.at from cutoff where parcel_id='${parcel}';`);
        const until = await deadline(), before = await row();
        const name = `receipt-expiry-${stage}-${process.pid}`;
        const holding = interactive(`set application_name='${name}-holder'; begin;
          ${stage === "G" ? `select public.lock_sample_owner('${owner}');` : `select parcel_id from public.parcel_receipt_undos where parcel_id='${parcel}' for update;`}
          select 'EXPIRY-HELD';\n`);
        let pending;
        try {
          await waitFor(() => holding.state.stdout.includes("EXPIRY-HELD"), `${stage} expiry blocker`, [holding]);
          assert.equal(await scalar(`select clock_timestamp()<${quote(until.expires_at)}::timestamptz;`), "t", "undo must begin before expiry");
          pending = launch("psql", args, { input: preamble + `set application_name='${name}-undo';` + actor("authenticated", undoQuery([keyOf(waiting)])) });
          await waitFor(async () => Number(await scalar(`select count(*) from pg_stat_activity a where a.datname=current_database() and a.application_name='${name}-undo'
            and a.wait_event_type='Lock' and exists(select 1 from pg_stat_activity b where b.pid=any(pg_blocking_pids(a.pid)) and b.application_name='${name}-holder');`)) === 1,
          `${stage} production expiry waiter`, [pending, holding]);
          holding.child.stdin.end(`select pg_sleep(greatest(0,extract(epoch from ${quote(until.expires_at)}::timestamptz-clock_timestamp()))+0.05); commit;\n`);
          healthy(await holding.complete);
          assert.equal(one(healthy(await pending.complete))[0].outcome, "failed", "clock must be checked after all row-lock waits, including the journal wait");
          assert.deepEqual(await row(), before); assert.deepEqual(await deadline(), until);
        } finally { if (!holding.state.exited) await release(holding); if (pending) await pending.complete; }
      }
      const expiredKey = await mark(); // already-received does not create or renew a journal.
      assert.equal(expiredKey.outcome, "already_received");
      const expiredJournal = one(await sql(`select 'RESULT:'||jsonb_build_object('id',parcel_id,'receipt_id',receipt_id)::text from public.parcel_receipt_undos where parcel_id='${parcel}';`));
      const keptRow = await row();
      const otherLive = one(await sql(actor("authenticated", markQuery([otherParcel]), other)))[0]; assert.equal(otherLive.outcome, "written");
      const expiredMail = uuid(111);
      await sql(`insert into public.emails(id,user_id,processing_status,error,text_body,body_state,received_at)
        values('${expiredMail}','${owner}','failed','ai_consent_required','Expired synthetic consent body','plain',clock_timestamp()-public.ai_consent_waiting_retention()-interval '1 second');
        insert into public.screen_events(user_id,created_at,decision,subject) values('${owner}',clock_timestamp()-interval '20 days','dropped','Old synthetic screen');
        select public.purge_old_screen_events();`);
      assert.equal(await journalCount(), "0"); assert.deepEqual(await row(), keptRow); assert.equal((await undo(expiredJournal)).outcome, "failed");
      assert.equal(await scalar(`select count(*) from public.parcel_receipt_undos where parcel_id='${otherParcel}';`), "1");
      assert.equal(await scalar(`select count(*) from public.emails where id='${expiredMail}';`), "0");
      assert.equal(await scalar("select count(*) from public.screen_events;"), "0"); assert.equal(await scalar("select count(*) from cron.job;"), "1");
      console.log("OK: creation-based 24h SOT, no renewal on receive/undo/replay, expiry across G/J waits returns failed without mutations, existing daily purge physically removes expired journals and still purges consent/screen data");

      for (const total of [501, 1001]) {
        await reset(); await sql(`delete from public.parcels where id='${parcel}';
          insert into public.parcels(id,user_id,shop,status,updated_at)
            select ('00000000-0000-4000-8000-'||lpad(i::text,12,'0'))::uuid,'${owner}','Synthetic bulk shop','shipped','2026-11-01T00:00:00Z'
            from generate_series(1000,${999 + total}) i;`);
        const ids = Array.from({ length: total }, (_, index) => uuid(1000 + index)); const receipts = [];
        for (let offset = 0; offset < ids.length; offset += 200) {
          const requested = ids.slice(offset, offset + 200);
          const written = one(await sql(actor("authenticated", markQuery(requested))));
          assert.deepEqual(written.map((value) => value.id).sort(), [...requested].sort());
          assert.ok(written.every((value) => value.outcome === "written" && value.receipt_id && value.previous_status === "shipped")); receipts.push(...written);
        }
        assert.equal(receipts.length, total); assert.equal(await journalCount(), String(total));
        for (let offset = 0; offset < receipts.length; offset += 200) {
          const requested = receipts.slice(offset, offset + 200); const restored = one(await sql(actor("authenticated", undoQuery(requested.map(keyOf)))));
          assert.deepEqual(restored.map((value) => value.id).sort(), requested.map((value) => value.id).sort()); assert.ok(restored.every((value) => value.outcome === "restored"));
        }
        assert.equal(await scalar(`select count(*) from public.parcels where user_id='${owner}' and status='shipped' and received_at is null;`), String(total));
      }
      console.log("OK: B4 legitimate 501/1001-own-parcel lists mark and restore through actual <=200-row RPC chunks, including the final remainder");

      await reset(); const first = await mark(); assert.equal(await journalCount(), "1");
      assert.equal((await undo(first, other)).outcome, "changed"); assert.equal((await undo({ ...first, receipt_id: uuid(999) })).outcome, "changed");
      assert.equal((await undo(first)).outcome, "restored"); assert.equal((await undo(first)).outcome, "restored");
      const second = await mark(); assert.notEqual(second.receipt_id, first.receipt_id); assert.equal(await journalCount(), "1");
      assert.equal((await undo(first)).outcome, "changed"); assert.equal((await undo(second)).outcome, "restored");
      await reset(); const waitingReceipt = await mark(); assert.equal((await undo(waitingReceipt)).outcome, "restored");
      const replacementHolder = interactive(`begin; set local request.jwt.claim.sub='${owner}'; select public.lock_sample_owner('${owner}'); select 'OWNER-HELD';\n`);
      let waitingUndo;
      try {
        await waitFor(() => replacementHolder.state.stdout.includes("OWNER-HELD"), "owner/generation held before replacing journal", [replacementHolder]);
        const name = `receipt-old-token-${process.pid}`;
        waitingUndo = launch("psql", args, { input: preamble + `set application_name='${name}';` + actor("authenticated", undoQuery([keyOf(waitingReceipt)])) });
        await waitFor(async () => Number(await scalar(`select count(*) from pg_stat_activity where datname=current_database() and application_name='${name}' and wait_event_type='Lock' and wait_event in('tuple','transactionid');`)) === 1,
          "old token undo waiting on owner/generation", [waitingUndo, replacementHolder]);
        replacementHolder.child.stdin.end(`${markQuery()} commit;\n`);
        const replaced = one(healthy(await replacementHolder.complete))[0]; assert.notEqual(replaced.receipt_id, waitingReceipt.receipt_id);
        assert.equal(one(healthy(await waitingUndo.complete))[0].outcome, "changed"); assert.equal((await row()).received_at, replaced.received_at);
      } finally {
        if (!replacementHolder.state.exited) await release(replacementHolder);
        if (waitingUndo) await waitingUndo.complete;
      }
      await reset(); const manualReceipt = await mark(); await sql(actor("authenticated", `update public.parcels set category='daily',category_source='user' where id='${parcel}';`));
      assert.equal((await undo(manualReceipt)).outcome, "changed"); assert.equal((await row()).category, "daily");
      console.log("OK: B2 owner/token confinement, old-token replacement, one-row journal, replay and manual classification");

      await reset(); const clearReceipt = await mark(); await sql(actor("service_role", `select public.clear_all_parcels('${owner}');`));
      assert.equal(await journalCount(), "0"); assert.equal((await undo(clearReceipt)).outcome, "changed");
      assert.equal(await scalar(`select count(*) from public.parcels where id='${otherParcel}';`), "1");
      await reset(); await mark(); await sql(`delete from auth.users where id='${owner}';`);
      assert.equal(await journalCount(), "0"); assert.equal(await scalar(`select count(*) from public.parcels where user_id='${owner}';`), "0");
      console.log("OK: clear and auth-owner cascade remove receipts and preserve the other owner");

      await reset(); const capReceipt = await mark();
      const holder = interactive(`begin; select id from auth.users where id='${owner}' for update; select public.lock_sample_owner('${owner}'); select id from public.emails where user_id='${owner}' order by id for update;
        select pg_advisory_xact_lock(62803,0); select id from public.parcels where user_id='${owner}' order by id for update;
        select parcel_id from public.parcel_receipt_undos where user_id='${owner}' order by parcel_id for update; select 'LOCKS-HELD';\n`);
      try {
        await waitFor(() => holder.state.stdout.includes("LOCKS-HELD"), "production lock prefix", [holder]);
        const requests = [markQuery(Array(201).fill(parcel)), undoQuery(Array.from({ length: 201 }, () => keyOf(capReceipt))),
          `select * from public.mark_parcels_received(array[array['${parcel}','${parcel}'],array['${parcel}','${parcel}']]::uuid[]);`];
        for (const query of requests) expectedError(await sql(actor("authenticated", `set local lock_timeout='100ms'; ${capture(query)}`)), "22023");
      } finally { await release(holder); }
      for (const query of ["select * from public.parcel_receipt_undos", `delete from public.parcel_receipt_undos where user_id='${owner}'`]) {
        expectedError(await sql(actor("authenticated", capture(query))), "42501", /permission denied/);
      }
      console.log("OK: B4 201 raw mark/undo and multidimensional uuid array refuse before held U/G/E/L/R/journal; journal DML is private");

      await reset(); const unchanged = await row();
      await sql(`create function public.test_receipt_skip() returns trigger language plpgsql as $$begin return null; end$$;
        create trigger zzzz_test_receipt_skip before insert or update on public.parcel_receipt_undos for each row execute function public.test_receipt_skip();`);
      expectedError(await sql(actor("authenticated", capture(markQuery()))), "42501", /receipt journal/);
      assert.deepEqual(await row(), unchanged); assert.equal(await journalCount(), "0");
      await sql("drop trigger zzzz_test_receipt_skip on public.parcel_receipt_undos; drop function public.test_receipt_skip();");
      await sql("create function public.test_receipt_old() returns trigger language plpgsql as $$begin return old; end$$;");
      for (const operation of ["mark", "undo", "noop"]) {
        await reset(); const receipt = operation === "mark" ? null : await mark(); const priorRow = await row(); const priorJournal = await journalCount();
        const query = operation === "mark" ? markQuery() : operation === "undo" ? undoQuery([keyOf(receipt)]) : await mailQuery({});
        await sql("create trigger zzzz_test_receipt_old before update on public.parcels for each row execute function public.test_receipt_old();");
        expectedError(await sql(actor(operation === "noop" ? "service_role" : "authenticated", capture(query))), "42501", /not stored|version/);
        assert.deepEqual(await row(), priorRow); assert.equal(await journalCount(), priorJournal);
        await sql("drop trigger zzzz_test_receipt_old on public.parcels;");
      }
      await sql("drop function public.test_receipt_old();");
      console.log("OK: journal skip and BEFORE UPDATE return OLD are visible refusals; parcel/journal changes roll back atomically");

      let completed = 0, contention = 0;
      for (let round = 0; round < rounds; round++) {
        await reset(); const receipt = await mark(); const emailWrite = await mailQuery({ status: "delivered" });
        const deletion = round % 2 === 1;
        const clearQuery = deletion ? `with deleted as(delete from auth.users where id='${owner}' returning id) select 'RESULT:'||jsonb_build_object('count',count(*))::text from deleted;`
          : `select 'RESULT:'||jsonb_build_object('generation',public.clear_all_parcels('${owner}'))::text;`;
        const definitions = [
          [deletion ? "postgres" : "service_role", clearQuery], ["authenticated", markQuery()],
          ["authenticated", undoQuery([keyOf(receipt)])], ["service_role", emailWrite],
          ["authenticated", `with changed as(update public.parcels set category='daily',category_source='user' where id='${parcel}' returning id)
            select 'RESULT:'||jsonb_build_object('count',count(*))::text from changed;`],
        ];
        const prefix = `receipt-${process.pid}-${round}-`;
        const controller = interactive(`begin; select pg_advisory_xact_lock(${gate}); select 'GATE-HELD';\n`);
        let workers = [];
        try {
          await waitFor(() => controller.state.stdout.includes("GATE-HELD"), "start gate", [controller]);
          workers = definitions.map(([role, query], index) => launch("psql", args, { input: preamble + `set application_name='${prefix}${index}'; begin;
            ${role === "postgres" ? "" : `set local role ${role};`} set local request.jwt.claim.sub='${owner}'; set local request.headers='{}';
            select pg_advisory_xact_lock_shared(${gate}); ${capture(query)} select pg_sleep(0.075); commit;` }));
          await waitFor(async () => Number(await scalar(`select count(*) from pg_stat_activity where datname=current_database() and application_name like '${prefix}%' and wait_event='advisory';`)) === workers.length, "all workers on gate", workers);
          controller.child.stdin.end("commit;\n"); healthy(await controller.complete);
          // Observe contention on real owner/generation/row locks after the start gate opens.
          await waitFor(async () => Number(await scalar(`select count(*) from pg_stat_activity where datname=current_database() and application_name like '${prefix}%' and wait_event_type='Lock' and wait_event in('tuple','transactionid');`)) > 0,
            "real production lock contention", workers);
          contention++;
          assert.equal(Number(await scalar(`select count(*) from pg_stat_activity a where a.datname=current_database() and a.application_name like '${prefix}%'
            and a.wait_event_type='Lock' and a.wait_event in('tuple','transactionid') and exists(select 1 from pg_locks l where l.pid=a.pid and l.locktype='advisory' and l.classid=62803 and l.objid=0 and l.granted);`)), 0,
          "a blocked owner/generation waiter must not already own candidate lock L");
          const results = (await Promise.all(workers.map((handle) => handle.complete))).map(healthy).map(one);
          for (let index = 0; index < results.length; index++) {
            const value = results[index];
            // The capture executes the real statement but does not pass along its row result.
            // Only these documented lifecycle refusals may follow a successful clear/deletion.
            if (value.state !== "00000") {
              assert.ok(index !== 0, `clear/delete failed: ${JSON.stringify(value)}`);
              const lease = index === 3 && value.state === "42501" && /mail run no longer owns the lease/.test(value.message);
              const gone = deletion && value.state === "23503" && /sample owner no longer exists/.test(value.message);
              assert.ok(lease || gone, `unexpected worker error: ${JSON.stringify(value)}`);
            }
          }
          assert.equal(await scalar(`select count(*) from public.parcels where user_id='${owner}';`), "0"); assert.equal(await journalCount(), "0");
          assert.equal(await scalar(`select count(*) from public.parcels where id='${otherParcel}';`), "1"); completed++;
        } finally {
          if (!controller.state.exited) await release(controller);
          await Promise.allSettled(workers.map((handle) => handle.complete));
        }
      }
      assert.equal(completed, rounds); assert.equal(contention, rounds);
      console.log(`OK: UGELR natural clear/delete versus receive/undo/mail/manual: ${completed} completed synchronized rounds, ${contention} real lock-contention observations; no unexpected refusal/deadlock/timeout`);
    }
    await sql(`delete from auth.users where id in('${owner}','${other}'); drop function public.test_capture_receipt_error(text);`);
    await file(`supabase/rollback/${stem}.down.sql`); await file(`supabase/rollback/${stem}.down.sql`);
    await sql(`delete from supabase_migrations.schema_migrations where version='${stem.slice(0, 14)}';`);
    assert.equal(await scalar("select pg_get_functiondef('public.purge_old_screen_events()'::regprocedure);"), originalPurge, "rollback must restore the exact existing consent purge definition");
    assert.equal(await scalar("select coalesce(relacl::text,'') from pg_class where oid='public.parcels'::regclass;"), parcelGrants, "rollback must preserve existing native parcel grants");
    await verify("supabase/verify/20261113110000_sample_generation.sql");
    await file(`supabase/migrations/${stem}.sql`); await verify(`supabase/verify/${stem}.sql`);
    await sql(`insert into supabase_migrations.schema_migrations(version,name) values('${stem.slice(0, 14)}','received_receipts');`);
    console.log("OK: rollback twice retains existing 110000 contract; reapply+verify passed");
  } finally { try { await cleanup(); } finally { process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop); } }
  console.log(`verdict=OK mode=${negative ? "negative-control" : "positive"}`);
}

const help = `Usage: node tests/postgres/run-received-receipts.mjs [--self-test|--negative-control|--help]
No flag: create a disposable PostgreSQL17 cluster, apply actual dependencies, before/apply twice/verify,
record history only after successful real migration, reject isolated missing prerequisites, test 24h expiry/replay/daily cleanup,
run temporal/native-writer/concurrent SQL, rollback twice/reapply/verify, stop own cluster, verify listener=0, delete its data/logs.
--self-test: no PostgreSQL startup or network; parser/orchestration checks and dummy child processes only.
--negative-control: require actual old client-status restore and pre-fix no-op mail core to violate delivered invariants.
Only dedicated 127.0.0.1:${port}; no external-server/connection-string option; inherited PG* settings are removed.
Optional OTODOKE_PG_BINDIR selects local binaries (default PATH); OTODOKE_RECEIPT_PG_ROUNDS=2..100 (default10).
The target migration/verifiers and real PostgreSQL behaviour must be measured outside the restricted authoring environment.`;
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const flags = process.argv.slice(2);
  if (flags.some((flag) => !["--help", "--self-test", "--negative-control"].includes(flag)) || flags.length > 1) {
    console.error(help); process.exitCode = 2;
  } else if (flags.includes("--help")) console.log(help);
  else (flags.includes("--self-test") ? selfTest() : main(flags.includes("--negative-control"))).catch((error) => {
    console.error(`verdict=FAILED ${error.stack ?? error}`); process.exitCode = 1;
  });
}
