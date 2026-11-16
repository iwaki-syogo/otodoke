import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCommand } from "./run-cost-guards.mjs";

// 20261117120000_parcel_status_set_by_person: the time a person last changed a parcel's status, written by a
// trigger for the signed-in role only. A disposable PostgreSQL 17 cluster on 127.0.0.1:65478; no external service.
//
//   node tests/postgres/run-person-status.mjs --self-test        (no database)
//   node tests/postgres/run-person-status.mjs                    (the real behaviour; success = verdict=OK, exit 0)
//   node tests/postgres/run-person-status.mjs --negative-control (the trigger swapped for a `return old` version
//                                                                  must be CAUGHT; verdict=OK means it was caught)

const root = fileURLToPath(new URL("../../", import.meta.url));
const stem = "20261117120000_parcel_status_set_by_person";
const files = {
  before: `supabase/verify/${stem}.before.sql`,
  migration: `supabase/migrations/${stem}.sql`,
  verify: `supabase/verify/${stem}.sql`,
  down: `supabase/rollback/${stem}.down.sql`,
};
const port = 65478;
const bin = process.env.OTODOKE_PG_BINDIR ?? "";
const uuid = (number) => `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`;
const ME = uuid(1);
const OTHER = uuid(2);
const EMAIL = uuid(10);
const RUN = uuid(20);
const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;

/** The trigger a careless version would have: it stamps, then returns OLD, which discards the person's whole write. */
export const brokenTrigger = `create or replace function public.parcels_status_set_by_person() returns trigger language plpgsql set search_path = '' as $$
begin
  if current_user is distinct from 'authenticated' then return new; end if;
  if tg_op = 'INSERT' then return new; end if;
  if new.status is distinct from old.status then new.status_set_by_person_at := now(); end if;
  return old;
end $$;`;

export function cleanEnvironment(scratch, inherited = process.env) {
  const environment = Object.fromEntries(Object.entries(inherited).filter(([key]) => !key.startsWith("PG")));
  return { ...environment, LC_ALL: "C", LANG: "C", PGPASSFILE: path.join(scratch, "no-password-file"),
    PGSERVICEFILE: path.join(scratch, "no-service-file"), PGSYSCONFDIR: scratch, PGCONNECT_TIMEOUT: "3" };
}

/** A verify file answers ONE row: verdict first, then t/f checks and counts. Anything else is a failure. */
export function requireVerdict(output, label, columns, booleans = []) {
  assert.doesNotMatch(output, /\b(?:ERROR|FATAL|PANIC):/i, `${label}: SQL error in stdout`);
  const rows = output.trim().split(/\r?\n/);
  assert.equal(rows.length, 1, `${label}: expected exactly one result row`);
  const cells = rows[0].split("|");
  assert.equal(cells.length, columns, `${label}: expected ${columns} columns`);
  assert.equal(cells[0], "OK", `${label}: verdict must be OK`);
  for (const index of booleans) assert.equal(cells[index], "t", `${label}: column ${index + 1} must be true`);
  return cells;
}

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

/** What a request from the app looks like to PostgREST: the signed-in role, the person's uuid in the JWT claims. */
const asPerson = (user, body) => `begin; set local role authenticated; set local request.jwt.claim.sub=${quote(user)};
  set local request.jwt.claims=${quote(JSON.stringify({ sub: user, role: "authenticated" }))}; set local request.headers='{}'; ${body} commit;`;
const asService = (body) => `begin; set local role service_role; set local request.headers='{}'; ${body} commit;`;

function functionSource(sql, name) {
  const start = sql.indexOf(`create or replace function public.${name}(`);
  assert.ok(start >= 0, `${name} not found`);
  return sql.slice(start, sql.indexOf("end $$;", start) + "end $$;".length);
}

async function selfTest() {
  const migration = await readFile(path.join(root, files.migration), "utf8");
  const down = await readFile(path.join(root, files.down), "utf8");
  const original = await readFile(path.join(root, "supabase/migrations/20261113100000_parcel_write_conflicts.sql"), "utf8");
  const trigger = functionSource(migration, "parcels_status_set_by_person");
  assert.match(trigger, /return new;/);
  assert.doesNotMatch(trigger, /return old/i);
  assert.match(brokenTrigger, /return old;/);
  assert.match(trigger, /current_user is distinct from 'authenticated'/);
  // The gateway body is the 20261113100000 text (renamed as 20261113110000 left it) plus exactly one allowlist entry.
  const originalBody = functionSource(original, "mail_run_write").replace("public.mail_run_write(", "public.mail_run_write_without_sample_fence(");
  const newBody = functionSource(migration, "mail_run_write_without_sample_fence");
  assert.equal(newBody, originalBody.replace("'received_at'];", "'received_at','status_set_by_person_at'];"));
  assert.equal(functionSource(down, "mail_run_write_without_sample_fence"), originalBody, "the rollback must restore the original body to the character");
  assert.deepEqual(priorMigrations([`${stem}.sql`, "20261113140000_cleared_mail_marks.sql", "20261118000000_future.sql", "notes.md"]), ["20261113140000_cleared_mail_marks.sql"]);
  const environment = cleanEnvironment("local-scratch", { PGHOST: "remote.invalid", PGSERVICE: "remote", PGPASSFILE: "secret", KEEP: "yes" });
  assert.equal(environment.PGHOST, undefined);
  assert.equal(environment.PGSERVICE, undefined);
  assert.equal(environment.PGPASSFILE, path.join("local-scratch", "no-password-file"));
  assert.equal(environment.KEEP, "yes");
  assert.match(asPerson(ME, "select 1;"), /set local role authenticated/);
  assert.match(asPerson(ME, "select 1;"), /request\.jwt\.claims=/);
  assert.match(asService("select 1;"), /set local role service_role/);
  // The verify parser: one row, OK first, every check true.
  assert.deepEqual(requireVerdict("OK|t|t|t|t|0\n", "x", 6, [1, 2, 3, 4]), ["OK", "t", "t", "t", "t", "0"]);
  for (const bad of ["", "FAILED|t|t|t|t|0\n", "OK|t|f|t|t|0\n", "OK|t|t|t|t\n", "OK|t|t|t|t|0\nOK|t|t|t|t|0\n", "OK|t|t|t|t|0\nERROR: broken\n"]) {
    assert.throws(() => requireVerdict(bad, "x", 6, [1, 2, 3, 4]), `must reject ${JSON.stringify(bad)}`);
  }
  const dummy = (source, options = {}) => runCommand(process.execPath, ["-e", source], options);
  await dummy("process.stdout.write('OK\\n')");
  await assert.rejects(dummy("process.stderr.write('ERROR: synthetic\\n'); process.exit(0)"), /synthetic/);
  await assert.rejects(dummy("process.exit(1)"), /failed/);
  await assert.rejects(dummy("setTimeout(() => {}, 10000)", { timeout: 20 }), /SIGTERM/);
  console.log("OK: self-test (trigger returns NEW, gateway body = 20261113100000 + one entry, rollback restores it exactly, verify parser, role wrappers, child errors)");
  console.log("NOT RUN: PostgreSQL startup, migrations, SQL behaviour and the negative control");
}

async function main(negative) {
  assert.equal(await listening(), false, `port ${port} is occupied; no existing process was stopped`);
  const parent = path.join(root, ".vitest/pg");
  await mkdir(parent, { recursive: true });
  const scratch = await mkdtemp(path.join(parent, "person-status-"));
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
    const cells = requireVerdict(await command("psql", [...psqlArgs, "-f", path.join(root, name)]), name, columns, booleans);
    console.log(`OK: ${name} -> ${cells.join("|")}`);
  };
  const history = (name) => sql(`insert into supabase_migrations.schema_migrations(version,name) values(${quote(name.slice(0, 14))},${quote(name.slice(15, -4))}) on conflict(version) do nothing;`);

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

  // ---- fixtures -------------------------------------------------------------------------------------------
  let seq = 100;
  const T0 = "2026-11-01T00:00:00Z";
  /** A parcel written as the database owner (no trigger stamp): `over` are column values. */
  const parcel = async (over = {}) => {
    seq += 1;
    const row = { id: uuid(seq), user_id: ME, shop: "Synthetic shop", shop_key: "other", status: "shipped", source: "mail", tracking_number: `T${seq}`, ...over };
    const columns = Object.keys(row);
    // A write outside the signed-in role must name its owner first (the parcel candidate lock); the database owner does it like the app's RPCs do.
    await sql(`begin; select public.lock_parcel_owner('${row.user_id}'); insert into public.parcels(${columns.join(",")}) values (${columns.map((c) => row[c] === null ? "null" : quote(row[c])).join(",")}); commit;`);
    return row.id;
  };
  const stamp = (id) => scalar(`select coalesce(status_set_by_person_at::text,'null') from public.parcels where id='${id}';`);
  const status = (id) => scalar(`select status from public.parcels where id='${id}';`);
  const stamped = async (id, label) => {
    const value = await stamp(id);
    assert.notEqual(value, "null", `${label}: the person's status change must stamp the time`);
    const age = Number(await scalar(`select extract(epoch from (now() - status_set_by_person_at))::int from public.parcels where id='${id}';`));
    assert.ok(age >= -5 && age < 120, `${label}: stamped time is now(), not a client value (${value})`);
  };
  const notStamped = async (id, label, expected = "null") => assert.equal(await stamp(id), expected, `${label}: must not stamp or change the time`);
  const mailRun = () => sql(`delete from public.emails where id='${EMAIL}'; insert into public.emails(id,user_id,processing_status,processing_run_id,processing_lease_until)
    values ('${EMAIL}','${ME}','pending','${RUN}',clock_timestamp()+interval '600 seconds');`);

  /** Every assertion of the behaviour. In the negative control the first one must fail. */
  const behaviour = async () => {
    // ---- (b) a person's UPDATE changing status AND another column is saved whole; the trigger returns NEW --------
    const mixed = await parcel({ source: "manual", title: "before", status: "ordered" });
    await sql(asPerson(ME, `update public.parcels set title='after', status='shipped', expected_date='2026-11-20' where id='${mixed}';`));
    assert.equal(await scalar(`select title||'/'||status||'/'||coalesce(expected_date::text,'') from public.parcels where id='${mixed}';`), "after/shipped/2026-11-20",
      "(b) the person's UPDATE was not saved whole: a BEFORE UPDATE trigger that returns OLD discards the write (no error, found and row_count stay true)");
    await stamped(mixed, "(b) title + status together");
    console.log("OK: (b) status and other columns changed together are all saved, and the time is stamped (trigger returns NEW)");

    // ---- (a) every way a person writes a status, one case each; see the table in the comment block below --------
    // Web (src/app/app/...):
    //   W1 updateManualParcel   parcels/manual-actions.ts:130   direct UPDATE as the signed-in user, may change status  -> stamped
    //   W2 markNotDelivered     parcel-actions.ts:137           direct UPDATE {status, received_at:null}                  -> stamped
    //   W3 markNotReceived      parcel-actions.ts:184           direct UPDATE {received_at, check_dismissed_at}, status unchanged -> not stamped
    //   W4 dismissCheck         parcel-actions.ts:224           direct UPDATE {check_dismissed_at}                         -> not stamped
    //   W5 setCategory          category-actions.ts:27          direct UPDATE {category, category_source}                  -> not stamped
    //   W6 markDelivered / markDeliveredForUndo   parcel-actions.ts:26,31 (rpc mark_parcels_received at :43), security definer -> not stamped
    //   W7 restoreStatuses      parcel-actions.ts:68 (rpc restore_parcel_receipts at :86), security definer                  -> not stamped
    //   W8 createManualParcel   parcels/manual-actions.ts:64    INSERT as the signed-in user                              -> not stamped
    // iOS (ios/Otodoke/Data/ParcelWriter.swift, every write is one `write(id:_:)` PATCH as the signed-in user):
    //   I1 markDelivered        :104 (deliver)     {status:delivered, received_at}           -> stamped
    //   I2 undoDelivered        :147 (restore)     {status, received_at, check_dismissed_at} -> stamped
    //   I3 markNotDelivered     :171               {status, received_at:null}                -> stamped
    //   I4 updateManual         :406 (write at :450) and settleDuplicate's overwrite (:372)  {typed-in columns incl. status} -> stamped
    //   I5 markNotReceived :194, dismissCheck :211, setCategory :225   status never in the body -> not stamped
    //   I6 createManual         :261               INSERT                                    -> not stamped
    // Mail side (service_role / security definer, current_user is not authenticated) -> not stamped:
    //   M1 update_mail_parcel, M2 mail_run_write status update; and mail_run_write MAY write the time itself (twin merge, (d) below).
    const w1 = await parcel({ source: "manual", title: "t", status: "ordered" });
    await sql(asPerson(ME, `update public.parcels set title='t2', status='shipped' where id='${w1}' and user_id='${ME}' and source='manual';`));
    await stamped(w1, "W1 updateManualParcel / I4 updateManual");
    const w1b = await parcel({ source: "manual", title: "t", status: "ordered" });
    await sql(asPerson(ME, `update public.parcels set title='only title' where id='${w1b}';`));
    await notStamped(w1b, "W1 an edit that leaves status as it is");

    const w2 = await parcel({ status: "delivered", received_at: "2026-11-02T00:00:00Z" });
    await sql(asPerson(ME, `update public.parcels set status='shipped', received_at=null where id='${w2}' and user_id='${ME}' and status='delivered';`));
    await stamped(w2, "W2 markNotDelivered / I3");

    const w3 = await parcel({ status: "delivered", received_at: "2026-11-02T00:00:00Z" });
    await sql(asPerson(ME, `update public.parcels set received_at=null, check_dismissed_at='2026-11-03T00:00:00Z' where id='${w3}';`));
    await notStamped(w3, "W3 markNotReceived / I5");
    await sql(asPerson(ME, `update public.parcels set check_dismissed_at='2026-11-04T00:00:00Z' where id='${w3}';`));
    await notStamped(w3, "W4 dismissCheck");
    await sql(asPerson(ME, `update public.parcels set category='hobby', category_source='user' where id='${w3}';`));
    await notStamped(w3, "W5 setCategory");

    const w6 = await parcel({ status: "shipped" });
    const receipt = await scalar(asPerson(ME, `select outcome||'|'||receipt_id from public.mark_parcels_received(array['${w6}']::uuid[]);`));
    assert.match(receipt, /^written\|[0-9a-f-]{36}$/, `W6 mark_parcels_received answered ${receipt}`);
    assert.equal(await status(w6), "delivered");
    await notStamped(w6, "W6 markDelivered (security definer RPC; protected by received_at and the receipt)");
    const restored = await scalar(asPerson(ME, `select outcome from public.restore_parcel_receipts(jsonb_build_array(jsonb_build_object('id','${w6}','receipt_id','${receipt.split("|")[1]}')));`));
    assert.equal(restored, "restored", "W7 restore_parcel_receipts");
    assert.equal(await status(w6), "shipped");
    await notStamped(w6, "W7 restoreStatuses (security definer RPC)");

    const w8 = uuid(900);
    await sql(asPerson(ME, `insert into public.parcels(id,user_id,shop,status,source,status_set_by_person_at) values ('${w8}','${ME}','Synthetic shop','ordered','manual','2099-01-01T00:00:00Z');`));
    await notStamped(w8, "W8 createManualParcel / I6 INSERT (a client-sent time is dropped)");

    // ---- the column cannot be written directly by the person ---------------------------------------------------
    const direct = await parcel({ status: "shipped" });
    await sql(asPerson(ME, `update public.parcels set status_set_by_person_at='2099-01-01T00:00:00Z' where id='${direct}';`));
    await notStamped(direct, "a direct write of the column with no status change is ignored");
    await sql(asPerson(ME, `update public.parcels set status='delivered', received_at='2026-11-05T00:00:00Z', status_set_by_person_at='2099-01-01T00:00:00Z' where id='${direct}';`));
    await stamped(direct, "a client-sent time next to a status change is replaced by now()");
    const before = await stamp(direct);
    await sql(asPerson(ME, `update public.parcels set title='later edit' where id='${direct}';`));
    await notStamped(direct, "a later edit keeps the stamp as it was", before);

    // ---- RLS really applies: another person cannot touch my parcel -------------------------------------------
    const mine = await parcel({ status: "shipped" });
    await sql(`insert into auth.users(id) values ('${OTHER}') on conflict do nothing;`);
    assert.equal(await scalar(asPerson(OTHER, `with u as (update public.parcels set status='delivered', received_at='2026-11-05T00:00:00Z' where id='${mine}' returning 1) select count(*) from u;`)), "0");
    assert.equal(await status(mine), "shipped");
    await notStamped(mine, "RLS: another person's write did nothing");

    // ---- (c) the shipped iPhone build 1.0 (16) (commit 5e305c7): the columns and conditions of its PATCHes ---------
    // markDelivered: set {status, received_at}; where id, user_id, status<>cancelled, received_at is null, status=shown, updated_at=shown.
    const c1 = await parcel({ status: "shipped", received_at: null });
    const shown = await scalar(`select updated_at::text from public.parcels where id='${c1}';`);
    assert.equal(await scalar(asPerson(ME, `with u as (update public.parcels set status='delivered', received_at='2026-11-05T01:02:03Z' where id='${c1}' and user_id='${ME}'
      and status<>'cancelled' and received_at is null and status='shipped' and updated_at='${shown}'::timestamptz returning id) select count(*) from u;`)), "1");
    await stamped(c1, "(c) 1.0 (16) markDelivered");
    // undoDelivered: set {status, received_at, check_dismissed_at}; notDelivered: set {status, received_at:null}.
    await sql(asPerson(ME, `update public.parcels set status='shipped', received_at=null, check_dismissed_at=null where id='${c1}' and status='delivered' and received_at is not null;`));
    assert.equal(await status(c1), "shipped");
    await stamped(c1, "(c) 1.0 (16) undoDelivered");
    const c2 = await parcel({ status: "delivered", received_at: "2026-11-02T00:00:00Z" });
    await sql(asPerson(ME, `update public.parcels set status='shipped', received_at=null where id='${c2}' and status='delivered';`));
    await stamped(c2, "(c) 1.0 (16) markNotDelivered");
    const c3 = await parcel({ status: "delivered", received_at: "2026-11-02T00:00:00Z" });
    await sql(asPerson(ME, `update public.parcels set received_at=null where id='${c3}' and status='delivered';`));
    await notStamped(c3, "(c) 1.0 (16) markNotReceived");
    console.log("OK: (a) every way a person writes a status (Web 8, iOS 6, mail side 2): stamped or not, as listed");
    console.log("OK: (c) the 1.0 (16) iPhone PATCH column sets are stamped by the trigger");

    // ---- mail side: not stamped ----------------------------------------------------------------------------------
    await mailRun();
    const m1 = await parcel({ status: "ordered", last_email_at: T0 });
    const snapshot = await scalar(`select public.mail_parcel_snapshot('${ME}')::text;`);
    const version = await scalar(`select updated_at::text from public.parcels where id='${m1}';`);
    const updated = await scalar(asService(`select verdict from public.update_mail_parcel(${quote(snapshot)}::jsonb,'${m1}',${quote(version)}::timestamptz,'{"status":"shipped"}'::jsonb,null,'[]'::jsonb,'${EMAIL}','${RUN}');`));
    assert.equal(updated, "ok", "M1 update_mail_parcel");
    assert.equal(await status(m1), "shipped");
    await notStamped(m1, "M1 update_mail_parcel");
    const m2 = await parcel({ status: "ordered", last_email_at: T0 });
    await sql(asService(`select jsonb_array_length(public.mail_run_write('${EMAIL}','${RUN}','parcels','update','{"status":"shipped"}'::jsonb,'[{"method":"eq","args":["id","${m2}"]}]'::jsonb));`));
    assert.equal(await status(m2), "shipped");
    await notStamped(m2, "M2 mail_run_write status update");
    console.log("OK: mail-side writes (update_mail_parcel, mail_run_write) do not stamp");

    // ---- (d) twin merge: mail_run_write carries the time (allowlist) ---------------------------------------------
    const d1 = await parcel({ status: "ordered", last_email_at: T0 });
    await sql(asService(`select jsonb_array_length(public.mail_run_write('${EMAIL}','${RUN}','parcels','update',
      '{"status":"shipped","status_set_by_person_at":"2026-11-06T00:00:00Z"}'::jsonb,'[{"method":"eq","args":["id","${d1}"]}]'::jsonb));`));
    assert.equal(await scalar(`select status||'/'||to_char(status_set_by_person_at at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS') from public.parcels where id='${d1}';`), "shipped/2026-11-06T00:00:00");
    await assert.rejects(sql(asService(`select public.mail_run_write('${EMAIL}','${RUN}','parcels','update','{"no_such_column":1}'::jsonb,'[{"method":"eq","args":["id","${d1}"]}]'::jsonb);`)), /unsupported mail column/);
    console.log("OK: (d) mail_run_write (the twin merge's write) may write status_set_by_person_at; an unknown column is still refused");
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
    await sql(`insert into auth.users(id) values ('${ME}');`);

    await verifyFile(files.before, 2, []);
    await file(files.migration);
    await file(files.migration);
    await verifyFile(files.verify, 6, [1, 2, 3, 4]);

    if (negative) {
      await sql(brokenTrigger);
      let caught = null;
      try { await behaviour(); } catch (error) { caught = error; }
      assert.ok(caught, "NEGATIVE CONTROL NOT CAUGHT: the `return old` trigger passed every assertion");
      assert.match(String(caught.message), /returns OLD discards the write|(?:AssertionError|Expected values to be strictly equal)/, `unexpected failure: ${caught.message}`);
      assert.match(String(caught.message), /\(b\)|must stamp|was not saved/, `the control failed for another reason: ${caught.message}`);
      console.log(`OK: NEGATIVE CONTROL, the trigger returning OLD was caught: ${String(caught.message).split("\n")[0]}`);
    } else {
      await behaviour();
      // Rollback twice, then check what it must leave; apply again and verify.
      await file(files.down);
      await file(files.down);
      assert.equal(await scalar("select count(*) from information_schema.columns where table_schema='public' and table_name='parcels' and column_name='status_set_by_person_at';"), "0");
      assert.equal(await scalar("select count(*) from pg_trigger where tgrelid='public.parcels'::regclass and tgname='parcels_status_set_by_person';"), "0");
      await mailRun();
      await assert.rejects(sql(asService(`select public.mail_run_write('${EMAIL}','${RUN}','parcels','update','{"status_set_by_person_at":"2026-11-06T00:00:00Z"}'::jsonb,'[]'::jsonb);`)), /unsupported mail column/);
      await verifyFile(files.before, 2, []);
      console.log("OK: rollback twice: column, trigger gone, the gateway allowlist is back to the old one, and the before verify is OK again");
      await file(files.migration);
      await verifyFile(files.verify, 6, [1, 2, 3, 4]);
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
    console.error("Usage: node tests/postgres/run-person-status.mjs [--self-test|--negative-control]");
    process.exitCode = 2;
  } else {
    (args[0] === "--self-test" ? selfTest() : main(args[0] === "--negative-control")).catch((error) => {
      console.error(`verdict=FAILED: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    });
  }
}
