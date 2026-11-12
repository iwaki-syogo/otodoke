import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cleanEnvironment } from "./run-parcel-conflicts.mjs";
import { requireVerdict, runCommand } from "./run-cost-guards.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const target = "20261113121000_claude_claim_consent";
const port = 65443;
const bin = process.env.OTODOKE_PG_BINDIR ?? "";
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const quote = (s) => `'${String(s).replaceAll("'", "''")}'`;
const json = (v) => `${quote(JSON.stringify(v))}::jsonb`;
const users = Array.from({ length: 100 }, (_, i) => uuid(i + 1));
const denied = /\b42501:\s+ai_consent_required(?:\r?\n|$)/;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function priorMigrations(names) {
  return names.filter((name) => /^\d{14}_.+\.sql$/.test(name) && name < `${target}.sql`).sort();
}

export function consentDenied(error) {
  return denied.test(error instanceof Error ? error.message : String(error));
}

async function listening() {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    const finish = (answer) => { socket.destroy(); resolve(answer); };
    socket.once("connect", () => finish(true)); socket.once("error", () => finish(false)); socket.setTimeout(500, () => finish(false));
  });
}

async function selfTest() {
  assert.deepEqual(priorMigrations([`${target}.sql`, "20261113122000_future.sql", "20261113120000_consent_waiting_storage.sql", "notes.md"]), ["20261113120000_consent_waiting_storage.sql"]);
  requireVerdict("OK|t\n", "self-test");
  assert.throws(() => requireVerdict("FAILED|t\n", "self-test"));
  assert.equal(consentDenied(new Error("ERROR:  42501: ai_consent_required\nCONTEXT: function")), true);
  for (const message of ["ERROR: 42501: permission denied", "ERROR: 42501: mail run no longer owns the lease", "ERROR: 42P01: ai_consent_required", "ERROR: 42501: ai_consent_required extra"]) assert.equal(consentDenied(new Error(message)), false);
  await assert.rejects(runCommand(process.execPath, ["-e", "process.stderr.write('ERROR: broken SQL');process.exit(0)"]), /broken SQL/);
  await assert.rejects(runCommand(process.execPath, ["-e", "setTimeout(()=>{},10000)"], { timeout: 10 }), /SIGTERM/);
  console.log("OK: self-test (dependency boundary, verdict, exact consent error, SQL error with exit zero, timeout)");
  console.log("NOT RUN: PostgreSQL startup, SQL behavior/row locks, migration/rollback, concurrency or SQL negative controls");
}

async function main(mode) {
  assert.equal(await listening(), false, `port ${port} in use; no existing process stopped`);
  const parent = path.join(root, ".vitest/pg"); await mkdir(parent, { recursive: true });
  const scratch = await mkdtemp(path.join(parent, "claim-consent-"));
  const data = path.join(scratch, "data"), environment = cleanEnvironment(scratch);
  let attempted = false, interrupted = false;
  const raw = (name, args, options) => runCommand(path.join(bin, name), args, { environment, ...options });
  const command = (name, args, options) => { assert.equal(interrupted, false, "interrupted; cleaning up"); return raw(name, args, options); };
  const args = ["-X", "-w", "-q", "-A", "-t", "-h", "127.0.0.1", "-p", String(port), "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-v", "VERBOSITY=verbose"];
  const sql = (input) => command("psql", args, { input });
  const file = (name) => command("psql", [...args, "-f", path.join(root, name)]);
  const scalar = async (input) => (await sql(input)).trim();
  const verify = async (name) => { requireVerdict(await file(name), name); console.log(`OK: ${name}`); };
  const choice = (user, decision) => sql(`begin; set local request.jwt.claim.sub=${quote(user)}; set local role authenticated; select * from public.set_ai_reading(${quote(decision)},'v1'); commit;`);
  const v1 = (user, userLimit = 100, globalLimit = 1000) => `select public.claim_claude_call(${quote(user)},${userLimit},${globalLimit});`;
  const v2 = (user, userLimit = 100, globalLimit = 1000) => `select row_to_json(c) from public.claim_claude_call_v2(${quote(user)},${userLimit},${globalLimit}) c;`;
  const owned = (id, run, version) => `select public.mail_run_write(${quote(id)},${quote(run)},'claim_claude_call${version === 2 ? "_v2" : ""}','claim','{"p_user_limit":100,"p_global_limit":1000}','[]');`;
  const seedMail = (user, id, run) => sql(`select * from public.store_mail_run(${quote(user)},${quote(id)},${quote(run)},${json({ processing_status: "pending", text_body: "Synthetic claim mail" })},null,'{"user_count":200,"global_count":2000,"user_bytes":16777216,"global_bytes":268435456}');`);
  const calls = (user) => scalar(`select coalesce(sum(calls),0) from public.claude_usage_daily where user_id=${quote(user)};`);
  const ledger = (user) => scalar(`select count(*) from public.claude_call_claims where user_id=${quote(user)};`);
  const claimResult = async (query) => {
    try { return { denied: false, value: await scalar(`set role service_role; ${query}`) }; }
    catch (error) { if (consentDenied(error)) return { denied: true }; throw error; }
  };
  const assertDenied = async (query) => assert.equal((await claimResult(query)).denied, true, "current consent denial expected before quota/ledger writes");
  const stop = () => { interrupted = true; }; process.once("SIGINT", stop); process.once("SIGTERM", stop);
  try {
    assert.match(await command("initdb", ["--version"]), /PostgreSQL\) 17\./);
    await command("initdb", ["-D", data, "-U", "postgres", "--no-sync", "-c", "dynamic_shared_memory_type=mmap", "-c", "shared_memory_type=mmap"]);
    attempted = true;
    await command("pg_ctl", ["-D", data, "-l", path.join(scratch, "server.log"), "-t", "10", "-o", `-h 127.0.0.1 -p ${port} -k ${scratch} -c dynamic_shared_memory_type=mmap -c shared_memory_type=mmap -c deadlock_timeout=100ms -c statement_timeout=15s`, "start"]);
    await file("tests/postgres/bootstrap.sql");
    for (const name of priorMigrations(await readdir(path.join(root, "supabase/migrations")))) {
      if (name === "20261106180000_screen_events_daily_purge.sql") {
        const source = await readFile(path.join(root, "supabase/migrations", name), "utf8");
        await sql(source.slice(source.indexOf("create or replace function public.is_shared_mail_domain"), source.indexOf("select cron.schedule")));
        await sql("create schema cron; create table cron.job(jobname text,command text,schedule text,active boolean); insert into cron.job values('otodoke-purge-old-screen-events','select public.purge_old_screen_events()','30 18 * * *',true);");
      } else await file(`supabase/migrations/${name}`);
    }
    await sql(`insert into auth.users(id) values ${users.map((user) => `(${quote(user)})`).join(",")};`);
    const original = await scalar("select jsonb_object_agg(proname,md5(prosrc)) from pg_proc where oid in ('public.claim_claude_call(uuid,integer,integer)'::regprocedure,'public.claim_claude_call_v2(uuid,integer,integer)'::regprocedure);");
    if (mode !== "--baseline") {
      await verify(`supabase/verify/${target}.before.sql`);
      await file(`supabase/migrations/${target}.sql`); await file(`supabase/migrations/${target}.sql`);
      await verify(`supabase/verify/${target}.sql`);
    }
    if (mode === "--negative-control") await sql("create or replace function public.assert_claude_claim_consent(p_user_id uuid) returns void language plpgsql security definer set search_path='' as $$ begin return; end $$;");
    if (mode === "--negative-lock") {
      const definition = await scalar("select pg_get_functiondef('public.assert_claude_claim_consent(uuid)'::regprocedure);");
      await sql(definition.replace(" for share;", ";"));
    }
    await choice(users[1], "declined");
    for (const user of [users[0], users[1]]) {
      await assertDenied(v1(user)); await assertDenied(v2(user));
      const n = users.indexOf(user), id = uuid(1000 + n), run = uuid(2000 + n);
      await seedMail(user, id, run);
      await assertDenied(owned(id, run, 1)); await assertDenied(owned(id, run, 2));
      assert.equal(await calls(user), "0"); assert.equal(await ledger(user), "0");
    }
    console.log("OK: absent/declined direct v1/v2 and owned v1/v2 deny with counter=0/ledger=0");

    await choice(users[2], "granted");
    assert.equal((await claimResult(v1(users[2], 1, 2))).value, "ok");
    assert.equal((await claimResult(v1(users[2], 1, 2))).value, "user_limit");
    await choice(users[3], "granted");
    const paid = JSON.parse((await claimResult(v2(users[3], 2, 2))).value);
    assert.equal(paid.verdict, "ok"); assert.ok(paid.claim_id);
    assert.equal(JSON.parse((await claimResult(v2(users[3], 2, 2))).value).verdict, "global_limit");
    assert.equal(await calls(users[3]), "1"); assert.equal(await ledger(users[3]), "1");
    await choice(users[3], "declined");
    assert.equal(await scalar(`set role service_role; select public.release_claude_call(${paid.claim_id},${quote(users[3])});`), "1");
    assert.equal(await scalar(`set role service_role; select public.release_claude_call(${paid.claim_id},${quote(users[3])});`), "0");
    assert.equal(await calls(users[3]), "0");
    await assertDenied(v2(users[3]));
    console.log("OK: existing individual/global quotas and ledger preserved; withdrawal does not block one-time release");

    for (const name of ["claim_claude_call", "claim_claude_call_v2"]) await assert.rejects(sql(`set role service_role; select * from public.${name}(null,10,100);`), /22023:/);
    await assert.rejects(sql(`set role authenticated; ${v1(users[2])}`), /permission denied for function/);
    await assert.rejects(sql(`set role service_role; select public.assert_claude_claim_consent(${quote(users[2])});`), /permission denied for function/);
    await assert.rejects(sql(`set role service_role; select public.claim_claude_call_before_consent_guard(${quote(users[2])},10,100);`), /permission denied for function/);
    await assert.rejects(sql(`set role service_role; select * from public.claim_claude_call_v2_without_sample_fence(${quote(users[2])},10,100);`), /permission denied for function/);
    await choice(users[4], "granted");
    await assert.rejects(sql(`begin; alter table public.ai_reading_consents rename column decision to decision_failure_probe; ${v1(users[4])} rollback;`), (error) => /42703:/.test(error.message) && !consentDenied(error));
    assert.equal(await calls(users[4]), "0"); assert.equal(await ledger(users[4]), "0");
    console.log("OK: null/lease/privilege/database errors remain distinct from the exact consent denial");

    // A C-only observer never acquires U/G afterwards. It checks the actual row lock;
    // unlike the production setter's G prefix, this probe cannot mask a removed FOR SHARE.
    await choice(users[5], "granted");
    const locker = spawn(path.join(bin, "psql"), args, { cwd: root, env: environment, stdio: ["pipe", "pipe", "pipe"] });
    let output = "", errors = "", closed = false;
    const timer = setTimeout(() => locker.kill("SIGTERM"), 15000);
    const finished = new Promise((resolve, reject) => {
      locker.stdout.on("data", (chunk) => { output += chunk; }); locker.stderr.on("data", (chunk) => { errors += chunk; });
      locker.on("error", reject); locker.on("close", (code) => { clearTimeout(timer); closed = true; if (code === 0) resolve(); else reject(new Error(errors)); });
    });
    finished.catch(() => {}); locker.stdin.on("error", () => {});
    let claiming;
    try {
      locker.stdin.write(`begin; select user_id from public.ai_reading_consents where user_id=${quote(users[5])} for update; select 'C-ready';\n`);
      const deadline = Date.now() + 5000;
      while (!output.includes("C-ready") && Date.now() < deadline && !closed) await pause(10);
      assert.ok(output.includes("C-ready"), `C observer did not become ready: ${errors}`);
      claiming = claimResult(`set application_name='claim-consent-lock-probe'; ${v2(users[5])}`); claiming.catch(() => {});
      let observed = false;
      while (Date.now() < deadline && !observed) {
        observed = await scalar("select exists(select 1 from pg_stat_activity where application_name='claim-consent-lock-probe' and cardinality(pg_blocking_pids(pid))>0);") === "t";
        if (!observed) await pause(10);
      }
      assert.equal(observed, true, "claim must wait on the real consent row lock (negative-lock mode must fail here)");
      locker.stdin.end("commit;\n"); await finished;
      assert.equal(JSON.parse((await claiming).value).verdict, "ok");
    } finally {
      if (!closed) locker.stdin.end("rollback;\n"); await finished; if (claiming) await claiming;
    }
    console.log("OK: actual FOR SHARE blocks behind C-only row observer, not merely the shared G prefix");

    for (let round = 0; round < 20; round++) {
      const user = users[20 + round], id = uuid(3000 + round), run = uuid(4000 + round), version = round % 2 + 1;
      await choice(user, "granted"); await seedMail(user, id, run);
      const query = round < 10 ? version === 1 ? v1(user) : v2(user) : owned(id, run, version);
      const [result] = await Promise.all([claimResult(query), choice(user, "declined")]);
      assert.equal(await calls(user), result.denied ? "0" : "1");
      assert.equal(await ledger(user), result.denied || version === 1 ? "0" : "1");
      assert.equal(await scalar(`select decision from public.ai_reading_consents where user_id=${quote(user)};`), "declined");
      await assertDenied(query);
    }
    console.log("OK: 20 direct/owned v1/v2 vs withdrawal races, terminal consent declined, quota exactly matches successful claims");
    for (let round = 0; round < 10; round++) {
      const user = users[50 + round], id = uuid(5000 + round), run = uuid(6000 + round);
      await choice(user, "granted"); await seedMail(user, id, run);
      const decisionAt = await scalar(`select decided_at::text from public.ai_reading_consents where user_id=${quote(user)};`);
      const queries = [
        claimResult(owned(id, run, 2)),
        choice(user, "declined"),
        sql(`select public.clear_all_parcels(${quote(user)});`),
        sql(`select public.claim_ai_reading_backlog(${quote(user)},${quote(decisionAt)});`),
      ];
      const settled = await Promise.allSettled(queries);
      for (const result of settled) if (result.status === "rejected") {
        assert.match(result.reason.message, /42501:\s+mail run no longer owns the lease/, "only cleared-mail lease loss is an accepted racing refusal");
      }
    }
    console.log("OK: 10 owned claim/withdrawal/clear/backlog races; no deadlocks, SQL errors or timeouts");
    for (let round = 0; round < 10; round++) {
      const user = users[70 + round], id = uuid(7000 + round), run = uuid(8000 + round);
      await choice(user, "granted"); await seedMail(user, id, run);
      const globalBefore = Number(await scalar("select coalesce(sum(calls),0) from public.claude_usage_daily;"));
      const [claimed, removed] = await Promise.allSettled([
        claimResult(round % 2 === 0 ? v2(user) : owned(id, run, 2)),
        sql(`delete from auth.users where id=${quote(user)};`),
      ]);
      assert.equal(removed.status, "fulfilled", "Auth deletion must complete");
      let allowed = false;
      if (claimed.status === "fulfilled") allowed = !claimed.value.denied;
      else assert.match(claimed.reason.message, /(?:23503:\s+sample owner no longer exists|42501:\s+mail run no longer owns the lease)/,
        "only a vanished Auth owner or cleared mail lease is an accepted deletion race refusal");
      const globalAfter = Number(await scalar("select coalesce(sum(calls),0) from public.claude_usage_daily;"));
      assert.equal(globalAfter - globalBefore, allowed ? 1 : 0, "deletion preserves paid calls in global usage");
      assert.equal(await scalar(`select count(*) from public.ai_reading_consents where user_id=${quote(user)};`), "0");
    }
    console.log("OK: 10 standalone/owned claim vs Auth deletion races; global paid usage preserved");
    await verify(`supabase/verify/${target}.sql`);
    await file(`supabase/rollback/${target}.down.sql`); await file(`supabase/rollback/${target}.down.sql`);
    assert.equal(await scalar("select jsonb_object_agg(proname,md5(prosrc)) from pg_proc where oid in ('public.claim_claude_call(uuid,integer,integer)'::regprocedure,'public.claim_claude_call_v2(uuid,integer,integer)'::regprocedure);"), original);
    await verify("supabase/verify/20261113120000_consent_waiting_storage.sql");
    await file(`supabase/migrations/${target}.sql`); await verify(`supabase/verify/${target}.sql`);
    console.log("OK: exact prior entry bodies after rollback twice; 120000 remains intact; reapply");
  } finally {
    if (attempted && await raw("pg_ctl", ["-D", data, "status"]).then(() => true, () => false)) await raw("pg_ctl", ["-D", data, "-t", "10", "-m", "fast", "stop"]);
    assert.equal(await listening(), false, `listener remains on ${port}; data not removed`);
    await rm(scratch, { recursive: true, force: true }); process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop);
    console.log(`OK: cleanup, no listener on 127.0.0.1:${port}, dedicated data deleted`);
  }
  assert.equal(interrupted, false); console.log("verdict=OK");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2];
  if (process.argv.length > 3 || (mode && !["--self-test", "--baseline", "--negative-control", "--negative-lock"].includes(mode))) {
    console.error("Usage: node tests/postgres/run-claude-claim-consent.mjs [--self-test|--baseline|--negative-control|--negative-lock]"); process.exitCode = 2;
  } else (mode === "--self-test" ? selfTest() : main(mode)).catch((error) => {
    console.error(`verdict=FAILED: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1;
  });
}
