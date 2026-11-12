import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cleanEnvironment } from "./run-parcel-conflicts.mjs";
import { requireVerdict, runCommand } from "./run-cost-guards.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const target = "20261113120000_consent_waiting_storage";
const port = 65442;
const bin = process.env.OTODOKE_PG_BINDIR ?? "";
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const quote = (s) => `'${String(s).replaceAll("'", "''")}'`;
const json = (v) => `${quote(JSON.stringify(v))}::jsonb`;
const limits = { user_count: 2, user_bytes: 10000, global_count: 1, global_bytes: 10000 };
const users = Array.from({ length: 100 }, (_, i) => uuid(i + 1));

export function priorMigrations(names) {
  return names.filter((name) => /^\d{14}_.+\.sql$/.test(name) && name < `${target}.sql`).sort();
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

function store(user, id, columns = {}, configured = limits, expected = null) {
  const values = { provider_email_id: `synthetic:${id}`, processing_status: "pending", text_body: "Synthetic", ...columns };
  return `select verdict from public.store_mail_run(${quote(user)},${quote(id)},${quote(uuid(9000 + Number(id.slice(-4))))},${json(values)},${expected === null ? "null" : `${quote(expected)}::timestamptz`},${json(configured)});`;
}

async function selfTest() {
  assert.deepEqual(priorMigrations([`${target}.sql`, "20261113130000_future.sql", "20261113110000_sample_generation.sql", "notes.md"]), ["20261113110000_sample_generation.sql"]);
  requireVerdict("OK|t\n", "self-test");
  assert.throws(() => requireVerdict("FAILED|t\n", "self-test"));
  assert.throws(() => requireVerdict("", "self-test"));
  await assert.rejects(runCommand(process.execPath, ["-e", "process.stderr.write('ERROR: broken SQL');process.exit(0)"]), /broken SQL/);
  await assert.rejects(runCommand(process.execPath, ["-e", "setTimeout(()=>{},10000)"], { timeout: 10 }), /SIGTERM/);
  const sql = await readFile(path.join(root, `supabase/migrations/${target}.sql`), "utf8");
  assert.equal((sql.match(/interval '14 days'/g) ?? []).length, 1);
  assert.ok(store(users[0], uuid(1001)).includes("public.store_mail_run("));
  console.log("OK: self-test (verdict, dependency boundary, SQL error with exit zero, timeout, one retention constant)");
  console.log("NOT RUN: PostgreSQL startup, SQL behavior, migration/rollback, concurrency and SQL negative control");
}

async function main(mode) {
  assert.equal(await listening(), false, `port ${port} already used; no existing process was stopped`);
  const parent = path.join(root, ".vitest/pg");
  await mkdir(parent, { recursive: true });
  const scratch = await mkdtemp(path.join(parent, "consent-waiting-"));
  const data = path.join(scratch, "data");
  const environment = cleanEnvironment(scratch);
  let attempted = false;
  let interrupted = false;
  const raw = (name, args, options) => runCommand(path.join(bin, name), args, { environment, ...options });
  const command = (name, args, options) => {
    assert.equal(interrupted, false, "interrupted; cleaning up");
    return raw(name, args, options);
  };
  const args = ["-X", "-w", "-q", "-A", "-t", "-h", "127.0.0.1", "-p", String(port), "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1"];
  const sql = (input) => command("psql", args, { input });
  const file = (name) => command("psql", [...args, "-f", path.join(root, name)]);
  const verify = async (name) => { requireVerdict(await file(name), name); console.log(`OK: ${name}`); };
  const scalar = async (input) => (await sql(input)).trim();
  const grant = (user, decision = "granted") => sql(`begin; set local request.jwt.claim.sub=${quote(user)}; set local role authenticated; select * from public.set_ai_reading(${quote(decision)},'v1'); commit;`);
  const endLease = (id) => sql(`update public.emails set processing_status='failed',error='ai_consent_required',processing_lease_until=null where id=${quote(id)};`);
  const stop = () => { interrupted = true; };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    assert.match(await command("initdb", ["--version"]), /PostgreSQL\) 17\./);
    await command("initdb", ["-D", data, "-U", "postgres", "--no-sync", "-c", "dynamic_shared_memory_type=mmap", "-c", "shared_memory_type=mmap"]);
    attempted = true;
    await command("pg_ctl", ["-D", data, "-l", path.join(scratch, "server.log"), "-t", "10", "-o", `-h 127.0.0.1 -p ${port} -k ${scratch} -c dynamic_shared_memory_type=mmap -c shared_memory_type=mmap -c deadlock_timeout=100ms -c statement_timeout=15s`, "start"]);
    await file("tests/postgres/bootstrap.sql");
    for (const name of priorMigrations(await readdir(path.join(root, "supabase/migrations")))) {
      if (name === "20261106180000_screen_events_daily_purge.sql") {
        // Real old purge/domain function bodies, but a local schedule catalog: no pg_cron available.
        const source = await readFile(path.join(root, "supabase/migrations", name), "utf8");
        await sql(source.slice(source.indexOf("create or replace function public.is_shared_mail_domain"), source.indexOf("select cron.schedule")));
        await sql("create schema cron; create table cron.job(jobname text,command text,schedule text,active boolean); insert into cron.job values('otodoke-purge-old-screen-events','select public.purge_old_screen_events()','30 18 * * *',true);");
      } else await file(`supabase/migrations/${name}`);
    }
    await sql(`insert into auth.users(id) values ${users.map((id) => `(${quote(id)})`).join(",")};`);
    const original = await scalar("select jsonb_object_agg(proname,md5(prosrc)) from pg_proc where oid in ('public.set_ai_reading(text,text)'::regprocedure,'public.purge_old_screen_events()'::regprocedure,'public.store_mail_run_without_sample_fence(uuid,uuid,uuid,jsonb,timestamptz,jsonb)'::regprocedure);");
    if (mode !== "--baseline") {
      await sql(`insert into public.emails(id,user_id,processing_status,text_body,received_at) values(${quote(uuid(1999))},${quote(users[99])},'failed','Legacy synthetic',now()-interval '20 days');`);
      await verify(`supabase/verify/${target}.before.sql`);
      await file(`supabase/migrations/${target}.sql`);
      await file(`supabase/migrations/${target}.sql`);
      await verify(`supabase/verify/${target}.sql`);
      assert.equal(await scalar(`select consent_waiting_until=received_at+public.ai_consent_waiting_retention() from public.emails where id=${quote(uuid(1999))};`), "t", "legacy backfill uses arrival timestamp");
      await sql(`delete from public.emails where id=${quote(uuid(1999))};`);
    }
    if (mode === "--negative-control") {
      const prior = await scalar("select pg_get_functiondef('public.store_mail_run_before_consent_storage(uuid,uuid,uuid,jsonb,timestamptz,jsonb)'::regprocedure);");
      await sql(prior.replace("public.store_mail_run_before_consent_storage(", "public.store_mail_run_without_sample_fence("));
    }
    // The same regression is run against baseline, fixed, and old-core negative control.
    assert.equal(await scalar(store(users[0], uuid(1001))), "ok");
    await endLease(uuid(1001));
    assert.equal(await scalar(store(users[0], uuid(1002))), "ok", "second waiting mail must not consume the active global cap of one");
    await endLease(uuid(1002));
    assert.equal(await scalar(store(users[0], uuid(1003))), "user_storage_limit");
    assert.equal(await scalar(`select count(*) from public.emails where id=${quote(uuid(1003))};`), "0");
    for (let i = 0; i < 3; i++) assert.equal(await scalar(store(users[0], uuid(1003))), "user_storage_limit");
    assert.equal(await scalar(`select count(*) from public.mail_intake_notices where user_id=${quote(users[0])};`), "1");
    await grant(users[1], "declined");
    assert.equal(await scalar(store(users[1], uuid(1004))), "ok", "declined owner uses only personal waiting pool");
    await grant(users[2]);
    assert.equal(await scalar(store(users[2], uuid(1005))), "ok", "waiting owners cannot stop granted owner");
    await grant(users[3]);
    assert.equal(await scalar(store(users[3], uuid(1006))), "global_storage_limit", "active global cap still enforced");
    assert.equal(await scalar(store(users[4], uuid(1007), { text_body: "あい" }, { ...limits, user_bytes: 6 })), "ok");
    assert.equal(await scalar(store(users[5], uuid(1008), { text_body: "あいa" }, { ...limits, user_bytes: 6 })), "user_storage_limit", "UTF-8 bytes, not character count");
    console.log("OK: isolation, undecided/declined, personal count/UTF-8 bytes, active global cap, bounded notices");

    const arrival = await scalar(`select received_at::text from public.emails where id=${quote(uuid(1001))};`);
    const deadline = await scalar(`select consent_waiting_until::text from public.emails where id=${quote(uuid(1001))};`);
    await sql(`update public.emails set received_at=now()+interval '1 day',created_at=now() where id=${quote(uuid(1001))};`);
    await grant(users[0]);
    await grant(users[0], "declined");
    assert.equal(await scalar(`select received_at::text from public.emails where id=${quote(uuid(1001))};`), arrival);
    assert.equal(await scalar(`select consent_waiting_until::text from public.emails where id=${quote(uuid(1001))};`), deadline);
    await endLease(uuid(1005));
    await grant(users[2], "declined");
    assert.equal(await scalar(`select consent_waiting_until=received_at+public.ai_consent_waiting_retention() from public.emails where id=${quote(uuid(1005))};`), "t", "withdrawal marks prior active mail from original arrival");
    console.log("OK: retry/grant/withdrawal never extend arrival or deadline");

    await grant(users[79]);
    assert.equal(await scalar(store(users[79], uuid(1015))), "ok");
    assert.equal(await scalar(`select consent_waiting_until is null from public.emails where id=${quote(uuid(1015))};`), "t");
    await sql(`update public.emails set processing_status='failed',error='ai_consent_unknown',processing_lease_until=null where id=${quote(uuid(1015))};`);
    assert.equal(await scalar(`select consent_waiting_until=received_at+public.ai_consent_waiting_retention() from public.emails where id=${quote(uuid(1015))};`), "t", "future lookup-unknown UPDATE is retained from original arrival even when DB choice is granted");
    console.log("OK: post-store consent lookup failure receives the same arrival deadline as legacy backfill");

    const old = uuid(1010), partial = uuid(1011), active = uuid(1012), processed = uuid(1013);
    await sql(`insert into public.emails(id,user_id,processing_status,text_body,received_at,processing_lease_until) values
      (${quote(old)},${quote(users[6])},'failed','Expired synthetic',now()-public.ai_consent_waiting_retention()-interval '1 second',null),
      (${quote(partial)},${quote(users[6])},'failed','Partial synthetic',now()-public.ai_consent_waiting_retention()-interval '1 second',null),
      (${quote(active)},${quote(users[6])},'pending','Active synthetic',now()-public.ai_consent_waiting_retention()-interval '1 second',now()+interval '1 minute'),
      (${quote(processed)},${quote(users[6])},'processed','Processed synthetic',now()-interval '20 days',null);
      insert into public.extractions(user_id,email_id,model,result,confidence) values(${quote(users[6])},${quote(partial)},'synthetic','{}',1);`);
    const oldCreated = await scalar(`select created_at::text from public.emails where id=${quote(old)};`);
    assert.equal(await scalar(store(users[6], old, {}, limits, oldCreated)), "consent_wait_expired");
    assert.equal(await scalar(`select count(*) from public.emails where id=${quote(old)};`), "0");
    assert.equal(await scalar(store(users[6], old, {}, limits, oldCreated)), "busy", "old reread snapshot cannot recreate expired row");
    const partialCreated = await scalar(`select created_at::text from public.emails where id=${quote(partial)};`);
    assert.equal(await scalar(store(users[6], partial, {}, limits, partialCreated)), "consent_wait_expired");
    assert.equal(await scalar(`select body_state||':'||processing_status||':'||(text_body is null)::text from public.emails where id=${quote(partial)};`), "dropped:discarded:true");
    assert.equal(await scalar(`select count(*) from public.extractions where email_id=${quote(partial)};`), "1");
    assert.equal(await scalar(store(users[6], partial, { text_body: "Replayed plaintext" }, limits, partialCreated)), "consent_wait_expired");
    assert.equal(await scalar(`select text_body is null from public.emails where id=${quote(partial)};`), "t");
    const sweep = uuid(1014);
    await sql(`insert into public.emails(id,user_id,processing_status,text_body,received_at) values(${quote(sweep)},${quote(users[7])},'failed','Sweep synthetic',now()-public.ai_consent_waiting_retention()-interval '1 second');
      insert into public.screen_events(user_id,created_at,decision,subject) values(${quote(users[7])},now()-interval '20 days','dropped','Old synthetic screen');
      select public.purge_old_screen_events();`);
    assert.equal(await scalar(`select count(*) from public.emails where id=${quote(sweep)};`), "0");
    assert.equal(await scalar(`select count(*) from public.emails where id in (${quote(active)},${quote(processed)});`), "2", "active leases and processed results survive sweep");
    assert.equal(await scalar("select count(*) from public.screen_events;"), "0", "prior screen purge still runs");
    assert.equal(await scalar("select count(*) from cron.job;"), "1", "no extra schedule");
    console.log("OK: arrival expiry, expired takeover, stale snapshot, partial result preservation, no replay, existing daily sweep, active lease safety");

    for (let round = 0; round < 10; round++) {
      const owner = users[20 + round];
      await sql(`insert into public.emails(user_id,processing_status,text_body,received_at) values(${quote(owner)},'failed','Concurrent synthetic',now()-public.ai_consent_waiting_retention()-interval '1 second');`);
      await Promise.all([
        sql("begin; select public.purge_old_screen_events(); select pg_sleep(0.03); commit;"),
        sql(`begin; select public.clear_all_parcels(${quote(owner)}); select pg_sleep(0.03); commit;`),
        sql(`begin; ${store(owner, uuid(3000 + round))} select pg_sleep(0.03); commit;`),
        grant(owner, "declined"),
      ]);
    }
    console.log("OK: 10 concurrent sweeps/clear/intake/withdrawal rounds, no SQL errors/deadlocks/timeouts");
    await verify(`supabase/verify/${target}.sql`);
    await file(`supabase/rollback/${target}.down.sql`);
    await file(`supabase/rollback/${target}.down.sql`);
    assert.equal(await scalar("select jsonb_object_agg(proname,md5(prosrc)) from pg_proc where oid in ('public.set_ai_reading(text,text)'::regprocedure,'public.purge_old_screen_events()'::regprocedure,'public.store_mail_run_without_sample_fence(uuid,uuid,uuid,jsonb,timestamptz,jsonb)'::regprocedure);"), original, "rollback restores exact prior bodies");
    await verify("supabase/verify/20261113110000_sample_generation.sql");
    await file(`supabase/migrations/${target}.sql`);
    await verify(`supabase/verify/${target}.sql`);
    console.log("OK: rollback twice, exact prior bodies/110000 verification, reapply");
  } finally {
    if (attempted && await raw("pg_ctl", ["-D", data, "status"]).then(() => true, () => false)) {
      await raw("pg_ctl", ["-D", data, "-t", "10", "-m", "fast", "stop"]);
    }
    assert.equal(await listening(), false, `test listener remains on ${port}; data was not removed`);
    await rm(scratch, { recursive: true, force: true });
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    console.log(`OK: cleanup, no listener on 127.0.0.1:${port}, dedicated data deleted`);
  }
  assert.equal(interrupted, false, "test interrupted");
  console.log("verdict=OK");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2];
  if (process.argv.length > 3 || (mode && !["--self-test", "--baseline", "--negative-control"].includes(mode))) {
    console.error("Usage: node tests/postgres/run-consent-waiting-storage.mjs [--self-test|--baseline|--negative-control]");
    process.exitCode = 2;
  } else (mode === "--self-test" ? selfTest() : main(mode)).catch((error) => {
    console.error(`verdict=FAILED: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
