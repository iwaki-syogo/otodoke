import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const migration = "20261113090000_claude_call_global_lock";
const port = 65440;
const bin = process.env.OTODOKE_PG_BINDIR ?? "";
const user = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const users = [1, 2, 3, 4, 5].map(user);
const day = "(now() at time zone 'Asia/Tokyo')::date";
const gate = "183765131, 1";

export function requireVerdict(output, label) {
  const final = output.trim().split(/\r?\n/).at(-1)?.split("|")[0];
  assert.equal(final, "OK", `${label}: final verdict must be OK; got ${JSON.stringify(output)}`);
}

export function taggedResults(output) {
  return output.split(/\r?\n/).filter((line) => line.startsWith("RESULT:")).map((line) => line.slice(7));
}

function cleanEnvironment(scratch) {
  // Explicit connection arguments and empty local config paths prevent inherited service files
  // or password files from selecting a remote database or reading account credentials.
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("PG")));
  return {
    ...environment,
    PGPASSFILE: path.join(scratch, "no-password-file"),
    PGSERVICEFILE: path.join(scratch, "no-service-file"),
    PGSYSCONFDIR: scratch,
    PGCONNECT_TIMEOUT: "3",
  };
}

export function runCommand(executable, args, { environment, input, timeout = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd: root, env: environment, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), timeout);
    child.stdin.on("error", () => {});
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (code !== 0 || /\b(?:ERROR|FATAL):/i.test(stderr)) {
        reject(new Error(`${path.basename(executable)} failed (${signal ?? code}): ${stderr || stdout}`));
      } else resolve(stdout);
    });
    child.stdin.end(input);
  });
}

async function listening() {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    const finish = (answer) => { socket.destroy(); resolve(answer); };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(500, () => finish(false));
  });
}

async function selfTest() {
  requireVerdict("OK|t|OK\n", "good verdict");
  for (const output of ["", "FAILED|t\n", "OK|t\nERROR: broken\n", "DO\n"]) {
    assert.throws(() => requireVerdict(output, "negative verdict"));
  }
  assert.deepEqual(taggedResults("\nRESULT:ok:12\nRESULT:global_limit:\n"), ["ok:12", "global_limit:"]);
  const dummy = (source, options = {}) => runCommand(process.execPath, ["-e", source], options);
  await dummy("process.stdout.write('OK\\n')");
  await assert.rejects(dummy("process.stderr.write('ERROR: SQL failed\\n'); process.exit(0)"), /SQL failed/);
  await assert.rejects(dummy("process.stdout.write('FAILED\\n'); process.exit(1)"), /failed/);
  await assert.rejects(dummy("setTimeout(() => {}, 10000)", { timeout: 20 }), /SIGTERM/);
  console.log("OK: runner self-test (verdict, SQL-error-with-exit-zero, failed exit, timeout)");
}

async function main(negative) {
  assert.equal(await listening(), false, `port ${port} is already in use; no process was stopped`);
  const parent = path.join(root, ".vitest/pg");
  await mkdir(parent, { recursive: true });
  const scratch = await mkdtemp(path.join(parent, "cost-"));
  const data = path.join(scratch, "data");
  const environment = cleanEnvironment(scratch);
  let interruptionRequested = false;
  const rawCommand = (name, args, options) => runCommand(path.join(bin, name), args, { environment, ...options });
  const command = (name, args, options) => {
    if (interruptionRequested) return Promise.reject(new Error("test interrupted; cleaning up the local cluster"));
    return rawCommand(name, args, options);
  };
  const psqlArgs = ["-X", "-w", "-q", "-A", "-t", "-h", "127.0.0.1", "-p", String(port), "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1"];
  const sql = (input) => command("psql", psqlArgs, { input });
  const file = (name) => command("psql", [...psqlArgs, "-f", path.join(root, name)]);
  const verify = async (name) => {
    const output = await file(name);
    requireVerdict(output, name);
    console.log(`OK: ${name}: ${output.trim()}`);
  };
  const reset = async () => {
    await sql("truncate public.claude_call_claims, public.claude_usage_daily restart identity;");
  };

  // Every worker is confirmed waiting on one independent shared gate before it opens. A slow
  // BEFORE write trigger widens the original SUM-to-write race; the fixed day lock serializes it.
  const concurrent = async (queries) => {
    const controller = spawn(path.join(bin, "psql"), psqlArgs, { cwd: root, env: environment, stdio: ["pipe", "pipe", "pipe"] });
    let gateOutput = "";
    let gateError = "";
    let exited = false;
    const controllerTimer = setTimeout(() => controller.kill("SIGTERM"), 30_000);
    const complete = new Promise((resolve, reject) => {
      controller.on("error", (error) => { clearTimeout(controllerTimer); reject(error); });
      controller.on("close", (code) => {
        clearTimeout(controllerTimer);
        exited = true;
        if (code !== 0 || /\b(?:ERROR|FATAL):/i.test(gateError)) reject(new Error(`gate controller failed: ${gateError}`));
        else resolve();
      });
    });
    complete.catch(() => {});
    controller.stdin.on("error", () => {});
    controller.stdout.on("data", (chunk) => { gateOutput += chunk; });
    controller.stderr.on("data", (chunk) => { gateError += chunk; });
    controller.stdin.write(`begin; select pg_advisory_xact_lock(${gate}); select 'gate-ready';\n`);
    const waitFor = async (check, label) => {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        if (await check()) return;
        if (exited) throw new Error(`gate exited before ${label}: ${gateError}`);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error(`timed out waiting for ${label}`);
    };
    let workers = [];
    try {
      await waitFor(() => gateOutput.includes("gate-ready"), "gate-ready");
      workers = queries.map((query, index) => sql(`set application_name = 'cost-worker-${index}'; begin; select pg_advisory_xact_lock_shared(${gate}); ${query}; commit;`));
      // Observe worker rejection immediately, including while waiting for all workers to block.
      for (const worker of workers) worker.catch(() => {});
      await waitFor(async () => Number((await sql("select count(*) from pg_stat_activity where application_name like 'cost-worker-%' and wait_event = 'advisory';")).trim()) === queries.length, "all workers on the gate");
      controller.stdin.end("commit;\n");
      await complete;
      return (await Promise.all(workers)).map((output) => {
        const results = taggedResults(output);
        assert.equal(results.length, 1, `worker must return one tagged result: ${output}`);
        return results[0];
      });
    } finally {
      if (!exited) controller.stdin.end("rollback;\n");
      await complete;
      await Promise.allSettled(workers);
    }
  };

  let started = false;
  let startAttempted = false;
  let passed = false;
  let cleanupPromise;
  const cleanup = () => (cleanupPromise ??= (async () => {
    // Even if pg_ctl timed out after launching the postmaster, stop only our own data directory.
    if (started || startAttempted) {
      const status = await rawCommand("pg_ctl", ["-D", data, "status"]).then(() => true, () => false);
      if (status) await rawCommand("pg_ctl", ["-D", data, "-t", "10", "-m", "fast", "stop"]);
    }
    assert.equal(await listening(), false, `port ${port} still has a listener after cleanup`);
    console.log(`OK: cleanup, no listener on 127.0.0.1:${port}`);
    console.log(`Local test logs retained under ${path.relative(root, scratch)}`);
  })());
  const interrupted = () => {
    // Let an in-flight pg_ctl start finish before cleanup inspects its data directory. Stopping
    // concurrently with startup could miss a postmaster that begins listening one instant later.
    interruptionRequested = true;
  };
  process.once("SIGINT", interrupted);
  process.once("SIGTERM", interrupted);
  try {
    const version = await command("initdb", ["--version"]);
    assert.match(version, /PostgreSQL\) 17\./, "this test expects PostgreSQL 17");
    await command("initdb", ["-D", data, "-U", "postgres", "--no-sync", "-c", "dynamic_shared_memory_type=mmap", "-c", "shared_memory_type=mmap"]);
    // Keep the socket path short enough for macOS's Unix-domain socket limit.
    startAttempted = true;
    await command("pg_ctl", ["-D", data, "-l", path.join(scratch, "server.log"), "-t", "10", "-o", `-k '${parent.replaceAll("'", "'\\''")}' -h 127.0.0.1 -p ${port} -c dynamic_shared_memory_type=mmap -c shared_memory_type=mmap`, "start"]);
    started = true;
    assert.equal(await listening(), true, "new local cluster must be listening");
    assert.equal((await sql("show listen_addresses;")).trim(), "127.0.0.1");
    assert.equal(Number((await sql("show port;")).trim()), port);
    await file("tests/postgres/bootstrap.sql");
    const migrations = (await readdir(path.join(root, "supabase/migrations"))).filter((name) => name.endsWith(".sql") && name <= "20261112100000_\uffff").sort();
    for (const name of migrations) {
      // Homebrew's vanilla server has no pg_cron. Its screen-event schedule is unrelated to
      // the cost functions, mail storage and leases tested here; all other files are unmodified.
      if (name === "20261106180000_screen_events_daily_purge.sql") {
        console.log(`SKIP: ${name} (pg_cron schedule only; not part of this test)`);
      } else await file(`supabase/migrations/${name}`);
    }
    await verify(`supabase/verify/${migration}.before.sql`);
    await file(`supabase/migrations/${migration}.sql`);
    await file(`supabase/migrations/${migration}.sql`);
    await verify(`supabase/verify/${migration}.sql`);
    await sql(`insert into auth.users(id) values ${users.map((id) => `('${id}')`).join(",")};`);
    await sql("create function public.cost_test_slow_write() returns trigger language plpgsql as $$ begin perform pg_sleep(0.08); return new; end $$; create trigger cost_test_slow_write before insert or update on public.claude_usage_daily for each row execute function public.cost_test_slow_write();");

    if (negative) {
      for (const [source, names] of [
        ["20261102110000_claude_usage_limit.sql", ["claim_claude_call"]],
        ["20261112020000_claude_call_release.sql", ["claim_claude_call_v2", "release_claude_call"]],
      ]) {
        const original = await readFile(path.join(root, "supabase/migrations", source), "utf8");
        for (const name of names) {
          const match = original.match(new RegExp(`create (?:or replace )?function public\\.${name}\\([\\s\\S]+?\\$\\$;`, "i"));
          assert.ok(match, `original function ${name} must be found`);
          await sql(match[0].replace(/^create (?:or replace )?function/i, "create or replace function"));
        }
      }
      console.log("NEGATIVE CONTROL: original unlocked v1/v2/release restored in disposable database");
    }

    const claim = (id, legacy = false, personal = 20, global = 2) => legacy
      ? `select 'RESULT:' || public.claim_claude_call('${id}', ${personal}, ${global})`
      : `select 'RESULT:' || verdict || ':' || coalesce(claim_id::text, '') from public.claim_claude_call_v2('${id}', ${personal}, ${global})`;
    const count = async () => Number((await sql(`select coalesce(sum(calls), 0) from public.claude_usage_daily where day = ${day};`)).trim());
    const scenarios = [
      ["different users, new rows, v2", [0, 1, 2, 3].map((i) => claim(users[i]))],
      ["different users, existing rows, v2", [0, 1, 2, 3].map((i) => claim(users[i])), true],
      ["same user, new row, v2", [0, 1, 2, 3].map(() => claim(users[0]))],
      ["different users, v1", [0, 1, 2, 3].map((i) => claim(users[i], true))],
      ["same user, v1", [0, 1, 2, 3].map(() => claim(users[0], true))],
      ["different users, mixed v1/v2", [0, 1, 2, 3].map((i) => claim(users[i], i % 2 === 0))],
    ];
    for (const [label, queries, existing] of scenarios) {
      for (let round = 0; round < 10; round++) {
        await reset();
        await sql(`insert into public.claude_usage_daily(user_id,day,calls) values ('${users[4]}', ${day}, 1)${existing ? users.slice(0, 4).map((id) => `,('${id}',${day},0)`).join("") : ""};`);
        const results = await concurrent(queries);
        assert.equal(results.filter((value) => value.split(":")[0] === "ok").length, 1, `${label}, round ${round}: exactly one claim may succeed (${results})`);
        assert.equal(await count(), 2, `${label}, round ${round}: sum must equal the global limit`);
      }
      console.log(`OK: S1 ${label} (10 rounds, 4 simultaneous requests, one remaining)`);
    }

    for (const legacy of [false, true]) {
      await reset();
      let result = taggedResults(await sql(claim(users[0], legacy, 0, 2)))[0];
      assert.equal(result.split(":")[0], "user_limit", "zero personal limit must reject a new row");
      assert.equal(await count(), 0, "a personal refusal must use no global allowance");
      await sql(`insert into public.claude_usage_daily(user_id,day,calls) values ('${users[0]}',${day},1);`);
      result = taggedResults(await sql(claim(users[0], legacy, 1, 2)))[0];
      assert.equal(result.split(":")[0], "user_limit");
      assert.equal(await count(), 1);
    }
    console.log("OK: S1 personal refusal/new zero-limit row consumes no global allowance (v1/v2)");
    for (let round = 0; round < 10; round++) {
      await reset();
      const held = taggedResults(await sql(claim(users[4], false, 20, 1)))[0].split(":")[1];
      assert.ok(held, "seed claim id required");
      const results = await concurrent([
        `select 'RESULT:released:' || public.release_claude_call(${held}, '${users[4]}')`,
        ...[0, 1, 2, 3].map((i) => claim(users[i], i % 2 === 0, 20, 1)),
      ]);
      assert.equal(results.filter((r) => r === "released:1").length, 1);
      const successes = results.filter((r) => r.split(":")[0] === "ok").length;
      assert.ok(successes <= 1, `release race must not overclaim: ${results}`);
      assert.equal(await count(), successes);
      if (successes === 0) {
        const after = await concurrent([0, 1, 2, 3].map((i) => claim(users[i], i % 2 === 0, 20, 1)));
        assert.equal(after.filter((r) => r.split(":")[0] === "ok").length, 1);
      }
      assert.equal(await count(), 1);
      await reset();
      const once = taggedResults(await sql(claim(users[0])))[0].split(":")[1];
      const releases = await concurrent([0, 1, 2, 3].map(() => `select 'RESULT:' || public.release_claude_call(${once}, '${users[0]}')`));
      assert.equal(releases.filter((r) => r === "1").length, 1);
      assert.equal(await count(), 0);
    }
    console.log("OK: S1 release/claim and duplicate-release races (10 rounds each)");

    const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
    const json = (value) => `${quote(JSON.stringify(value))}::jsonb`;
    const intake = (id, email, run, limits, body = "abcdefgh", expected = null) =>
      `select 'RESULT:' || verdict || ':' || email_id::text from public.store_mail_run('${id}', '${email}', '${run}', ${json({ text_body: body, html_body: null, subject: null, processing_status: "pending", from_domain: "shop.example" })}, ${expected === null ? "null" : `${quote(expected)}::timestamptz`}, ${json(limits)})`;
    const generous = { user_count: 20, global_count: 20, user_bytes: 1024, global_bytes: 1024 };
    const clearMail = () => sql("truncate public.emails cascade; truncate public.mail_intake_notices;");
    const storedAmount = async () => {
      const output = await sql("select count(*) || '|' || coalesce(sum(coalesce(octet_length(text_body),0) + coalesce(octet_length(html_body),0)),0) from public.emails where body_state = 'plain' and processing_status <> 'processed';");
      return output.trim().split("|").map(Number);
    };
    // Keep the Claude budget exhausted while receiving mails: storage must stop independently.
    await reset();
    await sql(`insert into public.claude_usage_daily(user_id,day,calls) values ('${users[4]}',${day},1);`);
    const storageCases = [
      ["global count", { ...generous, global_count: 2 }, [0, 1, 2, 3], 2],
      ["personal count", { ...generous, user_count: 1 }, [0, 0, 0, 0], 1],
      ["global bytes", { ...generous, global_bytes: 16 }, [0, 1, 2, 3], 2],
      ["personal bytes", { ...generous, user_bytes: 8 }, [0, 0, 0, 0], 1],
      ["UTF-8 bytes", { ...generous, global_bytes: 16 }, [0, 1, 2, 3], 2, "éééé"],
    ];
    for (const [label, limits, owners, expected, body = "abcdefgh"] of storageCases) {
      await clearMail();
      const results = await concurrent(owners.map((owner, index) => intake(users[owner], user(100 + index), user(200 + index), limits, body)));
      assert.equal(results.filter((r) => r.split(":")[0] === "ok").length, expected, `I2 ${label}: ${results}`);
      assert.deepEqual(await storedAmount(), [expected, expected * 8]);
      for (let repeat = 0; repeat < 20; repeat++) {
        const refused = taggedResults(await sql(intake(users[owners[0]], user(500 + repeat), user(600 + repeat), limits, body)))[0];
        assert.notEqual(refused.split(":")[0], "ok");
      }
      assert.deepEqual(await storedAmount(), [expected, expected * 8], "refused mail must not add a body or row");
      assert.ok(Number((await sql("select count(*) from public.mail_intake_notices;")).trim()) <= users.length, "notice storage is bounded by accounts");
      assert.equal((await sql(`select public.claim_claude_call('${users[0]}',20,1);`)).trim(), "global_limit");
      console.log(`OK: I2 concurrent ${label}, repeated refusal, bounded notices, Claude budget exhausted`);
    }

    await clearMail();
    const email = user(900);
    const oldRun = user(901);
    const nextRun = user(902);
    assert.match(taggedResults(await sql(intake(users[0], email, oldRun, generous)))[0], /^ok:/);
    await sql(`select public.mail_run_write('${email}', '${oldRun}', 'extractions', 'insert', ${json({ email_id: email, model: "fixture", result: {} })}, '[]'::jsonb);`);
    // Simulate the 181-second-old row while keeping the 360-second lease alive. No real wait.
    const stamp = (await sql(`update public.emails set created_at = clock_timestamp() - interval '181 seconds' where id = '${email}' returning created_at;`)).trim();
    const live = taggedResults(await sql(intake(users[0], email, nextRun, generous, "replacement", stamp)))[0];
    assert.notEqual(live.split(":")[0], "ok", "I3 a live owner must not be replaced after 181 seconds");
    assert.equal((await sql(`select processing_run_id from public.emails where id = '${email}';`)).trim(), oldRun);
    assert.equal((await sql(`select count(*) from public.extractions where email_id = '${email}';`)).trim(), "1", "a live run's prior result must not be deleted");
    await sql(`update public.emails set processing_lease_until = clock_timestamp() - interval '1 second' where id = '${email}';`);
    assert.match(taggedResults(await sql(intake(users[0], email, nextRun, generous, "recovered", stamp)))[0], /^ok:/);
    assert.deepEqual(await storedAmount(), [1, 9], "taking over an existing row must not reserve storage twice");
    const mutation = (run, value) => `select public.mail_run_write('${email}', '${run}', 'emails', 'update', ${json({ error: value })}, ${json([{ method: "eq", args: ["id", email] }])});`;
    await assert.rejects(sql(mutation(oldRun, "stale result")), /42501|lease|owner|run/i, "I3 an expired owner's mutation must fail");
    for (const [table, values] of [
      ["extractions", { email_id: email, model: "stale", result: {} }],
      ["parcels", { shop: "stale" }],
      ["parcel_items", { parcel_id: user(999), name: "stale" }],
    ]) {
      await assert.rejects(sql(`select public.mail_run_write('${email}', '${oldRun}', '${table}', 'insert', ${json(values)}, '[]'::jsonb);`), /42501|lease|owner|run/i, `I3 old owner cannot write ${table}`);
    }
    const beforeOwnedClaim = await count();
    for (const table of ["claim_claude_call", "claim_claude_call_v2"]) {
      await assert.rejects(sql(`select public.mail_run_write('${email}', '${oldRun}', '${table}', 'claim', ${json({ p_user_limit: 20, p_global_limit: 100 })}, '[]'::jsonb);`), /42501|lease|owner|run/i, "I3 stale runs cannot consume Claude allowance");
    }
    assert.equal(await count(), beforeOwnedClaim);
    const ownedClaim = JSON.parse((await sql(`select public.mail_run_write('${email}', '${nextRun}', 'claim_claude_call_v2', 'claim', ${json({ p_user_limit: 20, p_global_limit: 100 })}, '[]'::jsonb);`)).trim());
    assert.equal(ownedClaim[0].verdict, "ok");
    assert.equal(await count(), beforeOwnedClaim + 1);
    await sql(mutation(nextRun, "owned result"));
    assert.equal((await sql(`select error from public.emails where id = '${email}';`)).trim(), "owned result");
    await sql(`select public.mail_run_write('${email}', '${nextRun}', 'parcels', 'insert', ${json({ shop: "Fixture shop" })}, '[]'::jsonb);`);
    const parcel = (await sql("select id from public.parcels limit 1;")).trim();
    const updated = (await sql(`select to_char(updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') from public.parcels where id = '${parcel}';`)).trim();
    const changed = JSON.parse((await sql(`select public.mail_run_write('${email}', '${nextRun}', 'parcels', 'update', ${json({ title: "Owned update" })}, ${json([{ method: "eq", args: ["id", parcel] }, { method: "eq", args: ["updated_at", updated] }])});`)).trim());
    assert.equal(changed.length, 1, "timestamp filters must compare instants, including ISO UTC Z format");
    assert.equal(changed[0].title, "Owned update");
    console.log("OK: I3 live 181-second lease, expired-run recovery, stale-owner refusal, current-owner mutation, typed timestamp filter");

    await sql(`select public.mail_run_write('${email}', '${nextRun}', 'emails', 'update', ${json({ processing_status: "processed", body_state: "dropped", text_body: null })}, '[]'::jsonb);`);
    assert.deepEqual(await storedAmount(), [0, 0], "finishing a read releases unread storage");
    assert.match(taggedResults(await sql(intake(users[0], user(903), user(904), { user_count: 1, global_count: 1, user_bytes: 8, global_bytes: 8 })))[0], /^ok:/, "a normal mail can resume after unread storage is released");
    for (const role of ["anon", "authenticated"]) {
      await assert.rejects(sql(`set role ${role}; select public.claim_claude_call('${users[0]}',20,0);`), /permission denied/i);
      await assert.rejects(sql(`set role ${role}; select public.mail_run_write('${email}','${nextRun}','emails','delete','{}','[]');`), /permission denied/i);
    }
    assert.equal((await sql(`set role service_role; select public.claim_claude_call('${users[0]}',20,0);`)).trim(), "global_limit");
    await sql(`insert into public.mail_intake_notices(user_id,reason) values ('${users[0]}','user_storage_limit'),('${users[1]}','global_storage_limit') on conflict(user_id) do update set reason=excluded.reason;`);
    const asOwner = `set role authenticated; set request.jwt.claim.sub='${users[0]}';`;
    assert.equal((await sql(`${asOwner} select count(*) from public.mail_intake_notices;`)).trim(), "1", "notice RLS exposes only the signed-in user's row");
    assert.equal((await sql(`${asOwner} with removed as (delete from public.mail_intake_notices where user_id='${users[1]}' returning 1) select count(*) from removed;`)).trim(), "0", "one user cannot dismiss another user's notice");
    assert.equal((await sql(`${asOwner} with removed as (delete from public.mail_intake_notices where user_id='${users[0]}' returning 1) select count(*) from removed;`)).trim(), "1", "a user can dismiss their own notice");
    await sql(`set role service_role; update public.mail_intake_notices set limited_at=clock_timestamp() where user_id='${users[1]}';`);
    console.log("OK: I2 resumed intake, notice RLS, service-role notice write and function privileges");

    // The behavioural verifier rolls its own test writes back.
    await clearMail();
    await reset();
    await verify(`supabase/verify/${migration}.sql`);
    await file(`supabase/rollback/${migration}.down.sql`);
    await file(`supabase/rollback/${migration}.down.sql`);
    await verify("supabase/verify/20261112020000_claude_call_release.sql");
    await file(`supabase/migrations/${migration}.sql`);
    await verify(`supabase/verify/${migration}.sql`);
    passed = true;
  } finally {
    await cleanup();
    process.removeListener("SIGINT", interrupted);
    process.removeListener("SIGTERM", interrupted);
  }
  assert.equal(passed, true);
  assert.equal(interruptionRequested, false, "test was interrupted");
  console.log("verdict=OK");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length && !["--self-test", "--negative-control"].includes(args[0]))) {
    console.error("Usage: node tests/postgres/run-cost-guards.mjs [--self-test|--negative-control]");
    process.exitCode = 2;
  } else {
    (args[0] === "--self-test" ? selfTest() : main(args[0] === "--negative-control")).catch((error) => {
      console.error(`verdict=FAILED: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    });
  }
}
