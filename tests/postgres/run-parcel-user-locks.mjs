import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cleanEnvironment } from "./run-parcel-conflicts.mjs";
import { migrationFiles, startChild } from "./run-sample-lock-order.mjs";
import { taggedResults } from "./run-cost-guards.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const baseline = "c71fd4b";
const targets = ["20261113100000_parcel_write_conflicts.sql", "20261113110000_sample_generation.sql"];
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const userA = uuid(1);
const userB = uuid(2);
const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
const json = (value) => `${quote(JSON.stringify(value))}::jsonb`;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function one(output) {
  const results = taggedResults(output);
  assert.equal(results.length, 1, "one terminal JSON result is required");
  return JSON.parse(results[0]);
}

function successful(result) {
  assert.equal(result.timedOut, false, "a process timeout is not successful completion");
  assert.equal(result.signal, null, "a killed process is not successful completion");
  assert.equal(result.code, 0, result.stderr || "psql did not complete");
  assert.doesNotMatch(result.stderr, /\b(?:ERROR|FATAL|PANIC):/i);
  return result.stdout;
}

function createCall(owner, email, run, order) {
  return `select 'RESULT:' || row_to_json(r)::text from public.create_mail_parcel('[]'::jsonb,
    ${json({ user_id: owner, shop: "Synthetic shop", order_number: order, status: "shipped" })},
    ${json([{ name: "Synthetic item", quantity: 1, unit_price: 1000, evidence: "Synthetic" }])},'${email}','${run}') r;`;
}

async function main(negative, baseOnly) {
  assert.ok(process.argv.includes("--external-test-server"), "an explicitly supplied disposable external test server is required");
  const port = Number(process.env.OTODOKE_PARCEL_USER_PG_PORT);
  assert.ok(Number.isSafeInteger(port) && port >= 1024 && port <= 65535, "OTODOKE_PARCEL_USER_PG_PORT must name a dedicated test port");
  const parent = path.join(root, ".vitest/pg");
  await mkdir(parent, { recursive: true });
  const scratch = await mkdtemp(path.join(parent, "parcel-user-locks-"));
  const environment = cleanEnvironment(scratch);
  const executable = path.join(process.env.OTODOKE_PG_BINDIR ?? "", "psql");
  const database = `otodoke_parcel_user_${Date.now()}_${process.pid}`;
  const summary = { mode: negative ? "old-global-negative-control" : "user-isolation", stage: baseOnly ? "100000-only" : "through-110000", probes: [], expected_rejections: [], sql_sha256: {}, sql_source: negative ? baseline : "working tree",
    sql_errors: 0, timeouts: 0, deadlocks: 0, operations_started: 0, completed_operations: 0, verdict: "FAILED", database, port };
  const children = new Set();
  let interrupted = false;
  const requestStop = () => { interrupted = true; for (const handle of children) handle.child.kill("SIGTERM"); };
  process.once("SIGINT", requestStop);
  process.once("SIGTERM", requestStop);
  const args = (db) => ["-X", "-w", "-q", "-A", "-t", "-h", "127.0.0.1", "-p", String(port), "-U", "postgres", "-d", db, "-v", "ON_ERROR_STOP=1", "-v", "VERBOSITY=verbose"];
  const preamble = "set statement_timeout='12s'; set lock_timeout='8s'; set deadlock_timeout='100ms';\n";
  const launch = (input, { db = database, interactive = false, operation = false } = {}) => {
    assert.equal(interrupted, false, "test interrupted; only owned clients are being closed");
    const handle = startChild(executable, args(db), { environment, input: preamble + input, interactive });
    children.add(handle);
    if (operation) summary.operations_started++;
    handle.complete.then((result) => {
      children.delete(handle);
      if (operation) summary.completed_operations++;
      if (result.timedOut || result.signal || /\b(?:55P03|57014)\b/.test(result.stderr)) summary.timeouts++;
      if (/\b40P01\b/.test(result.stderr)) summary.deadlocks++;
      if (result.code !== 0 || /\b(?:ERROR|FATAL|PANIC):/i.test(result.stderr)) summary.sql_errors++;
    });
    return handle;
  };
  const sql = async (input, db = database) => successful(await launch(input, { db }).complete);
  const acl = async () => one(await sql(`select 'RESULT:' || jsonb_build_object(
    'parcels',jsonb_build_array(has_table_privilege('authenticated','public.parcels','SELECT'),has_table_privilege('authenticated','public.parcels','INSERT'),has_table_privilege('authenticated','public.parcels','UPDATE'),has_table_privilege('authenticated','public.parcels','DELETE')),
    'parcel_items',jsonb_build_array(has_table_privilege('authenticated','public.parcel_items','SELECT'),has_table_privilege('authenticated','public.parcel_items','INSERT'),has_table_privilege('authenticated','public.parcel_items','UPDATE'),has_table_privilege('authenticated','public.parcel_items','DELETE')),
    'service_parcels',jsonb_build_array(has_table_privilege('service_role','public.parcels','SELECT'),has_table_privilege('service_role','public.parcels','INSERT'),has_table_privilege('service_role','public.parcels','UPDATE'),has_table_privilege('service_role','public.parcels','DELETE')),
    'rls',(select bool_and(relrowsecurity) from pg_class where oid in ('public.parcels'::regclass,'public.parcel_items'::regclass)))::text;`));
  const key = async (owner) => Number((await sql(`select (hashtext('${owner}'::uuid::text)::bigint+4294967296)%4294967296;`)).trim());
  const waitFor = async (condition, label, handles = []) => {
    const until = Date.now() + 5000;
    while (Date.now() < until) {
      if (await condition()) return;
      for (const handle of handles) assert.equal(handle.state.exited, false, `worker exited before ${label}: ${handle.state.stderr}`);
      await delay(5);
    }
    throw new Error(`timeout observing ${label}; no successful probe was recorded`);
  };
  const seedOwner = async (owner, email, run) => sql(`insert into auth.users(id) values('${owner}') on conflict do nothing;
    ${baseOnly ? "" : `select public.begin_sample_load('${owner}');`} begin;
    select set_config('request.headers',jsonb_build_object('x-otodoke-sample-user','${owner}',
      'x-otodoke-sample-generation',${baseOnly ? "null" : `(select generation from public.sample_generations where user_id='${owner}')`})::text,true);
    insert into public.emails(id,user_id,provider_email_id,processing_status,processing_run_id,processing_lease_until)
      values('${email}','${owner}','synthetic:${email}','pending','${run}',clock_timestamp()+interval '360 seconds'); commit;`);
  const serviceScope = (owner) => `select set_config('request.headers',jsonb_build_object('x-otodoke-sample-user','${owner}',
      'x-otodoke-sample-generation',${baseOnly ? "null" : `(select generation from public.sample_generations where user_id='${owner}')`})::text,true);
    set local role service_role;`;
  const holder = async (owner, name) => {
    const held = launch(`set application_name='${name}'; begin; set local role authenticated;
      set local request.jwt.claim.sub='${owner}'; set local request.headers='{}';
      with changed as(update public.parcels set title=title where user_id='${owner}' and id='${uuid(999)}' returning id)
      select 'RESULT:' || jsonb_build_object('owner',auth.uid(),'changed',(select count(*) from changed),
        'locks',(select coalesce(jsonb_agg(jsonb_build_object('namespace',classid::bigint,'key',objid::bigint,'granted',granted)),'[]'::jsonb)
          from pg_locks where pid=pg_backend_pid() and locktype='advisory' and classid=62803 and granted))::text;
      select 'P1-HELD';\n`, { interactive: true, operation: true });
    await waitFor(() => held.state.stdout.includes("P1-HELD"), "authenticated zero-row update holding its transaction", [held]);
    const info = one(held.state.stdout);
    assert.equal(info.owner, owner); assert.equal(info.changed, 0);
    assert.deepEqual(info.locks, [{ namespace: 62803, key: negative ? 0 : await key(owner), granted: true }]);
    return held;
  };
  const isolationProbe = async (owner, requester, email, run, expectedBlocked, name, kind = "create") => {
    const heldName = `p1-held-${name}`;
    const requestName = `p1-request-${name}`;
    const held = await holder(owner, heldName);
    let operation;
    let observedBlocked = false;
    try {
      const snapshot = one(successful(await launch(`begin; set local role service_role;
        select 'RESULT:' || jsonb_build_object('verdict','snapshot','rows',public.mail_parcel_snapshot('${requester}'))::text; commit;`, { operation: true }).complete));
      assert.equal(snapshot.verdict, "snapshot");
      let query = createCall(requester, email, run, name);
      if (kind !== "create") {
        assert.equal(snapshot.rows.length, 1, "the follow-up must target the parcel created by the earlier real RPC");
        const row = snapshot.rows[0];
        if (kind === "update") query = `select 'RESULT:' || row_to_json(r)::text from public.update_mail_parcel(${json(snapshot.rows)},'${row.id}',${quote(row.updated_at)}::timestamptz,${json({ status: "delivered", last_email_at: "2026-11-12T01:00:00Z" })},null,'[]'::jsonb,'${email}','${run}') r;`;
        else query = `select 'RESULT:' || jsonb_build_object('verdict','owned','rows',public.mail_run_write('${email}','${run}','parcels','update',${json({ title: `Synthetic ${name}` })},${json([{ method: "eq", args: ["id", row.id] }])}))::text;`;
      }
      operation = launch(`set application_name='${requestName}'; begin; set local role service_role; ${query} commit;`, { operation: true });
      const until = Date.now() + 1000;
      while (!operation.state.exited && Date.now() < until) {
        const blocked = Number((await sql(`select count(*) from pg_stat_activity a where a.datname=current_database() and a.application_name='${requestName}' and a.wait_event_type='Lock'
          and exists(select 1 from pg_stat_activity b where b.datname=current_database() and b.application_name='${heldName}' and b.pid=any(pg_blocking_pids(a.pid)));`)).trim());
        if (blocked === 1) { observedBlocked = true; break; }
        await delay(5);
      }
      if (!observedBlocked) assert.equal(operation.state.exited, true, "neither completion nor an observed lock wait is a valid result");
    } finally {
      held.child.stdin.end("rollback;\n");
      successful(await held.complete);
    }
    const result = one(successful(await operation.complete));
    assert.equal(result.verdict, kind === "owned" ? "owned" : "ok", "the real mail RPC must finish after any wait is released");
    if (kind === "owned") { assert.equal(result.rows.length, 1); assert.equal(result.rows[0].user_id, requester); }
    const probe = { name, kind, holder: owner, requester, snapshot_completed_while_held: true, observed_blocked: observedBlocked, expected_blocked: expectedBlocked, completed: true };
    summary.probes.push(probe);
    assert.equal(observedBlocked, expectedBlocked, `${name}: another authenticated user's zero-row UPDATE must not block this user's mail RPC`);
  };
  const expectedRejection = async (name, prefix, query, state, message) => {
    const result = one(successful(await launch(`begin; ${prefix}
      do $p1$ begin ${query}; raise exception 'the required owner rejection did not occur';
        exception when sqlstate '${state}' then
          if sqlerrm<>${quote(message)} then raise; end if;
          perform set_config('otodoke.p1_expected_rejection','true',true);
      end $p1$;
      select 'RESULT:' || jsonb_build_object('rejected',current_setting('otodoke.p1_expected_rejection',true)='true','state','${state}')::text;
      rollback;`, { operation: true }).complete));
    assert.deepEqual(result, { rejected: true, state });
    summary.expected_rejections.push({ name, ...result });
  };
  try {
    assert.equal((await sql("show listen_addresses;", "postgres")).trim(), "127.0.0.1");
    assert.match(await sql("show server_version;", "postgres"), /^17\./);
    assert.equal((await sql("show port;", "postgres")).trim(), String(port));
    await sql(`create database "${database}";`, "postgres");
    assert.equal(Number((await sql("select count(*) from pg_roles where rolname in ('anon','authenticated','service_role');")).trim()), 3);
    await sql((await readFile(path.join(root, "tests/postgres/bootstrap.sql"), "utf8")).replace(/^create role (?:anon|authenticated|service_role)\b[^;]*;\s*/gm, ""));
    for (const name of migrationFiles(await readdir(path.join(root, "supabase/migrations")))) {
      if (name === "20261106180000_screen_events_daily_purge.sql") continue;
      if (baseOnly && name.slice(0, 14) > targets[0].slice(0, 14)) continue;
      if (name === targets[0]) summary.acl_before = await acl();
      let source = await readFile(path.join(root, "supabase/migrations", name), "utf8");
      if (negative && targets.includes(name)) {
        const original = await startChild("/usr/bin/git", ["show", `${baseline}:supabase/migrations/${name}`], { environment }).complete;
        source = successful(original);
      }
      if (targets.includes(name)) summary.sql_sha256[name] = createHash("sha256").update(source).digest("hex");
      await sql(source);
      if (name === "20261102090000_init.sql") {
        // The small auth-only bootstrap omits the existing authenticated parcels DML grant.
        // Reproduce that permission only in this synthetic database, not a guessed default ACL.
        await sql("grant select,insert,update,delete on public.parcels to authenticated;");
        await sql("grant select,insert,update on public.parcels to service_role;");
        summary.test_substrate = "authenticated parcels SELECT/INSERT/UPDATE/DELETE; service_role parcels SELECT/INSERT/UPDATE; production source grants unchanged";
      }
    }
    summary.acl_after = await acl();
    assert.deepEqual(summary.acl_after, summary.acl_before, "P1 migrations must not tighten or widen the authenticated table grants");
    assert.deepEqual(summary.acl_after, { parcels: [true, true, true, true], parcel_items: [true, false, false, false], service_parcels: [true, true, true, false], rls: true });
    await seedOwner(userA, uuid(11), uuid(21));
    await seedOwner(userB, uuid(12), uuid(22));
    assert.notEqual(await key(userA), await key(userB), "the ordinary different-user control must not be a hash collision");
    await isolationProbe(userA, userB, uuid(12), uuid(22), negative, "different-user-create");
    if (!negative) {
      await isolationProbe(userA, userB, uuid(12), uuid(22), false, "different-user-update", "update");
      await isolationProbe(userA, userB, uuid(12), uuid(22), false, "different-user-owned", "owned");
      await isolationProbe(userA, userA, uuid(11), uuid(21), true, "same-user-create");
      await isolationProbe(userA, userA, uuid(11), uuid(21), true, "same-user-update", "update");
      await isolationProbe(userA, userA, uuid(11), uuid(21), true, "same-user-owned", "owned");
      await expectedRejection("unscoped-service-zero-row", "set local role service_role; set local request.headers='{}';",
        "update public.parcels set title=title where false", "55000", "parcel write requires an explicit owner scope");
      await expectedRejection("authenticated-false-header", `set local role authenticated; set local request.jwt.claim.sub='${userA}'; set local request.headers=${quote(JSON.stringify({ "x-otodoke-sample-user": userB }))};`,
        "update public.parcels set title=title where false", "42501", "parcel header owner must match authenticated user");
      await expectedRejection("transaction-owner-switch", `${serviceScope(userA)} update public.parcels set title=title where false;`,
        `perform public.mail_run_write('${uuid(12)}','${uuid(22)}','parcels','update','{}'::jsonb,'[]'::jsonb)`, "42501", "parcel transaction owner cannot change");
      const countBefore = Number((await sql("select count(*) from public.parcels;")).trim());
      await expectedRejection("mixed-owner-statement", serviceScope(userA),
        `insert into public.parcels(user_id,shop,title,status) values('${userA}','Synthetic','Atomic first row','ordered'),('${userB}','Synthetic','Forbidden second row','ordered')`, "42501", "parcel row does not match its transaction owner");
      assert.equal(Number((await sql("select count(*) from public.parcels;")).trim()), countBefore, "the first row of a rejected mixed-owner statement must roll back too");
      const pair = one(await sql(`with candidates as (
        select md5('p1-collision-'||n)::uuid as id,hashtext((md5('p1-collision-'||n)::uuid)::text) as key from generate_series(1,300000) n
      ), collisions as (select key,array_agg(id order by id) as ids from candidates group by key having count(*)>1 order by key limit 1)
      select 'RESULT:' || jsonb_build_object('a',ids[1],'b',ids[2],'key',key)::text from collisions;`));
      assert.notEqual(pair.a, pair.b); assert.equal(await key(pair.a), await key(pair.b));
      summary.hash_collision = pair;
      await seedOwner(pair.a, uuid(13), uuid(23)); await seedOwner(pair.b, uuid(14), uuid(24));
      await sql(`begin; set local role authenticated; set local request.jwt.claim.sub='${pair.a}';
        insert into public.parcels(id,user_id,shop,title,status) values('${uuid(101)}','${pair.a}','Synthetic protected shop','Protected collision owner','ordered'); commit;`);
      await isolationProbe(pair.a, pair.b, uuid(14), uuid(24), true, "hash-collision");
      const crossOwner = one(successful(await launch(`begin; set local role authenticated; set local request.jwt.claim.sub='${pair.b}';
        with changed as(update public.parcels set title='Cross-owner write must not land' where id='${uuid(101)}' returning id)
        select 'RESULT:' || jsonb_build_object('changed',(select count(*) from changed))::text; commit;`, { operation: true }).complete));
      assert.equal(crossOwner.changed, 0, "a hash collision never changes the UUID-based RLS owner");
      const owners = one(await sql(`select 'RESULT:' || jsonb_build_object(
        'protected',(select user_id='${pair.a}'::uuid and title='Protected collision owner' from public.parcels where id='${uuid(101)}'),
        'created',(select count(*) from public.parcels where user_id='${pair.b}' and order_number='hash-collision'),
        'wrong_owner',(select count(*) from public.parcels where user_id<>'${pair.b}' and order_number='hash-collision'))::text;`));
      assert.deepEqual(owners, { protected: true, created: 1, wrong_owner: 0 });
      summary.collision_owner_invariant = owners;
    }
    assert.deepEqual(await acl(), summary.acl_before);
    assert.equal(summary.operations_started, summary.completed_operations, "every started operation must have a terminal process result");
    assert.equal(interrupted, false, "test interrupted");
    assert.equal(summary.sql_errors, 0); assert.equal(summary.timeouts, 0); assert.equal(summary.deadlocks, 0);
    summary.verdict = "OK";
  } finally {
    for (const handle of children) handle.child.kill("SIGTERM");
    await Promise.allSettled([...children].map((handle) => handle.complete));
    process.removeListener("SIGINT", requestStop);
    process.removeListener("SIGTERM", requestStop);
    await writeFile(path.join(scratch, "summary.json"), JSON.stringify(summary, null, 2));
    console.log(`SUMMARY:${JSON.stringify(summary)}`);
    console.log(`Local summary: ${path.relative(root, path.join(scratch, "summary.json"))}`);
    console.log("External test cluster was not stopped; the dedicated database is retained");
  }
}

function selfTest() {
  const good = { code: 0, signal: null, timedOut: false, stdout: 'RESULT:{"verdict":"ok"}\n', stderr: "" };
  assert.deepEqual(one(successful(good)), { verdict: "ok" });
  for (const change of [{ code: 1 }, { signal: "SIGTERM" }, { timedOut: true }, { stderr: "ERROR:  40P01: deadlock detected" }]) assert.throws(() => successful({ ...good, ...change }));
  for (const output of ["", "RESULT:{}\nRESULT:{}\n", "RESULT:bad\n"]) assert.throws(() => one(output));
  assert.match(createCall(userB, uuid(12), uuid(22), "synthetic"), /row_to_json\(r\)/);
  console.log("OK: self-test; failed/missing/timeout results cannot become successful user-isolation probes");
  console.log("NOT RUN: PostgreSQL or concurrency");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const allowed = new Set(["--external-test-server", "--negative-control", "--self-test", "--base-only"]);
  if (args.some((arg) => !allowed.has(arg)) || new Set(args).size !== args.length || args.includes("--self-test") && args.length !== 1) process.exitCode = 2;
  else if (args.includes("--self-test")) selfTest();
  else main(args.includes("--negative-control"), args.includes("--base-only")).catch((error) => { console.error(`verdict=FAILED: ${error.message}`); process.exitCode = 1; });
}
