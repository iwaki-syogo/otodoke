import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCommand, selfTestVerifyFiles, taggedResults, verifyFile } from "./run-cost-guards.mjs";

// Importing the shared runner is safe: its CLI has an import.meta.url main guard.
// Only the CLI's --self-test path is exercised while this runner is authored.
const root = fileURLToPath(new URL("../../", import.meta.url));
const migration = "20261113100000_parcel_write_conflicts";
const gate = "183765132, 1";
const bin = process.env.OTODOKE_PG_BINDIR ?? "";
const uuid = (number) => `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`;
const user = uuid(1);
const emails = [uuid(10), uuid(11)];
const runs = [uuid(20), uuid(21)];
const items = [{ name: "Long synthetic item", quantity: 1, unit_price: 1000, evidence: "Synthetic" }];
const values = { user_id: user, shop: "Synthetic shop", shop_key: "other", order_number: "ORDER-12345678", status: "ordered", total_amount: 1000 };
const softValues = { ...values, order_number: null, tracking_number: "SYNTHETIC-TRACKING-A", status: "shipped" };
const softItems = [{ ...items[0], name: "Synthetic soft item A" }];
const exactItems = [{ ...items[0], name: "Synthetic exact item B" }];
const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
const json = (value) => `${quote(JSON.stringify(value))}::jsonb`;

export function priorMigrations(names) {
  return names.filter((name) => /^\d{14}_.+\.sql$/.test(name) && name.slice(0, 14) < migration.slice(0, 14)).sort();
}

export function cleanEnvironment(scratch, inherited = process.env) {
  const environment = Object.fromEntries(Object.entries(inherited).filter(([key]) => !key.startsWith("PG")));
  return { ...environment, LC_ALL: "C", LANG: "C", PGPASSFILE: path.join(scratch, "no-password-file"),
    PGSERVICEFILE: path.join(scratch, "no-service-file"), PGSYSCONFDIR: scratch, PGCONNECT_TIMEOUT: "3" };
}

const beforeSteps = [
  ["verify", `supabase/verify/${migration}.inventory.sql`],
  ["verify", `supabase/verify/${migration}.before.sql`],
  ["file", `supabase/migrations/${migration}.sql`],
  ["file", `supabase/migrations/${migration}.sql`],
  ["verify", `supabase/verify/${migration}.sql`],
];
const afterSteps = [
  ["file", `supabase/rollback/${migration}.down.sql`],
  ["file", `supabase/rollback/${migration}.down.sql`],
  ["verify", "supabase/verify/20261113090000_claude_call_global_lock.sql"],
  ["file", `supabase/migrations/${migration}.sql`],
  ["verify", `supabase/verify/${migration}.sql`],
];

const createCall = (snapshot, index, changes = values, firstItems = items) =>
  `select 'RESULT:' || row_to_json(r)::text from public.create_mail_parcel(${json(snapshot)},${json(changes)},${json(firstItems)},'${emails[index]}','${runs[index]}') r`;
const updateCall = (snapshot, parcel, version, index, changes, category = null, firstItems = items) =>
  `select 'RESULT:' || row_to_json(r)::text from public.update_mail_parcel(${json(snapshot)},'${parcel}',${quote(version)}::timestamptz,${json(changes)},${category === null ? "null" : json(category)},${json(firstItems)},'${emails[index]}','${runs[index]}') r`;
const ensureCall = (parcel, version, index, firstItems = items) =>
  `select 'RESULT:' || row_to_json(r)::text from (select * from public.ensure_mail_parcel_items('${parcel}',${quote(version)}::timestamptz,${json(firstItems)},'${emails[index]}','${runs[index]}')) r`;
const legacyWorker = (index) => ({
  prepare: `create temp table old_candidates as select id from public.parcels where user_id='${user}' and order_number=${quote(values.order_number)};`,
  query: `select 'RESULT:' || jsonb_build_object('legacy_rows',jsonb_array_length(public.mail_run_write('${emails[index]}','${runs[index]}','parcels','insert',${json(values)},'[]')))::text where not exists(select 1 from old_candidates)`,
});

function assertLegacyDuplicates(results, rows, orders) {
  assert.deepEqual(results.map((result) => result.legacy_rows), [1, 1]);
  assert.equal(rows, 2, "the original read-then-insert path must actually create two parcels");
  assert.equal(orders, 1, "the two parcels must share the same order number");
}

function oneResult(output) {
  const results = taggedResults(output);
  assert.equal(results.length, 1, `expected one tagged result: ${output}`);
  return JSON.parse(results[0]);
}

async function listening(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    const finish = (result) => { socket.destroy(); resolve(result); };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(500, () => finish(false));
  });
}

async function selfTest() {
  assert.deepEqual(priorMigrations([`${migration}.sql`, "20261113100000_another_same_timestamp.sql", "20261114090000_future.sql", "notes.md",
    "20261113090000_claude_call_global_lock.sql", "20261112180000_ai_reading_consent.sql"]),
  ["20261112180000_ai_reading_consent.sql", "20261113090000_claude_call_global_lock.sql"]);
  const environment = cleanEnvironment("local-scratch", { PGHOST: "remote.invalid", PGPORT: "5432", PGPASSFILE: "secret", PGSERVICE: "remote", PATH: "synthetic", KEEP: "yes" });
  assert.equal(environment.PGHOST, undefined);
  assert.equal(environment.PGPORT, undefined);
  assert.equal(environment.PGSERVICE, undefined);
  assert.equal(environment.PGPASSFILE, path.join("local-scratch", "no-password-file"));
  assert.equal(environment.KEEP, "yes");
  assert.equal(beforeSteps.filter(([kind]) => kind === "file").length, 2);
  assert.deepEqual(afterSteps.slice(0, 2), [["file", `supabase/rollback/${migration}.down.sql`], ["file", `supabase/rollback/${migration}.down.sql`]]);
  await selfTestVerifyFiles([...beforeSteps, ...afterSteps].filter(([kind]) => kind === "verify").map(([, name]) => name));
  assert.deepEqual(oneResult('RESULT:{"verdict":"retry","parcel_id":null}\n'), { verdict: "retry", parcel_id: null });
  assert.throws(() => oneResult("RESULT:{}\nRESULT:{}\n"));
  assert.match(createCall([], 0), /public\.create_mail_parcel\('\[\]'::jsonb/);
  assert.match(updateCall([], uuid(30), "2026-11-12T00:00:00Z", 1, { received_at: null }), /public\.update_mail_parcel/);
  assert.match(updateCall([], uuid(30), "2026-11-12T00:00:00Z", 1, { order_number: values.order_number }, null, exactItems), /"order_number":"ORDER-12345678"/);
  assert.equal(softValues.order_number, null);
  assert.notEqual(softItems[0].name, exactItems[0].name);
  assert.match(ensureCall(uuid(30), "2026-11-12T00:00:00Z", 0), /public\.ensure_mail_parcel_items/);
  assert.match(legacyWorker(0).prepare, /create temp table old_candidates as select/);
  assert.match(legacyWorker(0).query, /public\.mail_run_write/);
  assert.doesNotMatch(legacyWorker(0).query, /create_mail_parcel|update_mail_parcel|ensure_mail_parcel_items/);
  assertLegacyDuplicates([{ legacy_rows: 1 }, { legacy_rows: 1 }], 2, 1);
  assert.throws(() => assertLegacyDuplicates([{ legacy_rows: 1 }, { legacy_rows: 0 }], 1, 1));
  assert.throws(() => assertLegacyDuplicates([{ legacy_rows: 1 }, { legacy_rows: 1 }], 1, 1));
  assert.throws(() => assertLegacyDuplicates([{ legacy_rows: 1 }, { legacy_rows: 1 }], 2, 2));
  const dummy = (source, options = {}) => runCommand(process.execPath, ["-e", source], options);
  await dummy("process.stdout.write('OK\\n')");
  await assert.rejects(dummy("process.stderr.write('ERROR: synthetic SQL failure\\n'); process.exit(0)"), /synthetic SQL failure/);
  await assert.rejects(dummy("process.exit(1)"), /failed/);
  await assert.rejects(dummy("setTimeout(() => {}, 10000)", { timeout: 20 }), /SIGTERM/);
  console.log("OK: self-test (dependency boundary, PG environment isolation, lifecycle order, verdict/results, SQL builders, child errors and timeout)");
  console.log("NOT RUN: PostgreSQL startup, migrations, SQL behaviour, concurrent scenarios and SQL negative control");
}

async function main(negative, external) {
  const port = external ? Number(process.env.OTODOKE_PARCEL_PG_PORT) : 65441;
  assert.ok(Number.isSafeInteger(port) && port >= 1024 && port <= 65535, "a dedicated test port is required");
  if (!external) assert.equal(await listening(port), false, `port ${port} is occupied; no existing process was stopped`);
  const rounds = Number(process.env.OTODOKE_PARCEL_PG_ROUNDS ?? 5);
  assert.ok(Number.isSafeInteger(rounds) && rounds >= 1 && rounds <= 100, "round count must be an integer from 1 to 100");
  const parent = path.join(root, ".vitest/pg");
  await mkdir(parent, { recursive: true });
  const scratch = await mkdtemp(path.join(parent, "parcel-"));
  const data = path.join(scratch, "data");
  const environment = cleanEnvironment(scratch);
  const database = external ? `otodoke_parcel_conflicts_${Date.now()}_${process.pid}` : "postgres";
  const source = await readFile(path.join(root, `supabase/migrations/${migration}.sql`));
  const summary = { mode: negative ? "legacy-duplicate-negative-control" : "parcel-conflicts", database, port, rounds,
    sql_source: "working tree", sql_sha256: negative ? {} : { [`${migration}.sql`]: createHash("sha256").update(source).digest("hex") }, verdict: "FAILED" };
  let interrupted = false;
  let startAttempted = false;
  let passed = false;
  let cleanupPromise;
  const raw = (name, args, options = {}) => runCommand(path.join(bin, name), args, { environment, ...options });
  const command = (name, args, options) => interrupted ? Promise.reject(new Error("test interrupted; cleaning up")) : raw(name, args, options);
  const psqlArgs = ["-X", "-w", "-q", "-A", "-t", "-h", "127.0.0.1", "-p", String(port), "-U", "postgres", "-d", database, "-v", "ON_ERROR_STOP=1"];
  const sql = (input) => command("psql", psqlArgs, { input: `set statement_timeout='10s'; set lock_timeout='5s'; set request.headers=${quote(JSON.stringify({ "x-otodoke-sample-user": user }))}; ${input}` });
  const file = (name) => name === `supabase/migrations/${migration}.sql`
    ? command("psql", psqlArgs, { input: source })
    : command("psql", [...psqlArgs, "-f", path.join(root, name)]);
  const verify = async (name) => {
    const output = await verifyFile(name, file);
    console.log(`OK: ${name}: ${output.trim()}`);
  };
  const steps = async (plan) => { for (const [kind, name] of plan) await (kind === "verify" ? verify(name) : file(name)); };
  const snapshot = async () => JSON.parse((await sql(`select public.mail_parcel_snapshot('${user}');`)).trim());
  const scalar = async (query) => (await sql(query)).trim();
  const count = async (table) => Number(await scalar(`select count(*) from public.${table};`));
  const reset = async () => {
    await sql(`delete from public.parcels where user_id='${user}'; delete from public.emails where user_id='${user}';
      insert into public.emails(id,user_id,processing_status,processing_run_id,processing_lease_until) values
      ${emails.map((email, index) => `('${email}','${user}','pending','${runs[index]}',clock_timestamp()+interval '360 seconds')`).join(",")};`);
  };

  // The controller opens one shared gate only after every worker is observed waiting there.
  // A legacy worker reads its candidates in prepare, so the negative control proves the
  // real read-then-insert race without changing an RPC into a fake unlocked replacement.
  const concurrent = async (workers) => {
    const controller = spawn(path.join(bin, "psql"), psqlArgs, { cwd: root, env: environment, stdio: ["pipe", "pipe", "pipe"] });
    let output = "";
    let errors = "";
    let exited = false;
    let workerFailure = null;
    const timer = setTimeout(() => controller.kill("SIGTERM"), 30_000);
    const complete = new Promise((resolve, reject) => {
      controller.on("error", (error) => { clearTimeout(timer); reject(error); });
      controller.on("close", (code) => {
        clearTimeout(timer);
        exited = true;
        if (code !== 0 || /\b(?:ERROR|FATAL):/i.test(errors)) reject(new Error(`parcel gate failed: ${errors}`));
        else resolve();
      });
    });
    complete.catch(() => {});
    controller.stdin.on("error", () => {});
    controller.stdout.on("data", (chunk) => { output += chunk; });
    controller.stderr.on("data", (chunk) => { errors += chunk; });
    const waitFor = async (check, label) => {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        if (workerFailure) throw workerFailure;
        if (await check()) return;
        if (exited) throw new Error(`gate exited before ${label}: ${errors}`);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error(`timed out waiting for ${label}`);
    };
    controller.stdin.write(`begin; select pg_advisory_xact_lock(${gate}); select 'gate-ready';\n`);
    let pending = [];
    try {
      await waitFor(() => output.includes("gate-ready"), "gate-ready");
      pending = workers.map(({ query, prepare = "" }, index) => sql(`set application_name='parcel-worker-${index}'; begin;
        ${prepare} select pg_advisory_xact_lock_shared(${gate}); ${query}; commit;`));
      for (const worker of pending) worker.catch((error) => { workerFailure ??= error; });
      await waitFor(async () => Number(await scalar("select count(*) from pg_stat_activity where application_name like 'parcel-worker-%' and wait_event='advisory';")) === workers.length, "every worker at the gate");
      controller.stdin.end("commit;\n");
      await complete;
      return (await Promise.all(pending)).map(oneResult);
    } finally {
      if (!exited) controller.stdin.end("rollback;\n");
      await complete;
      await Promise.allSettled(pending);
    }
  };

  const cleanup = () => (cleanupPromise ??= (async () => {
    await writeFile(path.join(scratch, "summary.json"), JSON.stringify(summary, null, 2));
    if (external) {
      console.log(`SUMMARY:${JSON.stringify(summary)}`);
      console.log(`External test cluster was not stopped; database ${database} retained`);
      console.log(`Local logs retained under ${path.relative(root, scratch)}`);
      return;
    }
    // Inspect only this disposable directory even when a timed-out start might have succeeded.
    if (startAttempted && await raw("pg_ctl", ["-D", data, "status"]).then(() => true, () => false)) {
      await raw("pg_ctl", ["-D", data, "-t", "10", "-m", "fast", "stop"]);
    }
    assert.equal(await listening(port), false, `listener remains on 127.0.0.1:${port}`);
    console.log(`OK: cleanup, no listener on 127.0.0.1:${port}`);
    console.log(`Local logs retained under ${path.relative(root, scratch)}`);
  })());
  const requestStop = () => { interrupted = true; };
  process.once("SIGINT", requestStop);
  process.once("SIGTERM", requestStop);
  try {
    if (external) {
      const adminArgs = psqlArgs.map((arg) => arg === database ? "postgres" : arg);
      assert.match(await command("psql", adminArgs, { input: "show server_version;" }), /^17\./);
      assert.equal((await command("psql", adminArgs, { input: "show listen_addresses;" })).trim(), "127.0.0.1");
      await command("psql", adminArgs, { input: `create database "${database}";` });
    } else {
      assert.match(await command("initdb", ["--version"]), /PostgreSQL\) 17\./);
      await command("initdb", ["-D", data, "-U", "postgres", "--no-sync", "-c", "dynamic_shared_memory_type=mmap", "-c", "shared_memory_type=mmap"]);
      startAttempted = true;
      await command("pg_ctl", ["-D", data, "-l", path.join(scratch, "server.log"), "-t", "10", "-o",
        `-k '${parent.replaceAll("'", "'\\''")}' -h 127.0.0.1 -p ${port} -c dynamic_shared_memory_type=mmap -c shared_memory_type=mmap`, "start"]);
    }
    assert.equal(await listening(port), true);
    assert.equal(await scalar("show listen_addresses;"), "127.0.0.1");
    assert.equal(Number(await scalar("show port;")), port);
    if (external) {
      assert.equal(Number(await scalar("select count(*) from pg_roles where rolname in ('anon','authenticated','service_role');")), 3);
      await sql((await readFile(path.join(root, "tests/postgres/bootstrap.sql"), "utf8")).replace(/^create role (?:anon|authenticated|service_role)\b[^;]*;\s*/gm, ""));
    } else await file("tests/postgres/bootstrap.sql");
    for (const name of priorMigrations(await readdir(path.join(root, "supabase/migrations")))) {
      if (name === "20261106180000_screen_events_daily_purge.sql") console.log(`SKIP: ${name} (pg_cron schedule only; vanilla local PostgreSQL has no pg_cron)`);
      else await file(`supabase/migrations/${name}`);
    }
    await sql(`insert into auth.users(id) values ('${user}');`);

    if (negative) {
      await steps(beforeSteps.slice(0, 2));
      for (let round = 0; round < rounds; round++) {
        await reset();
        const results = await concurrent(emails.map((_email, index) => legacyWorker(index)));
        assertLegacyDuplicates(results, await count("parcels"), Number(await scalar("select count(distinct order_number) from public.parcels;")));
      }
      console.log(`OK: NEGATIVE CONTROL, original read + mail_run_write insert duplicated one order (${rounds} gate-synchronized rounds; fixed RPCs not used)`);
    } else {
      // These scenarios test the SQL RPC boundary, not JavaScript chooseParcel or the full pipeline.
      console.log("SCOPE: RPC-boundary SQL concurrency; JavaScript chooseParcel and the full pipeline are not executed");
      await steps(beforeSteps);
      for (let round = 0; round < rounds; round++) {
        await reset();
        const before = await snapshot();
        const results = await concurrent([0, 1].map((index) => ({ query: createCall(before, index) })));
        assert.deepEqual(results.map((result) => result.verdict).sort(), ["ok", "retry"]);
        assert.equal(await count("parcels"), 1);
        assert.equal(await count("parcel_items"), items.length);
        const parcel = results.find((result) => result.verdict === "ok").parcel_id;
        const loser = results.findIndex((result) => result.verdict === "retry");
        const version = await scalar(`select updated_at from public.parcels where id='${parcel}';`);
        assert.equal(oneResult(await sql(ensureCall(parcel, version, loser))).verdict, "ok");
        assert.equal(await count("parcel_items"), items.length, "the second mail must not duplicate first items");
      }
      console.log(`OK: B1 same-order concurrent create, retry, first-items-once (${rounds} synchronized rounds)`);

      for (let round = 0; round < rounds; round++) {
        await reset();
        const soft = uuid(30);
        await sql(`insert into public.parcels(id,user_id,shop,status,tracking_number) values('${soft}','${user}','Synthetic shop','shipped',${quote(softValues.tracking_number)});
          insert into public.parcel_items(parcel_id,user_id,name) values('${soft}','${user}',${quote(softItems[0].name)});`);
        const before = await snapshot();
        const version = await scalar(`select updated_at from public.parcels where id='${soft}';`);
        const results = await concurrent([
          { query: createCall(before, 0, values, exactItems) },
          { query: updateCall(before, soft, version, 1, { order_number: values.order_number }, null, exactItems) },
        ]);
        assert.deepEqual(results.map((result) => result.verdict).sort(), ["ok", "retry"]);
        assert.equal(Number(await scalar(`select count(*) from public.parcels where order_number=${quote(values.order_number)};`)), 1, "the same order must not be attached to both the old soft parcel and the new exact parcel");
        if (results[0].verdict === "ok") {
          assert.equal(await count("parcels"), 2);
          assert.equal(await scalar(`select order_number is null from public.parcels where id='${soft}';`), "t", "stale soft selection must not acquire an order already assigned to the new exact candidate");
        } else assert.equal(await count("parcels"), 1);
      }
      console.log(`OK: B1 soft P (tracking + item A) versus exact Q (order + item B), same-order count stays one (${rounds} synchronized rounds; RPC boundary)`);

      await reset();
      const parcel = oneResult(await sql(createCall(await snapshot(), 0, softValues, softItems))).parcel_id;
      const before = await snapshot();
      const version = await scalar(`select updated_at from public.parcels where id='${parcel}';`);
      assert.equal(oneResult(await sql(createCall(before, 1, values, exactItems))).verdict, "ok");
      const stale = oneResult(await sql(updateCall(before, parcel, version, 0, { order_number: values.order_number }, null, exactItems)));
      assert.equal(stale.verdict, "retry");
      assert.equal(await scalar(`select order_number is null from public.parcels where id='${parcel}';`), "t");
      assert.equal(Number(await scalar(`select count(*) from public.parcels where order_number=${quote(values.order_number)};`)), 1);
      console.log("OK: B1 exact Q appears after the old snapshot; P cannot acquire Q's order (deterministic RPC boundary)");

      await reset();
      const received = oneResult(await sql(createCall(await snapshot(), 0, { ...values, status: "shipped" }))).parcel_id;
      const oldSnapshot = await snapshot();
      const oldVersion = await scalar(`select updated_at from public.parcels where id='${received}';`);
      const receivedAt = "2026-11-12T00:00:00.000Z";
      // Supabase supplies these platform grants; the vanilla auth-only bootstrap does not.
      // They exist only in this disposable cluster, so the manual path can exercise real RLS.
      await sql("grant usage on schema public to authenticated; grant select,update on public.parcels to authenticated;");
      await sql(`set role authenticated; set request.jwt.claim.sub='${user}';
        update public.parcels set status='delivered',received_at='${receivedAt}' where id='${received}';`);
      assert.equal(oneResult(await sql(updateCall(oldSnapshot, received, oldVersion, 1, { status: "shipped" }))).verdict, "retry");
      assert.equal(await scalar(`select status='delivered' and received_at='${receivedAt}'::timestamptz from public.parcels where id='${received}';`), "t");
      const newSnapshot = await snapshot();
      const newVersion = await scalar(`select updated_at from public.parcels where id='${received}';`);
      assert.equal(oneResult(await sql(updateCall(newSnapshot, received, newVersion, 1, { expected_date: "2026-11-13" }, null))).verdict, "ok");
      assert.equal(await scalar(`select status='delivered' and received_at='${receivedAt}'::timestamptz and expected_date='2026-11-13'::date from public.parcels where id='${received}';`), "t");
      console.log("OK: B2 stale mail write after a manual receive retries; fresh harmless update keeps the receive");

      const namesBefore = await snapshot();
      const parentVersion = await scalar(`select updated_at from public.parcels where id='${received}';`);
      await sql(`update public.parcel_items set name='Renamed synthetic item' where parcel_id='${received}';`);
      assert.equal(await scalar(`select updated_at from public.parcels where id='${received}';`), parentVersion);
      assert.equal(oneResult(await sql(createCall(namesBefore, 0))).verdict, "retry");
      console.log("OK: B1 item-name-only changes invalidate a snapshot without relying on a parcel timestamp change");

      await reset();
      const badItems = [...items, { name: null, quantity: 1 }];
      await assert.rejects(sql(createCall(await snapshot(), 0, values, badItems)), /not-null|null value|23502/i);
      assert.equal(await count("parcels"), 0, "a failed first-item insert must roll back its parcel too");
      assert.equal(await count("parcel_items"), 0);
      const emptyParcel = oneResult(await sql(createCall(await snapshot(), 0, values, []))).parcel_id;
      const emptyVersion = await scalar(`select updated_at from public.parcels where id='${emptyParcel}';`);
      await assert.rejects(sql(ensureCall(emptyParcel, emptyVersion, 1, badItems)), /not-null|null value|23502/i);
      assert.equal(await count("parcel_items"), 0, "ensure must roll back the valid item before the invalid one");
      await assert.rejects(sql(updateCall(await snapshot(), emptyParcel, emptyVersion, 1, { status: "shipped" }, null, badItems)), /not-null|null value|23502/i);
      assert.equal(await scalar(`select status='ordered' and updated_at=${quote(emptyVersion)}::timestamptz from public.parcels where id='${emptyParcel}';`), "t", "first-item failure must roll back the preceding parcel update");
      assert.equal(await count("parcel_items"), 0);
      console.log("OK: B1/B2 create, ensure and update all roll back when a later first item fails");

      await sql(`delete from public.parcels where user_id='${user}'; delete from public.emails where user_id='${user}';`);
      await steps(afterSteps);
    }
    passed = true;
    summary.verdict = "OK";
  } finally {
    await cleanup();
    process.removeListener("SIGINT", requestStop);
    process.removeListener("SIGTERM", requestStop);
  }
  assert.equal(passed, true);
  assert.equal(interrupted, false, "test interrupted");
  console.log("verdict=OK");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const allowed = new Set(["--self-test", "--negative-control", "--external-test-server"]);
  if (args.some((arg) => !allowed.has(arg)) || new Set(args).size !== args.length || args.includes("--self-test") && args.length !== 1) {
    console.error("Usage: node tests/postgres/run-parcel-conflicts.mjs [--self-test|--negative-control] [--external-test-server]");
    process.exitCode = 2;
  } else {
    (args[0] === "--self-test" ? selfTest() : main(args.includes("--negative-control"), args.includes("--external-test-server"))).catch((error) => {
      console.error(`verdict=FAILED: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    });
  }
}
