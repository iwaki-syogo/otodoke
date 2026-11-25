import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCommand } from "./run-cost-guards.mjs";
import { cleanEnvironment, requireVerdict } from "./run-person-status.mjs";

// 20261125100000_mail_intake_window: the per-day intake allowance of Gmail's forwarding confirmation and of the
// screen_events log, and one log row per delivery. A disposable PostgreSQL 17 cluster on 127.0.0.1:65461; no external
// service.
//
//   node tests/postgres/run-mail-intake-window.mjs --self-test        (no database)
//   node tests/postgres/run-mail-intake-window.mjs                    (the real behaviour; success = verdict=OK, exit 0)
//   node tests/postgres/run-mail-intake-window.mjs --negative-control (claim_mail_intake swapped for a version that reads
//                                                                       without a row lock must be CAUGHT over-granting;
//                                                                       verdict=OK means it was caught)

const root = fileURLToPath(new URL("../../", import.meta.url));
const stem = "20261125100000_mail_intake_window";
const files = {
  before: `supabase/verify/${stem}.before.sql`,
  migration: `supabase/migrations/${stem}.sql`,
  verify: `supabase/verify/${stem}.sql`,
  down: `supabase/rollback/${stem}.down.sql`,
  rolledBack: `supabase/verify/${stem}.rolled-back.sql`,
};
const port = 65461;
const bin = process.env.OTODOKE_PG_BINDIR ?? "";
const uuid = (number) => `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`;
const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
const A = uuid(1), B = uuid(2), C = uuid(3), D = uuid(4), E = uuid(5), F = uuid(6);
const LIMITS = { user_count: 3, user_bytes: 1000, global_count: 5, global_bytes: 100000 };
const lim = (o = LIMITS) => `${quote(JSON.stringify(o))}::jsonb`;

/** The race a careless version would have: read the totals without locking the row, wait, then add. */
export const brokenClaim = `create or replace function public.claim_mail_intake(p_user_id uuid, p_kind text, p_bytes bigint, p_limits jsonb)
returns text language plpgsql security definer set search_path = '' as $$
declare v_day date := (pg_catalog.clock_timestamp() at time zone 'Asia/Tokyo')::date; v_count integer;
begin
  insert into public.mail_intake_user_counts(user_id, kind, day) values (p_user_id, p_kind, v_day) on conflict do nothing;
  select count into v_count from public.mail_intake_user_counts where user_id = p_user_id and kind = p_kind and day = v_day;
  perform pg_catalog.pg_sleep(0.2);
  if v_count + 1 > (p_limits->>'user_count')::bigint then return 'user_intake_limit'; end if;
  update public.mail_intake_user_counts set count = count + 1, bytes = bytes + p_bytes where user_id = p_user_id and kind = p_kind and day = v_day;
  return 'ok';
end $$;`;

export function priorMigrations(names) {
  return names.filter((name) => /^\d{14}_.+\.sql$/.test(name) && name.slice(0, 14) < stem.slice(0, 14)).sort();
}

async function listening() {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    const finish = (result) => { socket.destroy(); resolve(result); };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(500, () => finish(false));
  });
}

const asRole = (role, body) => `begin; set local role ${role}; set local request.headers='{}'; ${body} commit;`;

async function selfTest() {
  const migration = await readFile(path.join(root, files.migration), "utf8");
  const down = await readFile(path.join(root, files.down), "utf8");
  // The real claim locks the parent and both rows; the broken one does not lock and is told apart.
  assert.match(migration, /from auth\.users where id = p_user_id for key share/);
  assert.equal((migration.match(/for update;/g) ?? []).length, 2);
  assert.doesNotMatch(brokenClaim, /for update/);
  assert.match(migration, /exception when unique_violation then/);
  assert.match(migration, /grant execute on function public\.claim_mail_intake\(uuid, text, bigint, jsonb\), public\.log_screen_event\(uuid, jsonb, jsonb\) to service_role;/);
  assert.match(down, /drop column if exists delivery_digest/);
  assert.deepEqual(priorMigrations([`${stem}.sql`, "20261117120000_parcel_status_set_by_person.sql", "20261201000000_future.sql", "notes.md"]), ["20261117120000_parcel_status_set_by_person.sql"]);
  const environment = cleanEnvironment("local-scratch", { PGHOST: "remote.invalid", KEEP: "yes" });
  assert.equal(environment.PGHOST, undefined);
  assert.equal(environment.KEEP, "yes");
  assert.deepEqual(requireVerdict("OK|t|t|t|t|t|t|t|0|0\n", "x", 10, [1, 2, 3, 4, 5, 6, 7]).length, 10);
  for (const bad of ["", "FAILED|t|t|t|t|t|t|t|0|0\n", "OK|t|t|f|t|t|t|t|0|0\n", "OK|t|t|t|t|t|t|t|0\n"]) {
    assert.throws(() => requireVerdict(bad, "x", 10, [1, 2, 3, 4, 5, 6, 7]), `must reject ${JSON.stringify(bad)}`);
  }
  const dummy = (source, options = {}) => runCommand(process.execPath, ["-e", source], options);
  await assert.rejects(dummy("process.stderr.write('ERROR: synthetic\\n'); process.exit(0)"), /synthetic/);
  await assert.rejects(dummy("process.exit(1)"), /failed/);
  console.log("OK: self-test (locks in the real claim, none in the broken one, ACL line, rollback drops the column, verify parser, child errors)");
  console.log("NOT RUN: PostgreSQL startup, migrations, SQL behaviour and the negative control");
}

async function main(negative) {
  assert.equal(await listening(), false, `port ${port} is occupied; no existing process was stopped`);
  const parent = path.join(root, ".vitest/pg");
  await mkdir(parent, { recursive: true });
  const scratch = await mkdtemp(path.join(parent, "mail-intake-"));
  const data = path.join(scratch, "data");
  const environment = cleanEnvironment(scratch);
  const raw = (name, args, options = {}) => runCommand(path.join(bin, name), args, { environment, ...options });
  let interrupted = false;
  let startAttempted = false;
  let cleanupPromise;
  const command = (name, args, options) => interrupted ? Promise.reject(new Error("test interrupted; cleaning up")) : raw(name, args, options);
  const psqlArgs = ["-X", "-w", "-q", "-A", "-t", "-h", "127.0.0.1", "-p", String(port), "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1"];
  const sql = (input, timeout = 30_000) => command("psql", psqlArgs, { input: `set statement_timeout='20s'; set lock_timeout='5s'; ${input}`, timeout });
  const file = (name) => command("psql", [...psqlArgs, "-f", path.join(root, name)], { timeout: 60_000 });
  const scalar = async (query) => (await sql(query)).trim();
  const verifyFile = async (name, columns, booleans) => {
    const output = await command("psql", [...psqlArgs, "-f", path.join(root, name)]);
    let cells;
    try { cells = requireVerdict(output, name, columns, booleans); } catch (error) { throw new Error(`${error.message} (row: ${output.trim()})`); }
    console.log(`OK: ${name} -> ${cells.join("|")}`);
  };
  const history = (name) => sql(`insert into supabase_migrations.schema_migrations(version,name) values(${quote(name.slice(0, 14))},${quote(name.slice(15, -4))}) on conflict(version) do nothing;`);
  const claim = (user, kind, bytes, limits = LIMITS) => scalar(asRole("service_role", `select public.claim_mail_intake('${user}','${kind}',${bytes},${lim(limits)});`));
  const log = (user, event, limits = LIMITS) => scalar(asRole("service_role", `select public.log_screen_event('${user}',${quote(JSON.stringify(event))}::jsonb,${lim(limits)});`));
  const counts = (user, kind) => scalar(`select coalesce((select count||'/'||bytes from public.mail_intake_user_counts where user_id='${user}' and kind='${kind}'
    and day=(clock_timestamp() at time zone 'Asia/Tokyo')::date),'none');`);
  const events = (user) => scalar(`select count(*) from public.screen_events where user_id='${user}';`);

  /** Start `n` sessions that all wait on one advisory lock, then let them go together; answers each session's output. */
  const together = async (n, body) => {
    const gate = sql("select pg_advisory_lock(4242); select pg_sleep(1.5); select pg_advisory_unlock(4242);", 20_000);
    await new Promise((r) => setTimeout(r, 300));
    const workers = Array.from({ length: n }, () => sql(asRole("service_role", `select pg_advisory_xact_lock_shared(4242); ${body}`), 20_000));
    const results = await Promise.all(workers);
    await gate;
    return results.map((r) => r.trim().split(/\r?\n/).filter(Boolean).at(-1));
  };

  const cleanup = () => (cleanupPromise ??= (async () => {
    if (startAttempted && await raw("pg_ctl", ["-D", data, "status"]).then(() => true, () => false)) {
      await raw("pg_ctl", ["-D", data, "-t", "10", "-m", "fast", "stop"]);
    }
    assert.equal(await listening(), false, `listener remains on 127.0.0.1:${port}`);
    console.log(`OK: cleanup, no listener on 127.0.0.1:${port}`);
    console.log(`Local logs retained under ${path.relative(root, scratch)}`);
  })());
  const requestStop = () => { interrupted = true; };
  process.once("SIGINT", requestStop);
  process.once("SIGTERM", requestStop);

  /** The concurrency check: 8 claims at once for one user with room for 3 grant exactly 3. The negative control must fail here. */
  const raceCheck = async () => {
    const results = await together(8, `select public.claim_mail_intake('${F}','forwarding_confirmation',1,${lim({ ...LIMITS, global_count: 1000 })});`);
    const granted = results.filter((r) => r === "ok").length;
    const stored = await counts(F, "forwarding_confirmation");
    assert.equal(granted, 3, `8 simultaneous claims with room for 3 granted ${granted} (${results.join(",")}); stored ${stored}`);
    assert.equal(stored, "3/3", "the stored count is the granted count");
    console.log("OK: 8 claims at once for one user with room for 3: exactly 3 granted, stored 3");
    // The global counts of this check are not part of the cases below.
    await sql("delete from public.mail_intake_global_counts;");
  };

  /** Every other assertion of the behaviour. */
  const behaviour = async () => {
    // ---- the confirmation allowance: per user count, per user bytes, global count ---------------------------------
    for (let i = 0; i < 3; i++) assert.equal(await claim(A, "forwarding_confirmation", 100), "ok", `A claim ${i + 1}`);
    assert.equal(await claim(A, "forwarding_confirmation", 100), "user_intake_limit", "A's 4th");
    assert.equal(await counts(A, "forwarding_confirmation"), "3/300", "a refused claim takes nothing");
    assert.equal(await claim(B, "forwarding_confirmation", 600), "ok");
    assert.equal(await claim(B, "forwarding_confirmation", 500), "user_intake_limit", "bytes over the user's bytes");
    assert.equal(await claim(B, "forwarding_confirmation", 400), "ok", "exactly the user's bytes fits");
    assert.equal(await counts(B, "forwarding_confirmation"), "2/1000");
    // 3 + 2 = the global 5: someone else is refused by the global allowance and keeps an untouched row.
    assert.equal(await claim(C, "forwarding_confirmation", 1), "global_intake_limit");
    assert.equal(await counts(C, "forwarding_confirmation"), "0/0", "a global refusal takes nothing from the user either");
    // Kinds are separate: the screen log of the same users is untouched.
    assert.equal(await claim(A, "screen_event", 10), "ok", "a different kind has its own allowance");
    console.log("OK: confirmation allowance per user (count and bytes) and across users; refusals take nothing; kinds are separate");

    // ---- the next JST day starts again, and rows older than yesterday go --------------------------------------
    await sql(`update public.mail_intake_user_counts set day = day - 3 where user_id='${A}' and kind='forwarding_confirmation';
      update public.mail_intake_global_counts set day = day - 3 where kind='forwarding_confirmation';`);
    assert.equal(await claim(A, "forwarding_confirmation", 100), "ok", "a new day has room again");
    assert.equal(await scalar(`select count(*) from public.mail_intake_user_counts where user_id='${A}' and kind='forwarding_confirmation';`), "1", "A's old row is removed");
    assert.equal(await scalar(`select count(*) from public.mail_intake_global_counts where kind='forwarding_confirmation';`), "1", "the old global row is removed");
    console.log("OK: a new JST day has room again, and rows older than yesterday are removed");

    // ---- bad arguments, unknown owner, privileges ---------------------------------------------------------------
    for (const bad of [
      `select public.claim_mail_intake('${A}','forwarding_confirmation',-1,${lim()});`,
      `select public.claim_mail_intake('${A}','other_kind',1,${lim()});`,
      `select public.claim_mail_intake(null,'forwarding_confirmation',1,${lim()});`,
      `select public.claim_mail_intake('${A}','forwarding_confirmation',1,${lim({ ...LIMITS, user_count: 0 })});`,
      `select public.claim_mail_intake('${A}','forwarding_confirmation',1,${lim({ user_count: 3, user_bytes: 1000, global_count: 5 })});`,
      `select public.claim_mail_intake('${A}','forwarding_confirmation',1,'{"user_count":1.5,"user_bytes":1,"global_count":1,"global_bytes":1}'::jsonb);`,
      `select public.claim_mail_intake('${A}','forwarding_confirmation',1,'{"user_count":"3","user_bytes":1,"global_count":1,"global_bytes":1}'::jsonb);`,
      `select public.log_screen_event('${A}','{"decision":"kept"}'::jsonb,${lim()});`,
    ]) await assert.rejects(sql(asRole("service_role", bad)), /bad argument|limits must be/, bad);
    await assert.rejects(sql(asRole("service_role", `select public.claim_mail_intake('${uuid(999)}','forwarding_confirmation',1,${lim()});`)), /no longer exists/);
    for (const role of ["anon", "authenticated"]) {
      await assert.rejects(sql(asRole(role, `select public.claim_mail_intake('${A}','forwarding_confirmation',1,${lim()});`)), /permission denied/, `${role} claim`);
      await assert.rejects(sql(asRole(role, `select public.log_screen_event('${A}','{"decision":"dropped"}'::jsonb,${lim()});`)), /permission denied/, `${role} log`);
    }
    for (const role of ["anon", "authenticated", "service_role"]) {
      await assert.rejects(sql(asRole(role, "select count(*) from public.mail_intake_user_counts;")), /permission denied/, `${role} reads the counts`);
      await assert.rejects(sql(asRole(role, "select count(*) from public.mail_intake_global_counts;")), /permission denied/, `${role} reads the global counts`);
    }
    console.log("OK: bad arguments (22023), an unknown owner (23503), anon/authenticated cannot execute, no role reads the counts directly");

    // ---- the screen log: one row per delivery, within the allowance ------------------------------------------
    const ad = { decision: "dropped", from_domain: "shop.example", subject: "セール", reason: "ad", delivery_key: "<ad-1@shop.example>" };
    assert.equal(await log(D, ad), "logged");
    assert.equal(await log(D, ad), "duplicate", "the same delivery again");
    assert.equal(await events(D), "1");
    assert.equal(await counts(D, "screen_event"), `1/${Buffer.byteLength("セール") + "shop.example".length + 2}`, "a duplicate takes nothing");
    assert.equal(await scalar(`select (subject='セール')::text||'/'||(delivery_digest is not null)::text||'/'||(position('ad-1' in encode(delivery_digest,'escape'))=0)::text
      from public.screen_events where user_id='${D}';`), "true/true/true", "the subject is kept, the ID only as a digest");
    assert.equal(await log(D, { ...ad, decision: "rescued" }), "logged", "the other decision for the same mail is its own row");
    assert.equal(await scalar(`select coalesce(subject,'null') from public.screen_events where user_id='${D}' and decision='rescued';`), "null", "no subject for a rescued mail");
    assert.equal(await log(E, ad), "logged", "another user's delivery with the same Message-ID is theirs");
    // Without a key every event is counted until the allowance ends; a refused one leaves no row.
    const plain = { decision: "dropped", from_domain: "shop.example", subject: "x", reason: "ad" };
    assert.equal(await log(D, plain), "logged", "D's third (no key)");
    assert.equal(await log(D, plain), "user_intake_limit", "D's fourth is over the user's count");
    assert.equal(await events(D), "3", "a refused event leaves no row");
    console.log("OK: the screen log keeps one row per delivery and decision, per user, within the allowance; refused events leave nothing");

    // Six at once with the same delivery: one row, one count (the losers give their count back).
    const sameKey = { ...ad, delivery_key: "<race@shop.example>" };
    const raced = await together(6, `select public.log_screen_event('${E}',${quote(JSON.stringify(sameKey))}::jsonb,${lim({ ...LIMITS, global_count: 1000 })});`);
    assert.deepEqual(raced.slice().sort(), ["duplicate", "duplicate", "duplicate", "duplicate", "duplicate", "logged"], `six at once: ${raced.join(",")}`);
    assert.equal(await events(E), "2", "E: the earlier row and one row for the raced delivery");
    assert.equal(await scalar(`select count from public.mail_intake_user_counts where user_id='${E}' and kind='screen_event';`), "2", "the five duplicates gave their count back");
    console.log("OK: six simultaneous logs of one delivery: one row, one count");

    // ---- the daily sweep still removes old unflagged rows; account deletion takes the user's rows -------------
    await sql(`update public.screen_events set created_at = now() - interval '20 days' where user_id='${D}' and decision='rescued';`);
    await sql("select public.purge_old_screen_events();");
    assert.equal(await scalar(`select count(*) from public.screen_events where user_id='${D}' and decision='rescued';`), "0", "the daily sweep still works");
    await sql(`delete from auth.users where id='${D}';`);
    assert.equal(await scalar(`select (select count(*) from public.mail_intake_user_counts where user_id='${D}')+(select count(*) from public.screen_events where user_id='${D}');`), "0", "deleting the account removes its counts and log");
    console.log("OK: the daily sweep still removes old rows; deleting the account removes its counts and log");
  };

  try {
    assert.match(await command("initdb", ["--version"]), /PostgreSQL\) 17\./);
    await command("initdb", ["-D", data, "-U", "postgres", "--no-sync", "-c", "dynamic_shared_memory_type=mmap", "-c", "shared_memory_type=mmap"]);
    startAttempted = true;
    await command("pg_ctl", ["-D", data, "-l", path.join(scratch, "server.log"), "-t", "10", "-o",
      `-h 127.0.0.1 -p ${port} -c unix_socket_directories= -c dynamic_shared_memory_type=mmap -c shared_memory_type=mmap -c deadlock_timeout=100ms -c max_connections=50`, "start"], { timeout: 20_000 });
    assert.equal(await listening(), true);
    assert.equal(await scalar("show listen_addresses;"), "127.0.0.1");
    assert.equal(Number(await scalar("show port;")), port);
    await file("tests/postgres/bootstrap.sql");
    // Supabase gives the migration role default privileges on everything it creates in public. Reproduce that before any migration runs.
    const role = (await scalar("select current_user;")).replaceAll('"', '""');
    await sql(`alter default privileges for role "${role}" in schema public grant all on tables to anon, authenticated, service_role;
      alter default privileges for role "${role}" in schema public grant execute on functions to anon, authenticated, service_role;
      alter default privileges for role "${role}" in schema public grant all on sequences to anon, authenticated, service_role;
      grant usage on schema public to anon, authenticated, service_role;`);
    await sql("create schema supabase_migrations; create table supabase_migrations.schema_migrations(version text primary key,name text,statements text[]);");
    for (const name of priorMigrations(await readdir(path.join(root, "supabase/migrations")))) {
      if (name === "20261106180000_screen_events_daily_purge.sql") {
        // Only the function part: vanilla PostgreSQL has no pg_cron (the same stand-in the other runners use).
        const source = await readFile(path.join(root, "supabase/migrations", name), "utf8");
        await sql(source.slice(source.indexOf("create or replace function public.is_shared_mail_domain"), source.indexOf("select cron.schedule")));
        await sql("create schema cron; create table cron.job(jobname text,command text,schedule text,active boolean); insert into cron.job values('otodoke-purge-old-screen-events','select public.purge_old_screen_events()','30 18 * * *',true);");
      } else await file(`supabase/migrations/${name}`);
      await history(name);
    }
    await sql(`insert into auth.users(id) values ${[A, B, C, D, E, F].map((u) => `('${u}')`).join(",")};`);
    // An existing log row from before this migration stays through apply and rollback.
    await sql(`insert into public.screen_events(user_id,from_domain,subject,decision,reason) values ('${A}','old.example','old','dropped','ad');`);

    await verifyFile(files.before, 2, []);
    await file(files.migration);
    await file(files.migration);
    await verifyFile(files.verify, 10, [1, 2, 3, 4, 5, 6, 7]);
    assert.equal(await events(A), "1", "the earlier row is kept");

    if (negative) {
      await sql(brokenClaim);
      let caught = null;
      try { await raceCheck(); } catch (error) { caught = error; }
      assert.ok(caught, "NEGATIVE CONTROL NOT CAUGHT: a claim without row locks passed the concurrency check");
      assert.match(String(caught.message), /simultaneous claims with room for 3 granted/, `the control failed for another reason: ${caught.message}`);
      console.log(`OK: NEGATIVE CONTROL, the unlocked claim was caught: ${String(caught.message).split("\n")[0]}`);
    } else {
      await raceCheck();
      await behaviour();
      await file(files.down);
      await file(files.down);
      await verifyFile(files.rolledBack, 2, []);
      await verifyFile(files.before, 2, []);
      assert.equal(await events(A), "1", "rollback keeps the earlier log rows");
      console.log("OK: rollback twice: functions, tables, column and index gone, the before verify is OK again, earlier rows kept");
      await file(files.migration);
      await verifyFile(files.verify, 10, [1, 2, 3, 4, 5, 6, 7]);
    }
  } finally {
    await cleanup();
    process.removeListener("SIGINT", requestStop);
    process.removeListener("SIGTERM", requestStop);
  }
  assert.equal(interrupted, false, "test interrupted");
  console.log("verdict=OK");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length > 1 || args.some((arg) => !["--self-test", "--negative-control"].includes(arg))) {
    console.error("Usage: node tests/postgres/run-mail-intake-window.mjs [--self-test|--negative-control]");
    process.exitCode = 2;
  } else {
    (args[0] === "--self-test" ? selfTest() : main(args[0] === "--negative-control")).catch((error) => {
      console.error(`verdict=FAILED: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    });
  }
}
