import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cleanEnvironment } from "./run-parcel-conflicts.mjs";
import { runCommand, taggedResults } from "./run-cost-guards.mjs";

// Disposable PostgreSQL 17 only: new cluster on 127.0.0.1, no Supabase, Resend or other external endpoint.
const root = fileURLToPath(new URL("../../", import.meta.url));
const stem = "20261113140000_cleared_mail_marks";
const port = 65447;
const bin = process.env.OTODOKE_PG_BINDIR ?? "";
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const quote = (s) => `'${String(s).replaceAll("'", "''")}'`;
const json = (v) => `${quote(JSON.stringify(v))}::jsonb`;
const limits = { user_count: 1000, user_bytes: 10_000_000, global_count: 100_000, global_bytes: 100_000_000 };
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const downs = [
  "20261113140000_cleared_mail_marks", "20261113130000_received_receipts", "20261113121000_claude_claim_consent",
  "20261113120000_consent_waiting_storage", "20261113110000_sample_generation",
];

export function priorMigrations(names) {
  return names.filter((name) => /^\d{14}_.+\.sql$/.test(name) && name < `${stem}.sql`).sort();
}

/** One header line and one row. verdict must be OK; strict files may only hold t / counts. */
export function requireVerifyVerdict(output, name, strict = true) {
  assert.doesNotMatch(output, /\b(?:ERROR|FATAL|PANIC):/i, `${name}: SQL error in stdout`);
  const rows = output.trim().split(/\r?\n/);
  assert.equal(rows.length, 2, `${name}: expected a header and exactly one result row`);
  const names = rows[0].split("|"), cells = rows[1].split("|");
  assert.equal(names.length, cells.length, `${name}: header and row differ in width`);
  const at = names.indexOf("verdict");
  assert.ok(at >= 0, `${name}: no column named verdict`);
  assert.equal(names.filter((n) => n === "verdict").length, 1, `${name}: verdict must be one column`);
  assert.equal(cells[at], "OK", `${name}: verdict must be OK`);
  cells.forEach((cell, i) => {
    if (i === at) return;
    assert.notEqual(cell, "f", `${name}: check ${names[i]} is false`);
    if (strict) assert.match(cell, /^(?:t|\d+)$/, `${name}: column ${names[i]} must be t or a count`);
  });
}

/** Migration file names that a `supabase db push` output mentions, in first-seen order, without repeats. */
export function listedMigrations(output) {
  return [...new Set([...output.matchAll(/\b\d{14}_[a-z0-9_]+\.sql\b/g)].map((m) => m[0]))];
}

/** The run is judged by this printed line, never by an exit code alone. */
export function finalVerdict(stdout) {
  const lines = stdout.trim().split(/\r?\n/);
  const last = lines.at(-1) ?? "";
  assert.match(last, /^verdict=(?:OK|FAILED)$/, "no final verdict line");
  assert.equal(last, "verdict=OK", "final verdict is not OK");
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

function extract(source, re) {
  const m = source.match(re);
  assert.ok(m, `missing definition ${re}`);
  return m[0];
}

async function selfTest() {
  assert.deepEqual(priorMigrations([`${stem}.sql`, "20261113150000_future.sql", "20261113130000_received_receipts.sql", "notes.md"]), ["20261113130000_received_receipts.sql"]);
  const good = "verdict|a|b|n\nOK|t|t|3\n";
  requireVerifyVerdict(good, "self");
  for (const bad of ["", "verdict|a\nFAILED|t\n", "verdict|a\nOK|f\n", "a|b\nt|t\n", "verdict|a\nOK|t\nERROR: x\n", "verdict|a\nOK|maybe\n", "verdict|a|b\nOK|t\n", good + "extra|row\n", "verdict|verdict\nOK|OK\n"]) {
    assert.throws(() => requireVerifyVerdict(bad, "self"), undefined, JSON.stringify(bad));
  }
  assert.doesNotThrow(() => requireVerifyVerdict("verdict|failures\nOK|{}\n", "self", false));
  assert.throws(() => requireVerifyVerdict("verdict|failures\nOK|{}\n", "self", true));
  assert.deepEqual(listedMigrations("Would push these migrations:\n • 20261113140000_cleared_mail_marks.sql\n{\"migrations\":[\"20261113140000_cleared_mail_marks.sql\"]}"), [`${stem}.sql`]);
  assert.deepEqual(listedMigrations("Remote database is up to date."), []);
  finalVerdict("lots\nverdict=OK\n");
  for (const bad of ["", "OK\n", "verdict=FAILED\n", "verdict=OK\nmore output\n"]) assert.throws(() => finalVerdict(bad), undefined, JSON.stringify(bad));
  await assert.rejects(runCommand(process.execPath, ["-e", "process.stderr.write('ERROR: broken SQL');process.exit(0)"]), /broken SQL/);
  await assert.rejects(runCommand(process.execPath, ["-e", "process.exit(1)"]));
  await assert.rejects(runCommand(process.execPath, ["-e", "setTimeout(()=>{},10000)"], { timeout: 10 }), /SIGTERM/);
  const up = await readFile(path.join(root, `supabase/migrations/${stem}.sql`), "utf8");
  const down = await readFile(path.join(root, `supabase/rollback/${stem}.down.sql`), "utf8");
  assert.equal((up.match(/interval '35 days'/g) ?? []).length, 1);
  assert.equal((up.match(/interval '120 seconds'/g) ?? []).length, 1);
  assert.equal((up.match(/create or replace function public\.store_mail_run\(/g) ?? []).length, 0, "the public entry must not be redefined or overloaded");
  const old = await readFile(path.join(root, "supabase/migrations/20261113120000_consent_waiting_storage.sql"), "utf8");
  const oldStore = extract(old, /create or replace function public\.store_mail_run_without_sample_fence\([\s\S]*?\nend \$\$;/);
  assert.ok(down.includes(oldStore), "rollback must carry the exact 120000 store body");
  const oldClear = extract(await readFile(path.join(root, "supabase/migrations/20261113110000_sample_generation.sql"), "utf8"), /create or replace function public\.clear_all_parcels\(p_user_id uuid\)[\s\S]*?\nend \$\$;/);
  assert.ok(down.includes(oldClear), "rollback must carry the exact 110000 clear body");
  // Every line of the 120000 store body appears, in order, in the new body; only the marked block is added.
  const newStore = extract(up, /create or replace function public\.store_mail_run_without_sample_fence\([\s\S]*?\nend \$\$;/);
  const added = newStore.split("\n"), kept = oldStore.split("\n");
  let i = 0;
  for (const line of added) if (i < kept.length && line === kept[i]) i += 1;
  assert.equal(i, kept.length, "new store body must contain every 120000 line unchanged and in order");
  // A27-3: the prior verify carries the 130000 runtime checks verbatim and every check column of the 130000 and 120000 verify files.
  const v130 = await readFile(path.join(root, "supabase/verify/20261113130000_received_receipts.sql"), "utf8");
  const v120 = await readFile(path.join(root, "supabase/verify/20261113120000_consent_waiting_storage.sql"), "utf8");
  const prior = await readFile(path.join(root, `supabase/verify/${stem}.prior.sql`), "utf8");
  assert.ok(prior.includes(extract(v130, /begin;\ncreate temporary table receipt_runtime_checks[\s\S]*?\nend \$\$;/)), "prior verify must carry the 130000 runtime checks verbatim");
  const columns = (source) => [...source.slice(source.indexOf("with checks as"), source.lastIndexOf("select case")).matchAll(/\bas ([a-z_]+),?\n/g)].map((m) => m[1]);
  for (const name of [...columns(v130), ...columns(v120)]) assert.match(prior, new RegExp(`\\bas ${name}\\b`), `prior verify lacks ${name}`);
  assert.ok(columns(v130).length >= 14 && columns(v120).length >= 8, "column scan found the checks");
  console.log("OK: self-test (verify parser rejects FAILED/false/missing column/SQL error/extra rows; verdict line required; exit-zero SQL error and timeout rejected; one constant each; rollback carries exact prior bodies; 120000 body lines preserved in order; prior verify carries the 130000 runtime block and every 130000/120000 check)");
  console.log("NOT RUN: PostgreSQL startup, SQL behavior, migration/rollback, concurrency and SQL negative control");
  console.log("verdict=OK");
}

async function main(negative, options = {}) {
  assert.equal(await listening(), false, `port ${port} already used; no existing process was stopped`);
  const parent = path.join(root, ".vitest/pg");
  await mkdir(parent, { recursive: true });
  const scratch = await mkdtemp(path.join(parent, "cleared-marks-"));
  const data = path.join(scratch, "data");
  const environment = cleanEnvironment(scratch);
  let attempted = false, interrupted = false, counter = 100;
  const nextId = () => uuid(++counter);
  const command = (name, args, options) => {
    assert.equal(interrupted, false, "interrupted; cleaning up");
    return runCommand(path.join(bin, name), args, { environment, ...options });
  };
  const base = (db) => ["-X", "-w", "-q", "-A", "-h", "127.0.0.1", "-p", String(port), "-U", "postgres", "-d", db, "-v", "ON_ERROR_STOP=1"];
  const psqlOn = (db, input) => command("psql", [...base(db), "-t"], { input: `set statement_timeout='20s'; set lock_timeout='10s'; set deadlock_timeout='100ms';\n${input}` });
  const sql = (input) => psqlOn("postgres", input);
  const scalar = async (input) => (await sql(input)).trim();
  const fileOn = (db, name, extra = []) => command("psql", [...base(db), ...extra, "-f", path.join(root, name)], { timeout: 60_000 });
  const verifyOn = async (db, name, strict = true) => {
    const output = await fileOn(db, name, ["-P", "footer=off"]);
    requireVerifyVerdict(output, name, strict);
    console.log(`OK: ${name} -> ${output.trim().split(/\r?\n/).at(-1)}`);
  };
  const verify = (name, strict) => verifyOn("postgres", name, strict);
  const record = (name) => sql(`insert into supabase_migrations.schema_migrations(version,name) values(${quote(name.slice(0, 14))},${quote(name.slice(15, -4))}) on conflict(version) do nothing;`);
  const unrecord = (version) => sql(`delete from supabase_migrations.schema_migrations where version='${version}';`);
  const stop = () => { interrupted = true; };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  // ---- helpers over the real public API ----
  const call = (user, o = {}) => {
    const columns = { provider_email_id: o.provider, processing_status: "pending", text_body: "Synthetic body", ...(o.message === undefined ? {} : { message_id: o.message }), ...(o.columns ?? {}) };
    const headers = o.noHeaders ? "" : `set local request.headers=${quote(JSON.stringify(o.headers ?? {}))};`;
    const expected = o.expected ? `${quote(o.expected)}::timestamptz` : "null";
    return `begin; set local role service_role; ${headers} select 'RESULT:'||verdict||'|'||email_id from public.store_mail_run(${quote(user)},${quote(o.id ?? nextId())},${quote(nextId())},${json(columns)},${expected},${json(limits)}); commit;`;
  };
  const store = async (user, o) => taggedResults(await sql(call(user, o)))[0].split("|")[0];
  const processAll = (user) => sql(`update public.emails set processing_status='processed' where user_id=${quote(user)};`);
  const clear = (user) => sql(`begin; set local role service_role; select 'RESULT:'||public.clear_all_parcels(${quote(user)}); commit;`);
  const mails = async (user, provider) => Number(await scalar(`select count(*) from public.emails where user_id=${quote(user)}${provider ? ` and provider_email_id=${quote(provider)}` : ""};`));
  const marks = async (user) => Number(await scalar(`select count(*) from public.cleared_mail_marks where user_id=${quote(user)};`));
  const newUser = async () => { const id = nextId(); await sql(`insert into auth.users(id) values(${quote(id)});`); return id; };
  const markedAtMs = async (user) => Number(await scalar(`select (extract(epoch from max(marked_at))*1000)::bigint from public.cleared_mail_marks where user_id=${quote(user)};`));
  const seedAndClear = async (user, provider, message) => {
    assert.equal(await store(user, { provider, message }), "ok");
    await processAll(user);
    await clear(user);
    assert.equal(await mails(user), 0);
    return markedAtMs(user);
  };
  const fingerprint = async (db = "postgres") => (await psqlOn(db, `select jsonb_build_object(
    'functions',(select jsonb_agg(jsonb_build_object('sig',p.oid::regprocedure::text,'md5',md5(p.prosrc),'acl',p.proacl::text,'cfg',p.proconfig,
      'owner',p.proowner::regrole::text,'sec',p.prosecdef,'vol',p.provolatile,'ret',pg_get_function_result(p.oid),'args',pg_get_function_arguments(p.oid)) order by p.oid::regprocedure::text)
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prokind='f'),
    'relations',(select jsonb_agg(jsonb_build_object('name',c.relname,'kind',c.relkind,'rls',c.relrowsecurity,'acl',c.relacl::text) order by c.relname)
      from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public'),
    'triggers',(select jsonb_agg(t.tgname||':'||c.relname order by t.tgname,c.relname) from pg_trigger t join pg_class c on c.oid=t.tgrelid where not t.tgisinternal and c.relnamespace='public'::regnamespace)
    )::text;`)).trim();
  const aclReport = async () => (await sql(`select o.name||'|'||coalesce(r.rolname,'PUBLIC')||'|'||x.privilege_type from (
      select p.oid::regprocedure::text as name, coalesce(p.proacl, acldefault('f',p.proowner)) as acl from pg_proc p
        where p.pronamespace='public'::regnamespace and p.proname in ('cleared_mail_mark_retention','cleared_mail_mark_clock_margin','purge_expired_cleared_mail_marks',
          'purge_old_screen_events','purge_old_screen_events_before_cleared_mail_marks','clear_all_parcels','store_mail_run_without_sample_fence')
      union all select c.relname::text, coalesce(c.relacl, acldefault('r',c.relowner)) from pg_class c where c.oid=to_regclass('public.cleared_mail_marks')
    ) o cross join lateral aclexplode(o.acl) x left join pg_roles r on r.oid=x.grantee
    where x.grantee=0 or r.rolname in ('anon','authenticated','service_role') order by 1;`)).trim().split(/\r?\n/).filter(Boolean);
  const dbUrl = (db) => `postgresql://postgres@127.0.0.1:${port}/${db}?sslmode=disable`;
  const cliEnvironment = Object.fromEntries(Object.entries(environment).filter(([key]) => !key.startsWith("SUPABASE_")));
  // Real Supabase CLI against the disposable cluster only: --db-url on 127.0.0.1, stdin closed, no --yes. Returns the code instead of throwing.
  const cli = (args) => new Promise((resolve, reject) => {
    assert.equal(interrupted, false, "interrupted; cleaning up");
    assert.ok(args.includes("--db-url"), "the CLI is only ever run with --db-url");
    const child = spawn("supabase", args, { cwd: root, env: cliEnvironment, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), 120_000);
    child.stdout.on("data", (c) => { out += c; });
    child.stderr.on("data", (c) => { out += c; });
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code, signal) => { clearTimeout(timer); resolve({ code: code ?? signal, out }); });
  });
  const historyRows = async (db, version) => Number((await psqlOn(db, `select count(*) from supabase_migrations.schema_migrations${version ? ` where version='${version}'` : ""};`)).trim());
  // psql as another login role (default: the application owner is postgres). VERBOSITY=verbose prints the SQLSTATE.
  const asRole = (db, user, args) => command("psql", [...base(db).map((a, i, all) => (all[i - 1] === "-U" ? user : a)), "-v", "VERBOSITY=verbose", ...args], { timeout: 60_000 });
  const stripOwnerGate = (source) => {
    const stripped = source.replace(/do \$cleared_owner_gate\$[\s\S]*?end \$cleared_owner_gate\$;\n/, "");
    assert.notEqual(stripped, source, "owner gate block not found");
    return stripped;
  };
  const verdictOf = async (db, name) => {
    const rows = (await fileOn(db, name, ["-P", "footer=off"])).trim().split(/\r?\n/);
    const names = rows[0].split("|"), cells = rows[1].split("|");
    const failing = names.filter((n, k) => cells[k] === "f");
    if (failing.length) console.log(`INFO: ${name} on ${db}: false checks: ${failing.join(",")}`);
    return cells[names.indexOf("verdict")];
  };
  const denied = (input) => assert.rejects(sql(input), /permission denied/i);
  // A27-3: what every verify file reads at a point (OK / FAILED / ERROR for an SQL error).
  const stateFiles = [
    ["before", `supabase/verify/${stem}.before.sql`], ["140000", `supabase/verify/${stem}.sql`], ["prior", `supabase/verify/${stem}.prior.sql`],
    ["130000", "supabase/verify/20261113130000_received_receipts.sql"], ["120000", "supabase/verify/20261113120000_consent_waiting_storage.sql"],
    ["rolled-back", `supabase/verify/${stem}.rolled-back.sql`],
  ];
  const stateRows = [];
  const states = async (point, expected) => {
    const got = {};
    for (const [label, name] of stateFiles) got[label] = await verdictOf("postgres", name).catch(() => "ERROR");
    stateRows.push(`${point} | ${stateFiles.map(([label]) => got[label]).join(" | ")}`);
    assert.deepEqual(got, expected, `A27-3 verify states at "${point}"`);
  };
  const applied = { before: "FAILED", 140000: "OK", prior: "OK", 130000: "FAILED", 120000: "FAILED", "rolled-back": "FAILED" };
  const rolledBack = { before: "OK", 140000: "ERROR", prior: "FAILED", 130000: "OK", 120000: "OK", "rolled-back": "OK" };
  const storeSig = "public.store_mail_run_without_sample_fence(uuid,uuid,uuid,jsonb,timestamptz,jsonb)";

  // The one scenario that the negative control must break.
  const reappears = async () => {
    for (const withHeader of [true, false]) {
      const user = await newUser();
      const provider = `synthetic:redelivery:${withHeader}`;
      const headers = withHeader ? { "x-otodoke-delivery-created-at": new Date(Date.now() - 1000).toISOString() } : {};
      assert.equal(await store(user, { provider, message: `<m-${withHeader}@example.test>`, headers }), "ok");
      await processAll(user);
      await clear(user);
      assert.equal(await mails(user), 0);
      assert.equal(await store(user, { provider, message: `<other-${withHeader}@example.test>`, headers }), "duplicate", "same provider ID after clear must be a duplicate");
      assert.equal(await mails(user), 0, "nothing may be stored for a cleared delivery");
    }
  };
  // A27-2: P read and cleared; the person forwards the same mail again (F, after the clear); F's read fails and its row stays.
  // The cleared P resent then must not take that row over. F's own resend still does.
  const keptRow = async () => {
    const user = await newUser();
    const P = "synthetic:kept:P", F = "synthetic:kept:F", mid = "<kept@example.test>";
    assert.equal(await store(user, { provider: P, message: mid }), "ok");
    await processAll(user);
    await clear(user);
    const after = { "x-otodoke-delivery-created-at": new Date(Date.now() + 60_000).toISOString() };
    const id = nextId();
    assert.equal(await store(user, { provider: F, message: mid, id, headers: after }), "ok", "the forward after the clear is stored");
    await sql(`update public.emails set processing_status='failed', error='synthetic read failure' where id=${quote(id)};`);
    const row = () => scalar(`select provider_email_id||'|'||processing_status||'|'||created_at::text||'|'||processing_run_id||'|'||md5(text_body) from public.emails where id=${quote(id)};`);
    const kept = await row();
    const createdAt = kept.split("|")[2];
    assert.equal(await store(user, { provider: P, message: mid, id, expected: createdAt, headers: { "x-otodoke-delivery-created-at": "2020-01-01T00:00:00Z" }, columns: { text_body: "Cleared body" } }),
      "duplicate", "a cleared provider ID must not take over a row kept after the clear");
    assert.equal(await row(), kept, "the kept row is unchanged (provider, state, version, run, body)");
    assert.equal(await mails(user), 1);
    assert.equal(await store(user, { provider: F, message: mid, id, expected: createdAt, headers: after }), "ok", "the kept row's own resend still takes it over");
  };

  try {
    assert.match(await command("initdb", ["--version"]), /PostgreSQL\) 17\./);
    await command("initdb", ["-D", data, "-U", "postgres", "--no-sync", "-c", "dynamic_shared_memory_type=mmap", "-c", "shared_memory_type=mmap"]);
    attempted = true;
    await command("pg_ctl", ["-D", data, "-l", path.join(scratch, "server.log"), "-t", "10", "-o",
      `-h 127.0.0.1 -p ${port} -c unix_socket_directories= -c dynamic_shared_memory_type=mmap -c shared_memory_type=mmap -c deadlock_timeout=100ms -c max_connections=50`, "start"], { timeout: 20_000 });
    await fileOn("postgres", "tests/postgres/bootstrap.sql");
    if (options.defaultPrivileges) {
      // Supabase gives the migration role default privileges on everything it creates in public. Reproduce that before any migration runs.
      const role = (await scalar("select current_user;")).replaceAll('"', '""');
      await sql(`alter default privileges for role "${role}" in schema public grant all on tables to anon, authenticated, service_role;
        alter default privileges for role "${role}" in schema public grant execute on functions to anon, authenticated, service_role;
        alter default privileges for role "${role}" in schema public grant all on sequences to anon, authenticated, service_role;
        grant usage on schema public to anon, authenticated, service_role;`);
      console.log(`OK: Supabase default privileges set for role ${role} (tables all, functions execute, sequences all, schema usage)`);
    }
    await sql("create schema supabase_migrations; create table supabase_migrations.schema_migrations(version text primary key,name text,statements text[]);");
    for (const name of priorMigrations(await readdir(path.join(root, "supabase/migrations")))) {
      if (name === "20261106180000_screen_events_daily_purge.sql") {
        const source = await readFile(path.join(root, "supabase/migrations", name), "utf8");
        await sql(source.slice(source.indexOf("create or replace function public.is_shared_mail_domain"), source.indexOf("select cron.schedule")));
        await sql("create schema cron; create table cron.job(jobname text,command text,schedule text,active boolean); insert into cron.job values('otodoke-purge-old-screen-events','select public.purge_old_screen_events()','30 18 * * *',true);");
      } else { await fileOn("postgres", `supabase/migrations/${name}`); await record(name); }
      if (options.cliPush && name === "20261106180000_screen_events_daily_purge.sql") await record(name); // the CLI must see every earlier version as applied
    }
    await sql("grant usage on schema public to authenticated,service_role; grant select,insert,update,delete on public.parcels to authenticated,service_role;");
    const users = [];
    for (let i = 0; i < 4; i += 1) users.push(await newUser());
    const [alice, bob] = users;

    if (options.cliPush) {
      const priorCount = priorMigrations(await readdir(path.join(root, "supabase/migrations"))).length;
      assert.equal(await historyRows("postgres"), priorCount, "history must hold every version before 140000");
      assert.equal(await historyRows("postgres", "20261113140000"), 0);
      await sql("create database cli_neg template postgres;");
      const push = (db, dry) => cli(["db", "push", "--db-url", dbUrl(db), "--skip-vault", ...(dry ? ["--dry-run"] : [])]);
      const summary = (r) => `exit=${r.code} listed=${JSON.stringify(listedMigrations(r.out))}`;
      const pushAndVerify = async (label) => {
        const dry = await push("postgres", true);
        console.log(`INFO: ${label} dry-run ${summary(dry)}`);
        assert.equal(dry.code, 0, dry.out);
        assert.deepEqual(listedMigrations(dry.out), [`${stem}.sql`], "dry-run must list exactly 140000");
        assert.equal(await historyRows("postgres", "20261113140000"), 0, "dry-run must not write history");
        const real = await push("postgres", false);
        console.log(`INFO: ${label} push exit=${real.code} applying=${JSON.stringify([...real.out.matchAll(/Applying migration (\S+?)\.\.\./g)].map((m) => m[1]))}`);
        assert.equal(real.code, 0, real.out);
        assert.match(real.out, /Applying migration 20261113140000_cleared_mail_marks\.sql\.\.\./);
        assert.equal(await historyRows("postgres"), priorCount + 1, "history gains exactly one row");
        assert.equal(await historyRows("postgres", "20261113140000"), 1);
        await verify(`supabase/verify/${stem}.sql`);
        await verify(`supabase/verify/${stem}.prior.sql`, false);
        console.log(`OK: cli ${label}: db push applied 140000 under the real CLI (gate passed), history ${priorCount} -> ${priorCount + 1}, verify and prior verify OK`);
      };
      const downAndRepair = async (label) => {
        await fileOn("postgres", `supabase/rollback/${stem}.down.sql`);
        const repaired = await cli(["migration", "repair", "--db-url", dbUrl("postgres"), "--status", "reverted", "20261113140000"]);
        console.log(`INFO: ${label} repair exit=${repaired.code}`);
        assert.equal(repaired.code, 0, repaired.out);
        assert.equal(await historyRows("postgres", "20261113140000"), 0, "repair removes the 140000 row");
        assert.equal(await historyRows("postgres"), priorCount);
        await verify("supabase/verify/20261113130000_received_receipts.sql", false);
        await verify("supabase/verify/20261113120000_consent_waiting_storage.sql", false);
        console.log(`OK: cli ${label}: down + migration repair --status reverted, row gone, 130000 and 120000 verify OK`);
      };
      await pushAndVerify("first");
      await downAndRepair("first");
      await pushAndVerify("second");
      await downAndRepair("second");
      // Negative controls on a copy that has every earlier version in history.
      const a = await push("cli_neg", true);
      assert.deepEqual(listedMigrations(a.out), [`${stem}.sql`]);
      await psqlOn("cli_neg", "insert into supabase_migrations.schema_migrations(version,name) values('20261113140000','cleared_mail_marks');");
      const hand = await push("cli_neg", true);
      const handReal = await push("cli_neg", false);
      console.log(`INFO: negative 1 (row inserted by hand) dry-run ${summary(hand)}; push exit=${handReal.code}`);
      assert.equal(hand.code, 0, hand.out);
      assert.deepEqual(listedMigrations(hand.out), [], "with the row present the CLI must not list 140000");
      assert.equal(handReal.code, 0, handReal.out);
      assert.equal((await psqlOn("cli_neg", "select count(*) from pg_class where oid=to_regclass('public.cleared_mail_marks');")).trim(), "0", "nothing was applied");
      await psqlOn("cli_neg", "delete from supabase_migrations.schema_migrations where version='20261113140000';");
      await fileOn("cli_neg", `supabase/migrations/${stem}.sql`); // table exists, history row does not
      const rows0 = await historyRows("cli_neg");
      const gated = await push("cli_neg", false);
      console.log(`INFO: negative 2 (table without history row) push exit=${gated.code} sqlstate55000=${/55000/.test(gated.out)} history ${rows0} -> ${await historyRows("cli_neg")}`);
      assert.notEqual(gated.code, 0, "the opening gate must stop the push");
      assert.match(gated.out, /55000/);
      assert.equal(await historyRows("cli_neg"), rows0, "a failed push must not add a history row");
      assert.equal(await historyRows("cli_neg", "20261113140000"), 0);
      console.log("OK: cli negative controls: a hand-made history row hides 140000 from the CLI; a table without a row stops the push at the opening gate (55000) and adds no row");
    }

    // Role M is a member of the application owner (postgres) with just enough rights that, without the gate, the SQL would run.
    await sql("create role owner_member login; grant postgres to owner_member; grant create on schema public to owner_member;");
    await sql("create database own_up template postgres; create database own_up2 template postgres; create database pre_cfg template postgres; create database pre_arg template postgres;");

    // 1. before -> OK, apply, verify -> OK
    await verify(`supabase/verify/${stem}.before.sql`);
    const fingerprintBefore = await fingerprint();
    const aclBefore = options.defaultPrivileges ? await aclReport() : [];
    await fileOn("postgres", `supabase/migrations/${stem}.sql`);
    await record(`${stem}.sql`);
    await verify(`supabase/verify/${stem}.sql`);
    await verify(`supabase/verify/${stem}.prior.sql`, false);
    await states("right after applying 140000", applied);
    await assert.rejects(fileOn("postgres", `supabase/migrations/${stem}.sql`), /require|already exists/, "a second application must stop");
    console.log("OK: 1 before -> OK, migration applied, verify -> OK, prior verify -> OK, second application refused");
    await sql(`create database post_grantopt template postgres; create database post_cfg template postgres;
      ${[0, 1, 2, 3, 4, 5, 6].map((i) => `create database post_reset_${i} template postgres;`).join(" ")}`);

    // 1b. owner gate negative control: M (a member of the owner, not the owner itself) applies 140000 as M -> 55000, nothing changes.
    {
      const migration = await readFile(path.join(root, `supabase/migrations/${stem}.sql`), "utf8");
      const before = await fingerprint("own_up");
      await assert.rejects(asRole("own_up", "owner_member", ["-f", path.join(root, `supabase/migrations/${stem}.sql`)]), /55000[\s\S]*run as the application owner/);
      assert.equal(await fingerprint("own_up"), before, "a refused migration changes nothing");
      assert.equal((await psqlOn("own_up", "select count(*) from pg_class where oid=to_regclass('public.cleared_mail_marks');")).trim(), "0");
      // Sharpness: with the gate block cut out, the same role applies the same file, so only the gate stops it.
      await command("psql", [...base("own_up2").map((a, i, all) => (all[i - 1] === "-U" ? "owner_member" : a)), "-P", "footer=off"], { input: stripOwnerGate(migration), timeout: 60_000 });
      assert.equal((await psqlOn("own_up2", "select count(*) from pg_class where oid=to_regclass('public.cleared_mail_marks');")).trim(), "1", "without the gate M applies it");
      console.log("OK: 1b owner gate: a member role M applying as M stops with 55000 and changes nothing; with the gate cut out M applies it (the gate is the only stopper)");
    }

    // 1d. A-42 R1-R3: verify, the migration gate and the rollback gate agree on settings, grant options and leftover names.
    {
      const up = `supabase/migrations/${stem}.sql`, down = `supabase/rollback/${stem}.down.sql`;
      const refused = async (db, name, re, label) => {
        const before = await fingerprint(db);
        await assert.rejects(fileOn(db, name), re, `${label}: ${name} must stop`);
        assert.equal(await fingerprint(db), before, `${label}: a refused ${name} changes nothing`);
      };
      // Before applying: a later ALTER of a replaced function, and a new name taken with other arguments.
      await psqlOn("pre_cfg", `alter function ${storeSig} set statement_timeout='5s';`);
      assert.equal(await verdictOf("pre_cfg", `supabase/verify/${stem}.before.sql`), "FAILED", "R3a: before must fail on a changed setting");
      await refused("pre_cfg", up, /unchanged \(bodies and settings\)/, "R3a");
      await psqlOn("pre_arg", "create function public.cleared_mail_mark_clock_margin(text) returns interval language sql immutable set search_path='' as $$ select interval '1 second' $$; revoke all on function public.cleared_mail_mark_clock_margin(text) from public,anon,authenticated,service_role;");
      assert.equal(await verdictOf("pre_arg", `supabase/verify/${stem}.before.sql`), "FAILED", "R3b: before must fail on a new name with other arguments");
      await refused("pre_arg", up, /unchanged \(bodies and settings\)/, "R3b");
      // After applying: RESET search_path on each of the 7 functions one at a time.
      const seven = ["public.cleared_mail_mark_retention()", "public.cleared_mail_mark_clock_margin()", "public.purge_expired_cleared_mail_marks()",
        "public.purge_old_screen_events()", "public.purge_old_screen_events_before_cleared_mail_marks()", "public.clear_all_parcels(uuid)", storeSig];
      const kept = new Set([storeSig, "public.clear_all_parcels(uuid)", "public.purge_old_screen_events()", "public.purge_expired_cleared_mail_marks()", "public.purge_old_screen_events_before_cleared_mail_marks()"]);
      for (const [i, sig] of seven.entries()) {
        await psqlOn(`post_reset_${i}`, `alter function ${sig} reset search_path;`);
        assert.equal(await verdictOf(`post_reset_${i}`, `supabase/verify/${stem}.sql`), "FAILED", `R1: verify must fail with ${sig} RESET search_path`);
        if (kept.has(sig)) await refused(`post_reset_${i}`, down, /altered the settings/, `R1/R3a ${sig}`);
      }
      // A grant option on an allowed grantee: verify fails, and so does the rollback gate (never "verify OK, rollback stuck").
      await psqlOn("post_grantopt", "grant execute on function public.clear_all_parcels(uuid) to service_role with grant option;");
      assert.equal(await verdictOf("post_grantopt", `supabase/verify/${stem}.sql`), "FAILED", "R2: verify must fail on a grant option");
      await refused("post_grantopt", down, /keep their owner and ACL/, "R2");
      // A later ALTER after applying: verify fails and the rollback stops instead of dropping the setting.
      await psqlOn("post_cfg", `alter function ${storeSig} set statement_timeout='5s';`);
      assert.equal(await verdictOf("post_cfg", `supabase/verify/${stem}.sql`), "FAILED", "R3a: verify must fail on a changed setting");
      await refused("post_cfg", down, /altered the settings/, "R3a after");
      console.log("OK: 1d before/up stop on a changed setting and on clock_margin(text); verify FAILED for RESET search_path on each of 7 functions (rollback stops for the 5 it keeps or replaces), for a grant option (rollback stops too) and for a later ALTER (rollback stops)");
    }

    if (negative) {
      // Mutants inside this disposable database only; each must be caught by its own scenario.
      const storeOf = (source) => extract(source, /create or replace function public\.store_mail_run_without_sample_fence\([\s\S]*?\nend \$\$;/);
      const old = storeOf(await readFile(path.join(root, "supabase/migrations/20261113120000_consent_waiting_storage.sql"), "utf8"));
      const current = storeOf(await readFile(path.join(root, `supabase/migrations/${stem}.sql`), "utf8"));
      const hoisted = "  if coalesce(p_columns->>'provider_email_id','') not like 'demo:%' and p_columns->>'provider_email_id' is not null\n    and exists(select 1 from public.cleared_mail_marks m";
      assert.equal(current.split(hoisted).length, 2, "the provider-ID mark check is where this control expects it");
      const newRowOnly = current.replace(hoisted, () => hoisted.replace("  if coalesce(", "  if not v_exists and coalesce("));
      const results = [];
      const expectRed = async (label, body, scenario, mustPass) => {
        await sql(body);
        if (mustPass) await mustPass();
        const caught = await scenario().then(() => null, (e) => e);
        results.push(caught ? `DETECTED ${label}: ${caught.message.split("\n")[0]} (${caught.actual} !== ${caught.expected})` : `MISSED ${label}`);
      };
      await expectRed("120000 body (no mark check), scenario 2", old, reappears);
      // Before A27-2: the provider-ID check only for a new row. Scenario 2 still passes; scenario 2b must catch it.
      await expectRed("provider-ID check for a new row only, scenario 2b", newRowOnly, keptRow, reappears);
      for (const line of results) console.log(`NEGATIVE: ${line}`);
      return results.every((l) => l.startsWith("DETECTED")) ? "all-detected" : "missed";
    }

    // 2. red reproduction and fix, with and without the delivery header
    await reappears();
    console.log("OK: 2 same provider ID after a clear is 'duplicate' with 0 rows, with and without the delivery header");
    await keptRow();
    console.log("OK: 2b a cleared provider ID meeting a failed row kept after the clear is 'duplicate' and leaves the row unchanged; the row's own resend takes it over");

    // 3. Message-ID marks and the delivery time
    const timeCases = [
      ["a an hour before the clear", (t) => ({ "x-otodoke-delivery-created-at": new Date(t - 3_600_000).toISOString() }), "duplicate"],
      ["b 60 seconds before (inside the margin)", (t) => ({ "x-otodoke-delivery-created-at": new Date(t - 60_000).toISOString() }), "ok"],
      ["c after the clear", (t) => ({ "x-otodoke-delivery-created-at": new Date(t + 10_000).toISOString() }), "ok"],
      ["d header absent", () => ({}), "ok"],
      ["e garbage text", () => ({ "x-otodoke-delivery-created-at": "not a time" }), "ok"],
      ["e2 well-formed but impossible", () => ({ "x-otodoke-delivery-created-at": "2026-13-45T99:00:00Z" }), "ok"],
      ["e3 date only", () => ({ "x-otodoke-delivery-created-at": "2026-11-12" }), "ok"],
      ["e4 empty", () => ({ "x-otodoke-delivery-created-at": "" }), "ok"],
      ["a2 offset form an hour before", (t) => ({ "x-otodoke-delivery-created-at": new Date(t - 3_600_000).toISOString().replace("Z", "+00:00") }), "duplicate"],
    ];
    for (const [label, headers, expected] of timeCases) {
      const user = await newUser();
      const at = await seedAndClear(user, `synthetic:p:${label}`, `<mid-${label.replaceAll(" ", "")}@example.test>`);
      const verdict = await store(user, { provider: `synthetic:fresh:${label}`, message: `<mid-${label.replaceAll(" ", "")}@example.test>`, headers: headers(at) });
      assert.equal(verdict, expected, `case ${label}`);
      assert.equal(await mails(user), expected === "ok" ? 1 : 0, `case ${label} rows`);
    }
    {
      const user = await newUser();
      const at = await seedAndClear(user, "synthetic:p:unset", "<unset@example.test>");
      assert.equal(await store(user, { provider: "synthetic:fresh:unset", message: "<unset@example.test>", noHeaders: true }), "ok");
      void at;
    }
    console.log("OK: 3 Message-ID mark: an hour before=duplicate, 60s before=ok, after=ok, absent/garbage/impossible/empty/unset=ok (no exception)");

    // 4. inputs that must pass; marks are per user; samples are never marked
    {
      const user = await newUser();
      await seedAndClear(user, "synthetic:old-4", "<old-4@example.test>");
      assert.equal(await store(user, { provider: "synthetic:new-4", message: "<new-4@example.test>" }), "ok");
      assert.equal(await store(user, { provider: "synthetic:nomid-4", message: null }), "ok");
      assert.equal(await store(user, { provider: "synthetic:nomid-5" }), "ok");
      const other = await newUser();
      assert.equal(await store(other, { provider: "synthetic:old-4", message: "<old-4@example.test>", headers: { "x-otodoke-delivery-created-at": "2020-01-01T00:00:00Z" } }), "ok", "marks belong to one user");
      const sampleUser = await newUser();
      const generation = async () => taggedResults(await sql(`begin; set local role service_role; select 'RESULT:'||public.begin_sample_load(${quote(sampleUser)}); commit;`))[0];
      const sampleHeaders = (g) => ({ "x-otodoke-sample-generation": g, "x-otodoke-sample-user": sampleUser });
      assert.equal(await store(sampleUser, { provider: "demo:synthetic-1", message: "<demo-1@example.test>", headers: sampleHeaders(await generation()) }), "ok");
      await processAll(sampleUser);
      await clear(sampleUser);
      assert.equal(await marks(sampleUser), 0, "sample rows never become marks");
      assert.equal(await store(sampleUser, { provider: "demo:synthetic-1", message: "<demo-1@example.test>", headers: sampleHeaders(await generation()) }), "ok", "sample reload after a clear");
    }
    console.log("OK: 4 new IDs, null Message-ID, other user, and sample reload all pass; samples leave no marks");

    // 5. expiry and the existing daily purge
    {
      const user = await newUser();
      await seedAndClear(user, "synthetic:exp-5", "<exp-5@example.test>");
      assert.equal(await marks(user), 2);
      await sql(`update public.cleared_mail_marks set expires_at=clock_timestamp()-interval '1 second' where user_id=${quote(user)} and kind='provider_email_id';`);
      assert.equal(await store(user, { provider: "synthetic:exp-5", message: "<exp-other-5@example.test>" }), "ok", "an expired mark no longer stops delivery");
      await sql(`update public.cleared_mail_marks set expires_at=clock_timestamp()-interval '1 second' where user_id=${quote(user)};`);
      // Baseline for the other sweep: one expired consent-waiting mail must give 1 with and without marks.
      const waiting = (n) => `insert into public.emails(id,user_id,processing_status,text_body,received_at) values(${quote(uuid(7000 + n))},${quote(user)},'failed','Legacy synthetic',now()-interval '20 days');`;
      await sql(waiting(1));
      const withMarks = Number(await scalar("select public.purge_old_screen_events();"));
      assert.equal(withMarks, 1 + 2, "expired marks add their count to the existing sweep result");
      assert.equal(await marks(user), 0);
      const fresh = await newUser();
      await seedAndClear(fresh, "synthetic:fresh-5", "<fresh-5@example.test>");
      await sql(waiting(2).replaceAll(quote(user), quote(fresh)));
      assert.equal(Number(await scalar("select public.purge_old_screen_events();")), 1, "fresh marks are kept and the other sweep result is unchanged");
      assert.equal(await marks(fresh), 2);
      assert.equal(Number(await scalar(`select count(*) from public.emails where id='${uuid(7002)}';`)), 0);
    }
    console.log("OK: 5 expired mark lets the delivery pass; the daily purge removes only expired marks and keeps the other result");

    // 6. a second clear extends the mark
    {
      const user = await newUser();
      await seedAndClear(user, "synthetic:ext-6", "<ext-6@example.test>");
      const read = async () => (await scalar(`select extract(epoch from marked_at)*1000||'|'||extract(epoch from expires_at)*1000||'|'||count(*) over () from public.cleared_mail_marks where user_id=${quote(user)} and kind='provider_email_id';`)).split("|").map(Number);
      const [m1, e1, n1] = await read();
      assert.ok(Math.abs(e1 - m1 - 35 * 86_400_000) < 1, "expiry is marked_at + 35 days");
      await delay(30);
      await sql(`insert into public.emails(id,user_id,provider_email_id,processing_status,text_body) values(${quote(nextId())},${quote(user)},'synthetic:ext-6','pending','Again');`);
      await clear(user);
      const [m2, e2, n2] = await read();
      assert.ok(m2 > m1 && e2 > e1, "second clear moves marked_at and expires_at forward");
      assert.equal(n1, n2, "no second row");
    }
    console.log("OK: 6 second clear extends marked_at and expires_at (35 days) on the same key");

    // 7. account deletion and concurrent clear
    {
      const user = await newUser();
      await seedAndClear(user, "synthetic:del-7", "<del-7@example.test>");
      assert.equal(await marks(user), 2);
      await sql(`delete from auth.users where id=${quote(user)};`);
      assert.equal(await marks(user), 0, "deleting the account removes its marks");
    }
    for (let round = 0; round < 12; round += 1) {
      const user = await newUser();
      assert.equal(await store(user, { provider: `synthetic:race7:${round}`, message: `<race7-${round}@example.test>` }), "ok");
      await processAll(user);
      const clearing = sql(`begin; set local role service_role; select public.clear_all_parcels(${quote(user)}); select pg_sleep(0.25); commit;`);
      const deleting = (async () => { await delay(60 + (round % 4) * 40); return sql(`delete from auth.users where id=${quote(user)};`); })();
      await Promise.all([clearing, deleting]);
      assert.equal(await marks(user), 0);
      assert.equal(await scalar(`select count(*) from auth.users where id=${quote(user)};`), "0");
    }
    console.log("OK: 7 account deletion removes marks; 12 concurrent clear + account deletion rounds: no FK violation or deadlock");

    // 8. clear vs. a store of an already-read delivery, both orders
    for (let round = 0; round < 40; round += 1) {
      const user = await newUser();
      const provider = `synthetic:race8:${round}`;
      assert.equal(await store(user, { provider, message: `<race8-${round}@example.test>` }), "ok");
      await processAll(user);
      const clearing = sql(`begin; set local role service_role; select public.clear_all_parcels(${quote(user)}); select pg_sleep(${round % 4 === 0 ? 0.2 : 0}); commit;`);
      const storing = (async () => { await delay((round % 5) * 25); return store(user, { provider, message: `<race8b-${round}@example.test>`, headers: { "x-otodoke-delivery-created-at": new Date(Date.now() - 5000).toISOString() } }); })();
      const [, verdict] = await Promise.all([clearing, storing]);
      assert.equal(verdict, "duplicate", `round ${round}`);
      assert.equal(await mails(user), 0, `round ${round}: nothing rebuilt`);
    }
    console.log("OK: 8 40 rounds of clear racing a redelivery: always duplicate, never rebuilt");

    // 8b. A27-1: a clear that refreshes expired marks, racing the daily purge that removes them.
    {
      const held = async (key) => Number(await scalar(`select count(*) from pg_locks where locktype='advisory' and objid=${key} and granted;`));
      const waitHeld = async (key) => { for (let i = 0; i < 100 && (await held(key)) === 0; i += 1) await delay(20); assert.equal(await held(key), 1, `advisory ${key} not taken`); };
      const N = 150, rounds = 40, gateKey = 4242;
      let deadlocks = 0;
      const others = [];
      for (let round = 0; round < rounds; round += 1) {
        const user = await newUser();
        await sql(`insert into public.emails(id,user_id,provider_email_id,message_id,processing_status,text_body) select gen_random_uuid(),${quote(user)},'synthetic:dl:${round}:'||i,'<dl-${round}-'||i||'@example.test>','processed','Synthetic' from generate_series(1,${N}) i;`);
        // Expired marks of the same keys, written in a random physical order (as marks of earlier clears end up), so the
        // purge meets them in an order unrelated to the clear's. The clear refreshes the very marks the purge is about to remove.
        await sql(`insert into public.cleared_mail_marks(user_id,kind,digest,reason,marked_at,expires_at)
          select ${quote(user)},k.kind,pg_catalog.sha256(convert_to(${quote(user)}||chr(10)||k.kind||chr(10)||k.v,'UTF8')),'clear_all',clock_timestamp()-interval '40 days',clock_timestamp()-interval '1 second'
          from (select 'provider_email_id' as kind,'synthetic:dl:${round}:'||i as v from generate_series(1,${N}) i
            union all select 'message_id','<dl-${round}-'||i||'@example.test>' from generate_series(1,${N}) i) k order by random();`);
        const gate = sql(`select pg_advisory_lock(${gateKey}); select pg_sleep(0.4); select pg_advisory_unlock(${gateKey});`);
        await waitHeld(gateKey);
        const caught = (p) => p.then(() => null, (e) => e);
        const clearing = caught(sql(`begin; set local role service_role; select pg_advisory_xact_lock_shared(${gateKey}); select public.clear_all_parcels(${quote(user)}); commit;`));
        const purging = caught(sql(`begin; select pg_advisory_xact_lock_shared(${gateKey}); select pg_sleep(${(round % 5) * 0.002}); select public.purge_old_screen_events(); commit;`));
        const errors = (await Promise.all([clearing, purging])).filter(Boolean);
        await gate;
        for (const e of errors) if (/deadlock detected/i.test(e.message)) deadlocks += 1; else others.push(String(e.message).split("\n")[0]);
        if (errors.length === 0) {
          assert.equal(await mails(user), 0, `8b round ${round}: the clear removed the mail`);
          assert.equal(Number(await scalar(`select count(*) from public.cleared_mail_marks where user_id=${quote(user)} and expires_at>clock_timestamp();`)), 2 * N, `8b round ${round}: every key is marked and live after the clear`);
        }
      }
      console.log(`INFO: 8b ${rounds} rounds of clear (refreshing ${2 * N} expired marks) racing the daily purge: deadlocks=${deadlocks} other errors=${others.length}`);
      // A mark row locked by someone else is skipped, not waited for, and goes with the next purge.
      const user = await newUser();
      await sql(`insert into public.cleared_mail_marks(user_id,kind,digest,reason,marked_at,expires_at) select ${quote(user)},'message_id',pg_catalog.sha256(convert_to('locked-'||i,'UTF8')),'clear_all',clock_timestamp()-interval '40 days',clock_timestamp()-interval '5 days' from generate_series(1,3) i;`);
      const lockKey = 4343;
      const holder = sql(`begin; select count(*) from (select 1 from public.cleared_mail_marks where user_id=${quote(user)} for update) s; select pg_advisory_lock(${lockKey}); select pg_sleep(1.2); select pg_advisory_unlock(${lockKey}); commit;`).then(() => null, (e) => e);
      await waitHeld(lockKey);
      const skipped = await sql("set statement_timeout='800ms'; select public.purge_old_screen_events();").then(() => "returned", (e) => `failed: ${String(e.message).split("\n")[0]}`);
      const holderError = await holder;
      console.log(`INFO: 8b the purge while another transaction holds 3 expired mark rows -> ${skipped}`);
      assert.deepEqual(others, [], "8b: no other error");
      assert.equal(deadlocks, 0, "8b: clear and the daily purge must not deadlock");
      assert.equal(skipped, "returned", "8b: the purge must not wait for a mark row another transaction holds");
      assert.equal(holderError, null, "8b: the lock holder finished");
      assert.equal(await marks(user), 3, "8b: the locked expired marks were skipped this time");
      await sql("select public.purge_old_screen_events();");
      assert.equal(await marks(user), 0, "8b: the next purge removes the marks it skipped");
      assert.equal(Number(await scalar("select count(*) from public.cleared_mail_marks where expires_at<=clock_timestamp();")), 0, "8b: no expired mark is left after the next purge");
      // One run removes at most 10000; the next run takes the rest.
      const bulk = await newUser();
      await sql(`insert into public.cleared_mail_marks(user_id,kind,digest,reason,marked_at,expires_at) select ${quote(bulk)},'message_id',pg_catalog.sha256(convert_to('bulk-'||i,'UTF8')),'clear_all',clock_timestamp()-interval '40 days',clock_timestamp()-interval '5 days' from generate_series(1,10005) i;`);
      const first = Number(await scalar("select public.purge_expired_cleared_mail_marks();"));
      const second = Number(await scalar("select public.purge_expired_cleared_mail_marks();"));
      assert.deepEqual([first, second, await marks(bulk)], [10000, 5, 0], "8b: at most 10000 per run, the rest on the next run");
      console.log("OK: 8b no deadlock between clear and the daily purge; a locked expired mark is skipped without waiting and removed by the next purge; none left expired; 10000 per run at most (10005 -> 10000 + 5)");
    }

    // 9. privileges
    for (const role of ["anon", "authenticated"]) {
      await denied(`set role ${role}; select count(*) from public.cleared_mail_marks;`);
      await denied(`set role ${role}; select * from public.store_mail_run(${quote(alice)},${quote(nextId())},${quote(nextId())},'{}'::jsonb,null,${json(limits)});`);
      await denied(`set role ${role}; select public.clear_all_parcels(${quote(alice)});`);
      await denied(`set role ${role}; select public.purge_expired_cleared_mail_marks();`);
    }
    await denied("set role service_role; select count(*) from public.cleared_mail_marks;");
    await denied("set role service_role; delete from public.cleared_mail_marks;");
    await denied("set role service_role; select public.purge_expired_cleared_mail_marks();");
    await denied("set role service_role; select public.cleared_mail_mark_retention();");
    assert.equal(await store(bob, { provider: "synthetic:acl-9" }), "ok");
    await clear(bob);
    console.log("OK: 9 anon/authenticated cannot read the table or call the entries; service_role keeps store_mail_run and clear_all_parcels only");

    await verify(`supabase/verify/${stem}.sql`);

    // 10. rollback, exact fingerprints, old-app compatibility, reapply
    const rollback = () => fileOn("postgres", `supabase/rollback/${stem}.down.sql`);
    const downAndUnrecord = async () => { await rollback(); await unrecord("20261113140000"); };
    {
      assert.equal(await verdictOf("postgres", `supabase/verify/${stem}.rolled-back.sql`), "FAILED", "rolled-back verify must fail while 140000 is applied");
      await sql("create database own_dn template postgres; create database own_dn2 template postgres;");
      const down = await readFile(path.join(root, `supabase/rollback/${stem}.down.sql`), "utf8");
      const before = await fingerprint("own_dn");
      await assert.rejects(asRole("own_dn", "owner_member", ["-f", path.join(root, `supabase/rollback/${stem}.down.sql`)]), /55000[\s\S]*run as the application owner/);
      assert.equal(await fingerprint("own_dn"), before, "a refused rollback changes nothing");
      await command("psql", [...base("own_dn2").map((a, i, all) => (all[i - 1] === "-U" ? "owner_member" : a))], { input: stripOwnerGate(down), timeout: 60_000 });
      assert.equal(await verdictOf("own_dn2", `supabase/verify/${stem}.rolled-back.sql`), "OK", "without the gate M rolls it back");
      console.log("OK: 1c rollback owner gate: M stops with 55000 and changes nothing; with the gate cut out M rolls back (rolled-back verify FAILED before, OK after)");
    }
    // Gate: a later change to a body stops the rollback and changes nothing.
    const fingerprintApplied = await fingerprint();
    await sql("alter function public.purge_old_screen_events() rename to purge_old_screen_events_tmp; create function public.purge_old_screen_events() returns integer language sql security definer set search_path='' as $$ select public.purge_old_screen_events_tmp()+0; $$; revoke all on function public.purge_old_screen_events() from public,anon,authenticated,service_role;");
    await assert.rejects(rollback(), /later change altered these bodies/);
    await sql("drop function public.purge_old_screen_events(); alter function public.purge_old_screen_events_tmp() rename to purge_old_screen_events;");
    assert.equal(await fingerprint(), fingerprintApplied, "gate test restored the applied state exactly");
    // 130000 rolled back first leaves the 140000 gate closed too (checked on a copy below); here: the real rollback.
    await downAndUnrecord();
    assert.equal(await fingerprint(), fingerprintBefore, "after the rollback every public function body/ACL/config and relation equals the state before 140000");
    await verify(`supabase/verify/${stem}.rolled-back.sql`);
    await verify("supabase/verify/20261113130000_received_receipts.sql", false);
    await verify("supabase/verify/20261113120000_consent_waiting_storage.sql", false);
    await states("right after the 140000 rollback", rolledBack);
    assert.equal(await scalar("select count(*) from pg_class where oid=to_regclass('public.cleared_mail_marks');"), "0");
    for (const [i, o] of [{ headers: {} }, { noHeaders: true }, { headers: { "x-otodoke-delivery-created-at": "2020-01-01T00:00:00Z" } }].entries()) {
      const user = await newUser();
      assert.equal(await store(user, { provider: `synthetic:after-down:${i}`, message: `<ad-${i}@example.test>`, ...o }), "ok", "old behavior after rollback");
      await processAll(user);
      await clear(user);
      assert.equal(await store(user, { provider: `synthetic:after-down:${i}`, message: `<ad-${i}@example.test>`, ...o }), "ok", "without the marks a redelivery is stored again (the old behavior)");
    }
    await fileOn("postgres", `supabase/migrations/${stem}.sql`);
    await record(`${stem}.sql`);
    await verify(`supabase/verify/${stem}.sql`);
    await verify(`supabase/verify/${stem}.prior.sql`, false);
    await states("right after re-applying 140000", applied);
    console.log(`INFO: A27-3 verify states (point | ${stateFiles.map(([label]) => label).join(" | ")}):\n${stateRows.join("\n")}`);
    console.log("OK: 10 rollback restores identical function bodies/ACLs/settings, 130000 and 120000 verify OK, old behavior intact, re-apply + verify OK; A27-3 states as expected at the three points");

    if (options.defaultPrivileges) {
      // 11. ACLs under Supabase default privileges, and whether verify notices an extra grant
      const aclAfter = await aclReport();
      const isService = (l) => l.split("|")[1] === "service_role";
      console.log(`INFO: ACL anon/authenticated/PUBLIC/service_role entries on the 140000 objects after apply:\n${aclAfter.join("\n")}`);
      assert.deepEqual(aclAfter.filter((l) => /\|(anon|authenticated|PUBLIC)\|/.test(l)), [], "anon, authenticated and PUBLIC must hold nothing");
      const was = new Set(aclBefore.filter(isService));
      assert.deepEqual(aclAfter.filter(isService).filter((l) => !was.has(l)), [], "service_role must hold nothing it did not hold before 140000");
      const now = new Set(aclAfter.filter(isService));
      console.log(`INFO: service_role held before but not after: ${JSON.stringify(aclBefore.filter(isService).filter((l) => !now.has(l)))}`);
      console.log("OK: 11a ACLs under default privileges: anon/authenticated/PUBLIC hold nothing; service_role holds nothing new");
      const extras = [
        ["select on cleared_mail_marks to anon", "grant select on public.cleared_mail_marks to anon;"],
        ["execute purge_expired_cleared_mail_marks to authenticated", "grant execute on function public.purge_expired_cleared_mail_marks() to authenticated;"],
        ["execute store_mail_run_without_sample_fence to anon", "grant execute on function public.store_mail_run_without_sample_fence(uuid,uuid,uuid,jsonb,timestamptz,jsonb) to anon;"],
        ["execute purge_old_screen_events to authenticated", "grant execute on function public.purge_old_screen_events() to authenticated;"],
        ["execute cleared_mail_mark_retention to anon", "grant execute on function public.cleared_mail_mark_retention() to anon;"],
      ];
      for (const [i, [label, grant]] of extras.entries()) {
        await sql(`create database leak_${i} template postgres;`);
        await psqlOn(`leak_${i}`, grant);
        const output = await fileOn(`leak_${i}`, `supabase/verify/${stem}.sql`, ["-P", "footer=off"]);
        const rows = output.trim().split(/\r?\n/);
        const verdict = rows[1].split("|")[rows[0].split("|").indexOf("verdict")];
        const failing = rows[0].split("|").filter((n, k) => rows[1].split("|")[k] === "f");
        console.log(`OK: 11b extra grant (${label}) -> verify verdict ${verdict}${failing.length ? `, false: ${failing.join(",")}` : ""}`);
        assert.equal(verdict, "FAILED", `GAP: verify missed an extra grant (${label})`);
      }
    }

    // 10b. rollback chain on copies of the final database
    await sql("create database chain_a template postgres;");
    await sql("create database chain_b template postgres;");
    for (const name of downs) {
      await fileOn("chain_a", `supabase/rollback/${name}.down.sql`);
      console.log(`OK: 10b chain rollback ${name}`);
    }
    // 140000 still applied: the 130000 rollback must not be allowed to leave a half state.
    const outcome = await fileOn("chain_b", "supabase/rollback/20261113130000_received_receipts.down.sql").then(() => "RAN", (e) => `STOPPED: ${String(e.message).split("\n")[0].slice(0, 160)}`);
    console.log(`INFO: 130000 rollback while 140000 is still applied -> ${outcome}`);
    if (outcome === "RAN") {
      const stuck = await fileOn("chain_b", `supabase/rollback/${stem}.down.sql`).then(() => "RAN", (e) => `STOPPED: ${String(e.message).split("\n")[0].slice(0, 160)}`);
      console.log(`INFO: then the 140000 rollback on that copy -> ${stuck}`);
    }
    return "ok";
  } finally {
    try { if (attempted) await command("pg_ctl", ["-D", data, "-m", "immediate", "-t", "10", "stop"], { timeout: 20_000 }); } catch (e) { console.error(`stop: ${e.message}`); }
    await rm(scratch, { recursive: true, force: true });
    assert.equal(await listening(), false, "listener left behind");
    console.log("OK: cleanup: own cluster stopped, scratch deleted");
  }
}

const argv = process.argv.slice(2);
const unknown = argv.filter((a) => !["--self-test", "--negative-control", "--supabase-default-privileges", "--cli-push"].includes(a));
if (unknown.length) { console.error(`unknown arguments: ${unknown.join(" ")}`); console.log("verdict=FAILED"); process.exit(1); }
const mode = argv.find((a) => a === "--self-test" || a === "--negative-control");
const options = { defaultPrivileges: argv.includes("--supabase-default-privileges"), cliPush: argv.includes("--cli-push") };
if (mode === "--self-test") {
  try { await selfTest(); } catch (e) { console.error(e); console.log("verdict=FAILED"); process.exitCode = 1; }
} else {
  try {
    const result = await main(mode === "--negative-control", options);
    if (mode === "--negative-control") {
      // Expected: verdict=FAILED with negative-control=ALL-DETECTED. MISSED (or no such line) means a scenario lost its power.
      console.log(`negative-control=${result === "all-detected" ? "ALL-DETECTED" : "MISSED"}`);
      throw new Error(result === "all-detected" ? "negative control: every mutant was caught (the expected red)" : "negative control: a mutant was NOT caught");
    }
    console.log("verdict=OK");
  } catch (e) {
    console.error(String(e?.stack ?? e).split("\n").slice(0, 12).join("\n"));
    console.log("verdict=FAILED");
    process.exitCode = 1;
  }
}
