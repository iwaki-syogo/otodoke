import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { priorMigrations } from "./run-claude-claim-consent.mjs";
import { requireVerdict, runCommand } from "./run-cost-guards.mjs";
import { cleanEnvironment } from "./run-parcel-conflicts.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const beforeFile = "supabase/verify/20261113121000_claude_claim_consent.before.sql";
const port = 65446;
const bin = process.env.OTODOKE_PG_BINDIR ?? "";
const roles = [
  { name: "consent_before_table", allowed: true, table: true },
  { name: "consent_before_direct", allowed: true, table: false },
  { name: "consent_before_inherited", allowed: true, table: false },
  { name: "consent_before_no_auth_usage", allowed: false, table: false },
  { name: "consent_before_no_id_select", allowed: false, table: false },
  { name: "consent_before_no_update", allowed: false, table: false },
  { name: "consent_before_noinherit", allowed: false, table: false },
];

// These are the effective row-lock privileges accepted by 110000, not table-wide grants.
const lockPrivileges = `coalesce(
  has_schema_privilege(current_user,to_regnamespace('auth'),'USAGE')
  and has_column_privilege(current_user,to_regclass('auth.users'),'id','SELECT')
  and has_any_column_privilege(current_user,to_regclass('auth.users'),'UPDATE'),false)`;
const legacyPrivileges = "has_table_privilege(current_user,'auth.users','SELECT') and has_table_privilege(current_user,'auth.users','UPDATE')";

function withAuthCheck(source, replacement) {
  const prefix = "as owned_parent_prefix,";
  assert.equal(source.split(prefix).length, 2, "expected one owned-parent check before Auth privileges");
  const start = source.indexOf("\n    ", source.indexOf(prefix)) + "\n    ".length;
  const end = source.indexOf("\n      and has_table_privilege(current_user,'public.sample_generations','SELECT')", start);
  assert.ok(start >= prefix.length && end > start, "cannot isolate the Auth privilege predicate");
  return source.slice(0, start) + replacement + source.slice(end);
}

function assertBefore(output, allowed, label) {
  assert.equal(typeof output, "string", `${label}: expected text output`);
  assert.doesNotMatch(output, /\b(?:ERROR|FATAL|PANIC):/i, `${label}: SQL error is not a verdict`);
  const rows = output.trim().split(/\r?\n/);
  assert.equal(rows.length, 1, `${label}: expected one before result row`);
  const cells = rows[0].split("|");
  assert.deepEqual(cells, [allowed ? "OK" : "FAILED", "t", "t", "t", allowed ? "t" : "f", "t", "t"],
    `${label}: only required_lock_privileges may fail; expected ${allowed ? "OK" : "FAILED"}`);
  if (allowed) requireVerdict(output, beforeFile);
}

async function listening() {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    const finish = (value) => { socket.destroy(); resolve(value); };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(500, () => finish(false));
  });
}

async function selfTest() {
  const source = await readFile(path.join(root, beforeFile), "utf8");
  const unguarded = withAuthCheck(source, "true");
  assert.equal(unguarded.includes("true\n      and has_table_privilege(current_user,'public.sample_generations','SELECT')"), true);
  assert.equal(withAuthCheck(source, legacyPrivileges).includes(legacyPrivileges), true);
  assertBefore("OK|t|t|t|t|t|t\n", true, "allowed example");
  assertBefore("FAILED|t|t|t|f|t|t\n", false, "denied example");
  for (const output of ["", "OK|t|t|t|f|t|t\n", "FAILED|t|t|t|f|t|t\n", "OK|t|t|t|t|t|t\nOK|t|t|t|t|t|t\n", "ERROR: failed\nOK|t|t|t|t|t|t\n"]) {
    assert.throws(() => assertBefore(output, true, "malformed allowed example"));
  }
  for (const output of ["OK|t|t|t|t|t|t\n", "FAILED|f|t|t|f|t|t\n", "FAILED|t|t|t||t|t\n", "FAILED|t|t|t|f|t|t|extra\n"]) {
    assert.throws(() => assertBefore(output, false, "malformed denied example"));
  }
  console.log("OK: runner self-test (exact seven-column result, failed prerequisite isolation, mutation boundaries)");
  console.log("NOT RUN: PostgreSQL, effective role privileges or row-lock behavior");
}

async function main(mode) {
  assert.equal(await listening(), false, `port ${port} is in use; no existing process stopped`);
  const parent = path.join(root, ".vitest/pg");
  await mkdir(parent, { recursive: true });
  const scratch = await mkdtemp(path.join(parent, "consent-before-privs-"));
  const data = path.join(scratch, "data");
  const environment = cleanEnvironment(scratch);
  let attempted = false, interrupted = false;
  const raw = (name, args, options) => runCommand(path.join(bin, name), args, { environment, ...options });
  const command = (name, args, options) => {
    assert.equal(interrupted, false, "interrupted; cleaning up");
    return raw(name, args, options);
  };
  const args = ["-X", "-w", "-q", "-A", "-t", "-h", "127.0.0.1", "-p", String(port), "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-v", "VERBOSITY=verbose"];
  const sql = (input) => command("psql", args, { input });
  const file = (name) => command("psql", [...args, "-f", path.join(root, name)]);
  const asRole = (role, input) => sql(`begin; set local role ${role}; ${input}\nrollback;`);
  const stop = () => { interrupted = true; };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    assert.match(await command("initdb", ["--version"]), /PostgreSQL\) 17\./);
    await command("initdb", ["-D", data, "-U", "postgres", "--no-sync", "-c", "dynamic_shared_memory_type=mmap", "-c", "shared_memory_type=mmap"]);
    attempted = true;
    const serverLog = path.join(scratch, "server.log");
    try {
      // Every client uses TCP; disabling Unix sockets also avoids path-length limits in worktrees.
      await command("pg_ctl", ["-D", data, "-l", serverLog, "-t", "10", "-o",
        `-h 127.0.0.1 -p ${port} -c unix_socket_directories='' -c dynamic_shared_memory_type=mmap -c shared_memory_type=mmap -c statement_timeout=15s`, "start"]);
    } catch (error) {
      // Capture only this disposable cluster's startup log before finally removes its data.
      const diagnostic = await readFile(serverLog, "utf8").catch((logError) => `Startup log unavailable: ${logError.message}`);
      throw new Error(`${error instanceof Error ? error.message : String(error)}\nDedicated PostgreSQL startup log:\n${diagnostic}`, { cause: error });
    }
    await file("tests/postgres/bootstrap.sql");
    for (const name of priorMigrations(await readdir(path.join(root, "supabase/migrations")))) {
      if (name === "20261106180000_screen_events_daily_purge.sql") {
        // Only pg_cron's scheduler is a local stub; application functions are the real migration.
        const source = await readFile(path.join(root, "supabase/migrations", name), "utf8");
        const start = source.indexOf("create or replace function public.is_shared_mail_domain");
        const end = source.indexOf("select cron.schedule");
        assert.ok(start >= 0 && end > start, "expected the existing daily-purge application SQL boundary");
        await sql(source.slice(start, end));
        await sql("create schema cron; create table cron.job(jobname text,command text,schedule text,active boolean); insert into cron.job values('otodoke-purge-old-screen-events','select public.purge_old_screen_events()','30 18 * * *',true);");
      } else await file(`supabase/migrations/${name}`);
    }
    requireVerdict(await file("supabase/verify/20261113120000_consent_waiting_storage.sql"), "supabase/verify/20261113120000_consent_waiting_storage.sql");
    assertBefore(await file(beforeFile), true, "bootstrap owner");
    console.log("OK: real migrations through 120000, all 121000 before prerequisites true for bootstrap owner");

    // The only extra Auth column is synthetic and exists solely in this disposable cluster.
    const names = roles.map(({ name }) => name).join(",");
    await sql(`
      alter table auth.users add column consent_privilege_probe boolean;
      create role consent_before_columns nologin;
      ${roles.map(({ name }) => `create role ${name} nologin ${name.endsWith("noinherit") ? "noinherit" : "inherit"};`).join("\n")}
      grant usage on schema public to ${names};
      grant select,update on public.sample_generations,public.ai_reading_consents to ${names};
      grant usage on schema auth to consent_before_columns,${roles.filter(({ name }) => name !== "consent_before_no_auth_usage").map(({ name }) => name).join(",")};
      grant select,update on auth.users to consent_before_table;
      grant select(id),update(consent_privilege_probe) on auth.users to consent_before_columns,consent_before_direct,consent_before_no_auth_usage;
      grant consent_before_columns to consent_before_inherited,consent_before_noinherit;
      grant select(consent_privilege_probe),update(consent_privilege_probe) on auth.users to consent_before_no_id_select;
      grant select(id) on auth.users to consent_before_no_update;
    `);
    // Resolve the relation as bootstrap owner: a missing schema USAGE must not break diagnostics.
    const authUsersOid = (await sql("select 'auth.users'::regclass::oid;")).trim();
    assert.match(authUsersOid, /^[1-9]\d*$/, "expected the disposable Auth table OID");
    let source = await readFile(path.join(root, beforeFile), "utf8");
    if (mode === "--legacy-auth-check") {
      source = withAuthCheck(source, legacyPrivileges);
      console.log("MUTATION: legacy table-wide Auth check; column-only positive control must fail");
    } else if (mode === "--negative-control") {
      source = withAuthCheck(source, "true");
      console.log("MUTATION: Auth privilege guard removed; insufficient-role negative control must fail");
    }

    for (const role of roles) {
      console.log(`STAGE: ${role.name}: fixture privilege diagnostics`);
      const privileges = (await asRole(role.name, `select ${lockPrivileges},has_table_privilege(current_user,${authUsersOid}::oid,'SELECT'),has_table_privilege(current_user,${authUsersOid}::oid,'UPDATE');`)).trim().split("|");
      assert.deepEqual(privileges, [role.allowed ? "t" : "f", role.table ? "t" : "f", role.table ? "t" : "f"],
        `${role.name}: fixture must distinguish effective 110000 privileges from table-wide grants`);
      console.log(`STAGE: ${role.name}: actual zero-row Auth lock, expected ${role.allowed ? "allowed" : "denied"}`);
      const lockQuery = asRole(role.name, "select id from auth.users where false for key share;");
      if (role.allowed) await lockQuery;
      else await assert.rejects(lockQuery, (error) => /42501:\s+permission denied for (?:schema auth|table users)/.test(error.message),
        `${role.name}: actual zero-row Auth lock must be refused for missing privileges`);
      console.log(`STAGE: ${role.name}: real before SQL`);
      const output = await asRole(role.name, source);
      console.log(`CHECK: ${role.name}, 110000_effective=${privileges[0]}, table_SELECT=${privileges[1]}, table_UPDATE=${privileges[2]}, before=${output.trim()}`);
      assertBefore(output, role.allowed, role.name);
    }
    console.log("OK: seven actual-role cases, column-only direct/inherited grants and exact insufficient privileges");
  } finally {
    if (attempted) {
      const running = await raw("pg_ctl", ["-D", data, "status"]).then(() => true, (error) => {
        assert.match(error.message, /pg_ctl failed \(3\):[\s\S]*no server running/, "unexpected server status failure; retain dedicated data");
        return false;
      });
      if (running) await raw("pg_ctl", ["-D", data, "-t", "10", "-m", "fast", "stop"]);
      await assert.rejects(raw("pg_ctl", ["-D", data, "status"]), /pg_ctl failed \(3\):[\s\S]*no server running/);
    }
    assert.equal(await listening(), false, `listener remains on ${port}; dedicated data retained`);
    await rm(scratch, { recursive: true, force: true });
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    console.log(`OK: cleanup, no listener on 127.0.0.1:${port}, dedicated data deleted`);
  }
  assert.equal(interrupted, false, "interrupted");
  console.log("verdict=OK");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2];
  if (process.argv.length > 3 || (mode && !["--self-test", "--legacy-auth-check", "--negative-control"].includes(mode))) {
    console.error("Usage: node tests/postgres/run-consent-before-privileges.mjs [--self-test|--legacy-auth-check|--negative-control]");
    process.exitCode = 2;
  } else (mode === "--self-test" ? selfTest() : main(mode)).catch((error) => {
    console.error(`verdict=FAILED: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
