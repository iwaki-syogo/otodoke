// Rehearsal of the 11/14 one-off (supabase/pending/20261114090000_drop_unsealed_plaintext.sql) and
// its verify files on a disposable Postgres 17: every migration applied (Supabase's default
// privileges set first), plus the (k) migration given by OTODOKE_K_MIGRATION. Never touches
// anything but its own cluster on 127.0.0.1.
//   OTODOKE_PG_BINDIR=/opt/homebrew/opt/postgresql@17/bin OTODOKE_K_MIGRATION=<path> node tests/postgres/run-drop-unsealed.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const bin = process.env.OTODOKE_PG_BINDIR ?? "";
const kMigration = process.env.OTODOKE_K_MIGRATION;
const port = 65448;
const scratch = mkdtempSync(path.join(os.tmpdir(), "drop-unsealed-"));
const data = path.join(scratch, "data");
// db query runs as postgres with statement_timeout 2min (measured 2026-11-12); a fresh cluster has 0.
const env = { PATH: process.env.PATH, HOME: scratch, LANG: "C", LC_ALL: "C", PGOPTIONS: "-c statement_timeout=120000" };
const run = (name, args, input, extraEnv = {}) => {
  const t = Date.now();
  const r = spawnSync(path.join(bin, name), args, { input, env: { ...env, ...extraEnv }, encoding: "utf8", cwd: root, timeout: 120_000 });
  return { code: r.status, out: r.stdout ?? "", err: r.stderr ?? "", ms: Date.now() - t };
};
const base = ["-X", "-q", "-A", "-t", "-h", "127.0.0.1", "-p", String(port), "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1"];
const sql = (text, extraEnv) => run("psql", base, text, extraEnv);
const files = (list, extraEnv) => run("psql", [...base, ...list.flatMap((f) => ["-f", f])], undefined, extraEnv);
const must = (r, label) => { assert.equal(r.code, 0, `${label}: ${r.err}${r.out}`); return r.out.trim(); };
const scalar = (q) => must(sql(q), q);
const read = (rel) => readFileSync(path.join(root, rel), "utf8");
const P = "supabase/pending/20261114090000_drop_unsealed_plaintext.sql";
const V = (k) => `supabase/verify/20261114090000_drop_unsealed_plaintext.${k}.sql`;
const log = (...a) => console.log(...a);
const u = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
let started = false;
const cleanup = () => {
  if (started) run("pg_ctl", ["-D", data, "-m", "fast", "-t", "10", "stop"]);
  rmSync(scratch, { recursive: true, force: true });
};
try {
  assert.ok(bin, "OTODOKE_PG_BINDIR is required");
  assert.ok(kMigration, "OTODOKE_K_MIGRATION is required");
  assert.equal(await new Promise((res) => { const s = net.createConnection({ host: "127.0.0.1", port }); s.once("connect", () => { s.destroy(); res(true); }); s.once("error", () => res(false)); }), false, `port ${port} is in use`);
  must(run("initdb", ["-D", data, "-U", "postgres", "--no-sync", "-c", "dynamic_shared_memory_type=mmap", "-c", "shared_memory_type=mmap"]), "initdb");
  started = true;
  must(run("pg_ctl", ["-D", data, "-l", path.join(scratch, "server.log"), "-t", "10", "-o", `-h 127.0.0.1 -p ${port} -c unix_socket_directories= -c dynamic_shared_memory_type=mmap -c shared_memory_type=mmap`, "start"]), "start");
  log("CLUSTER:", scalar("show server_version;"), "port", port);
  must(files([path.join(root, "tests/postgres/bootstrap.sql")]), "bootstrap");
  must(sql("create schema supabase_migrations; create table supabase_migrations.schema_migrations(version text primary key,name text,statements text[]);"), "history");
  // Supabase's default privileges: what the migration role's new objects get.
  must(sql(`alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
    alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
    alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
    grant usage on schema public to anon, authenticated, service_role;`), "default privileges");
  log("DEFAULT PRIVILEGES: set for", scalar("select current_user;"), "before any migration");
  const migrations = readdirSync(path.join(root, "supabase/migrations")).filter((n) => /^\d{14}_.+\.sql$/.test(n)).sort();
  const record = (n) => must(sql(`insert into supabase_migrations.schema_migrations(version,name) values('${n.slice(0, 14)}','${n.slice(15, -4)}') on conflict do nothing;`), "record");
  for (const n of migrations) {
    if (n === "20261106180000_screen_events_daily_purge.sql") {
      const src = read(`supabase/migrations/${n}`);
      const b = src.indexOf("create or replace function public.is_shared_mail_domain"), e = src.indexOf("select cron.schedule");
      assert.ok(b >= 0 && e > b);
      must(sql(src.slice(b, e)), n);
      must(sql("create schema cron; create table cron.job(jobname text,command text,schedule text,active boolean);"), "cron mock");
    } else must(files([path.join(root, "supabase/migrations", n)]), n);
    record(n);
  }
  must(files([kMigration]), "k migration");
  log(`MIGRATIONS: ${migrations.length} from this tree (last ${migrations.at(-1)}) + (k) ${path.basename(kMigration)}`);
  log("LOAD OK for pending/*:", scalar("select count(*) from pg_trigger where tgrelid='public.emails'::regclass and not tgisinternal;"), "emails triggers");

  // ---- fixtures -------------------------------------------------------------------------------
  const key = (n, extra) => `insert into public.user_keys(user_id,key_id,public_key,wrapped_private_key,wrap_iv,kdf_salt,kdf_iterations,challenge_hash,activated_at,retired_at) values('${u(n)}','${String(n).padStart(32, "0")}',repeat('A',88),'w',repeat('B',16),repeat('C',24),600000,repeat('0',64),${extra});`;
  const mail = (n, user, o = {}) => {
    const c = { pe: `real-${n}`, mid: `<m${n}@x.invalid>`, status: "processed", state: "plain", cls: "order", subj: "'subject'", from: "'Shop <a@shop.example>'", text: "'body text'", html: "'<p>x</p>'", env: "null", ...o };
    return `insert into public.emails(id,user_id,provider_email_id,message_id,processing_status,body_state,classification,subject,from_name,from_address,text_body,html_body,body_envelope)
      values('${u(1000 + n)}','${u(user)}',${c.pe === null ? "null" : `'${c.pe}'`},'${c.mid}','${c.status}','${c.state}','${c.cls}',${c.subj},${c.subj === "null" ? "null" : "'Shop'"},${c.from},${c.text},${c.html},${c.env});`;
  };
  const fixtures = [
    ...[1, 2, 3, 4, 5, 6, 7].map((n) => `insert into auth.users(id) values('${u(n)}');`),
    key(2, "now(),now()"), key(3, "null,null"), key(4, "now(),null"), key(6, "now(),null"),
    // targets: users 1, 2, 3, 7 (no key / retired only / registered only)
    mail(1, 1), mail(2, 1, { cls: "forwarding_confirmation", text: "'go https://mail-settings.google.com/mail/vf-abc now'", html: "null" }),
    mail(3, 2), mail(4, 3), mail(5, 7), mail(6, 7, { pe: null }),
    // kept: users with a key in use (plain), sealed, dropped, unread kinds, discarded
    mail(10, 4), mail(11, 6), mail(12, 4, { state: "sealed", subj: "null", from: "null", text: "null", html: "null", env: "'{\"v\":1}'::jsonb" }),
    mail(13, 7, { state: "dropped", subj: "null", from: "null", text: "null", html: "null" }),
    mail(14, 1, { status: "pending" }), mail(15, 2, { status: "failed" }), mail(16, 3, { status: "discarded" }),
    mail(17, 5, { status: "over_limit" }),
  ].join("\n");
  must(sql(fixtures), "fixtures");
  // samples go through the sample generation fence
  for (const [n, user] of [[20, 1], [21, 1], [22, 4]]) {
    must(sql(`begin; select set_config('request.headers', jsonb_build_object('x-otodoke-sample-generation', public.begin_sample_load('${u(user)}')::text, 'x-otodoke-sample-user','${u(user)}')::text, true);
      ${mail(n, user, { pe: `demo:s${n}.eml`, mid: `demo:s${n}.eml` })} commit;`), `sample ${n}`);
  }
  log("FIXTURES: emails", scalar("select count(*) from public.emails;"), "users", scalar("select count(*) from auth.users;"));
  must(sql(`create table snap_emails as select * from public.emails;
    create table snap_gen as select * from public.sample_generations;
    create table snap_targets as select id from public.emails e where processing_status='processed' and body_state='plain' and coalesce(provider_email_id,'') not like 'demo:%'
      and not exists(select 1 from public.user_keys k where k.user_id=e.user_id and k.activated_at is not null and k.retired_at is null);`), "snapshot");
  const targets = Number(scalar("select count(*) from snap_targets;")), targetUsers = Number(scalar("select count(distinct user_id) from public.emails where id in (select id from snap_targets);"));
  log("EXPECTED (computed independently):", targetUsers, "users /", targets, "mails");
  const unchanged = (label) => {
    const d = scalar("select count(*) from (select e::text from public.emails e except select s::text from snap_emails s) x;");
    const d2 = scalar("select (select count(*) from public.emails)-(select count(*) from snap_emails);");
    const g = scalar("select count(*) from (select g::text from public.sample_generations g except select s::text from snap_gen s) x;");
    const g2 = scalar("select (select count(*) from public.sample_generations)-(select count(*) from snap_gen);");
    assert.deepEqual([d, d2, g, g2], ["0", "0", "0", "0"], `${label}: something changed in emails/sample_generations`);
    log(`OK: ${label}: emails and sample_generations are exactly as before`);
  };

  // ---- before ---------------------------------------------------------------------------------
  const before = must(files([path.join(root, V("before"))]), "before");
  log("BEFORE:", before);
  assert.match(before, new RegExp(`^OK\\|${targets}\\|${targetUsers}\\|`));

  // ---- count-control --------------------------------------------------------------------------
  const cc = path.join(root, V("count-control"));
  const two = must(files([cc, cc]), "count-control x2").split(/\r?\n/).filter((l) => /^(OK|FAILED|skipped)\|/.test(l));
  log("COUNT-CONTROL (two runs, one session):", two.join(" // "));
  assert.deepEqual(two.map((l) => l.split("|").slice(0, 2)), [["OK", "OK"], ["OK", "OK"]]);
  unchanged("count-control twice");
  // an OK left by an earlier run on the same connection is not read by a run that does not complete
  const ccSrc = read(V("count-control"));
  const finalSelect = ccSrc.slice(ccSrc.indexOf("with result as"));
  const stale = must(sql(`${ccSrc}\nselect set_config('otodoke.verify_d7_run', gen_random_uuid()::text, false);\n${finalSelect}`), "stale");
  const staleLast = stale.split(/\r?\n/).at(-1);
  log("STALE (OK from run 1, run 2 never wrote):", staleLast);
  assert.match(staleLast, /^FAILED\|FAILED: the block did not run/);
  // statement_timeout 0 stops before any write
  const noLimit = must(files([cc], { PGOPTIONS: "-c statement_timeout=0" }), "no limit").split(/\r?\n/).at(-1);
  log("COUNT-CONTROL with statement_timeout=0:", noLimit);
  assert.match(noLimit, /^FAILED\|FAILED: statement_timeout is 0 ms/);
  unchanged("count-control, statement_timeout=0");
  // a held auth.users row: the first insert gives up inside the 3 s lock_timeout
  {
    const holder = spawnSync(path.join(bin, "psql"), [...base, "-c", "begin; select 1 from auth.users for update; select pg_sleep(9); rollback;"], { env, encoding: "utf8", timeout: 1 }); // placeholder, replaced below
    void holder;
  }
  const { spawn } = await import("node:child_process");
  const holder = spawn(path.join(bin, "psql"), [...base, "-c", "begin; select 1 from auth.users for update; select pg_sleep(9); rollback;"], { env, stdio: "ignore" });
  await new Promise((r) => setTimeout(r, 1500));
  const held = files([cc]);
  holder.kill();
  log(`COUNT-CONTROL with auth.users held: exit ${held.code} after ${held.ms} ms: ${held.err.trim().split("\n")[0]}`);
  assert.notEqual(held.code, 0);
  assert.ok(held.ms < 7000, "must give up inside about 3 s, not wait for the holder");
  assert.match(held.err, /lock timeout|could not obtain lock/i);
  await new Promise((r) => setTimeout(r, 500));
  unchanged("count-control, held row");

  // ---- the UPDATE: refusals -------------------------------------------------------------------
  const original = read(P);
  const lineRe = /^select set_config\('otodoke\.expected_users', '<USERS>', false\), set_config\('otodoke\.expected_mails', '<MAILS>', false\);$/m;
  assert.match(original, lineRe);
  const withNumbers = (users, mails, src = original) => src.replace(lineRe, `select set_config('otodoke.expected_users', '${users}', false), set_config('otodoke.expected_mails', '${mails}', false);`);
  const save = (name, text) => { const f = path.join(scratch, name); writeFileSync(f, text); return f; };
  const refuse = (label, file, pattern) => {
    const r = files([file]);
    assert.notEqual(r.code, 0, `${label}: must stop`);
    assert.match(r.err, pattern, `${label}: ${r.err}`);
    unchanged(`UPDATE refused (${label}): ${r.err.trim().split("\n")[0].replace(/^psql:[^:]*:\d+: /, "")}`);
  };
  refuse("placeholders left", path.join(root, P), /not replaced/);
  for (const [label, uu, mm] of [["empty", "", ""], ["zero", "0", "0"], ["not an integer", "4x", "6"], ["space", "4 ", "6"], ["leading zero", "04", "6"], ["negative", "-4", "6"]]) refuse(label, save(`n.sql`, withNumbers(uu, mm)), /not replaced/);
  refuse("one placeholder left", save("n.sql", withNumbers(targetUsers, "<MAILS>")), /not replaced/);
  refuse("users differ", save("n.sql", withNumbers(targetUsers + 1, targets)), /would be dropped/);
  refuse("mails differ", save("n.sql", withNumbers(targetUsers, targets + 1)), /would be dropped/);
  const noLimitUpdate = files([save("n.sql", withNumbers(targetUsers, targets))], { PGOPTIONS: "-c statement_timeout=0" });
  assert.notEqual(noLimitUpdate.code, 0); assert.match(noLimitUpdate.err, /statement_timeout is 0/);
  unchanged("UPDATE refused (statement_timeout=0)");

  // ---- negative controls (inside this throwaway DB only) --------------------------------------
  // 1) the condition broken so a key holder's mail is dropped too: the three kept counts catch it.
  const brokenRe = /\s+and not exists \(\s*select 1 from public\.user_keys k\s+where k\.user_id = e\.user_id and k\.activated_at is not null and k\.retired_at is null\s*\)/g;
  const broken = original.replace(brokenRe, "");
  assert.ok(original.match(brokenRe).length >= 3 && broken !== original);
  const holderMails = Number(scalar("select count(*) from public.emails e where processing_status='processed' and body_state='plain' and coalesce(provider_email_id,'') not like 'demo:%' and exists(select 1 from public.user_keys k where k.user_id=e.user_id and k.activated_at is not null and k.retired_at is null);"));
  const holderUsers = Number(scalar("select count(distinct user_id) from public.emails e where processing_status='processed' and body_state='plain' and coalesce(provider_email_id,'') not like 'demo:%' and exists(select 1 from public.user_keys k where k.user_id=e.user_id and k.activated_at is not null and k.retired_at is null);"));
  refuse("NEGATIVE: key holders' mail would be dropped too", save("broken.sql", withNumbers(targetUsers + holderUsers, targets + holderMails, broken)), /a row that was not to change differs/);
  // 2) an unrelated row changed by a trigger during the update: the whole-row hash catches it.
  must(sql(`create function pg_temp_collateral() returns trigger language plpgsql as $f$ begin
      update public.emails set error='collateral' where id=(select id from public.emails where processing_status='pending' limit 1); return null; end $f$;
    create trigger zz_collateral after update on public.emails for each row when (new.body_state='dropped') execute function pg_temp_collateral();`), "collateral trigger");
  refuse("NEGATIVE: a protected row changed by a trigger", save("n.sql", withNumbers(targetUsers, targets)), /a row that was not to change differs/);
  must(sql("drop trigger zz_collateral on public.emails; drop function pg_temp_collateral();"), "drop collateral trigger");
  unchanged("negative controls cleaned up");

  // ---- the real UPDATE ------------------------------------------------------------------------
  const good = save("good.sql", withNumbers(targetUsers, targets));
  const diff = { out: spawnSync("diff", [path.join(root, P), good], { encoding: "utf8" }).stdout };
  const removed = diff.out.split("\n").filter((l) => l.startsWith("<")).length, added = diff.out.split("\n").filter((l) => l.startsWith(">")).length;
  log(`DIFF original vs replaced: ${removed} line removed, ${added} line added`);
  assert.deepEqual([removed, added], [1, 1]);
  const done = must(files([good]), "update").split(/\r?\n/).at(-1); // psql also prints the two set_config rows; db query shows only the last result
  log("UPDATE:", done);
  assert.equal(done, `DROPPED|${targetUsers}|${targets}`);
  const after = must(files([path.join(root, V("after"))]), "after");
  log("AFTER:", after);
  assert.match(after, /^OK\|nothing left to drop/);
  // all columns of every row that is not a target are the same as the snapshot taken before
  const nonTarget = "select count(*) from (select e::text from public.emails e where id not in (select id from snap_targets) except select s::text from snap_emails s where id not in (select id from snap_targets)) x;";
  assert.equal(scalar(nonTarget), "0");
  assert.equal(scalar("select count(*) from public.emails;"), scalar("select count(*) from snap_emails;"));
  log("OK: every non-target row is identical in all columns to the snapshot taken before the UPDATE");
  assert.equal(scalar("select count(*) from public.emails e join snap_targets t using(id) where e.body_state='dropped' and e.subject is null and e.from_name is null and e.from_address is null and e.text_body is null and e.html_body is null and e.body_envelope is null;"), String(targets));
  log("OK: all", targets, "targets are dropped with the five plaintext columns and the envelope null; confirm link kept:",
    scalar("select forwarding_confirm_url from public.emails where id='" + u(1002) + "';") ? "yes" : "NO");
  assert.match(scalar("select forwarding_confirm_url from public.emails where id='" + u(1002) + "';"), /^https:\/\/mail-settings\.google\.com\/mail\/vf-abc$/);
  assert.equal(scalar("select count(*) from (select g::text from public.sample_generations g except select s::text from snap_gen s) x;"), "0");
  // a second run with the same numbers finds nothing and stops
  must(sql("create table snap_after as select * from public.emails;"), "snap_after");
  const rerun = files([good]);
  assert.notEqual(rerun.code, 0); assert.match(rerun.err, /would be dropped/);
  assert.equal(scalar("select count(*) from (select e::text from public.emails e except select s::text from snap_after s) x;"), "0");
  log("OK: a second run with the same numbers stops (0 targets left) and changes nothing:", rerun.err.trim().split("\n")[0].replace(/^psql:[^:]*:\d+: /, ""));
  console.log("ALL OK");
} finally {
  cleanup();
}
