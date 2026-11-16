import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cleanEnvironment } from "./run-parcel-conflicts.mjs";
import { taggedResults } from "./run-cost-guards.mjs";

// What the App Store iPhone build 1.0 (16) (ios commit 5e305c7) sees and can write, before and after the "not a parcel" migrations.
// The reads and writes below are SQL TRANSLATIONS of that build's REST calls (they are not the PostgREST calls themselves):
//   ParcelReader.swift allParcels :31-45 / parcel :64-70 / items :73-79 / extractions :82-90 / counts :48-59
//   StatusListReader.swift parcels :24-37 / itemNames :40-47
//   ParcelWriter.swift write(.deliver / .restore / .notDelivered / .notReceived / .dismissCheck / .category / .manualEdit) :572-650,
//     markNotDelivered pre-select :176-187, setCategory pre-select :236-246, the typed-in insert :272, the typed-in delete :474
// The build calls only the RPC set_ai_reading; it never calls mark_parcels_received / restore_parcel_receipts.
const root = fileURLToPath(new URL("../../", import.meta.url));
const stem = "20261117100000_parcel_exclusions";
const stem2 = "20261117110000_parcel_exclusions_auto";
const port = 65450;
const bin = process.env.OTODOKE_PG_BINDIR ?? "";
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const A = uuid(1), B = uuid(2);
const P1 = uuid(101), P2 = uuid(102), P3 = uuid(103), P4 = uuid(104), P5 = uuid(105), PM = uuid(106), PB1 = uuid(201);
const E = (n) => uuid(300 + n);
const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
const prior = (names) => names.filter((name) => /^\d{14}_.+\.sql$/.test(name) && name.slice(0, 14) < stem.slice(0, 14)).sort();
const one = (output) => {
  const values = taggedResults(output);
  assert.equal(values.length, 1, `expected exactly one tagged JSON value: ${output}`);
  return JSON.parse(values[0]);
};
function healthy(result) {
  assert.equal(result.timedOut, false, "child timed out; never counted as success");
  assert.equal(result.signal, null, `child was interrupted: ${result.signal}`);
  assert.equal(result.code, 0, result.stderr || "child failed");
  assert.doesNotMatch(result.stderr, /\b(?:ERROR|FATAL|PANIC):/i, "SQL error even with exit zero");
  return result.stdout;
}
/** The whole run counts only with the final verdict line AND exit code 0. */
function judge(result) {
  const lines = result.stdout.trim().split(/\r?\n/);
  return result.code === 0 && result.signal === null && result.timedOut === false && lines.at(-1)?.startsWith("verdict=OK") === true
    && !/\b(?:ERROR|FATAL|PANIC):/i.test(result.stderr);
}


async function listening() {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    let settled = false;
    const finish = (value) => { if (!settled) { settled = true; socket.destroy(); resolve(value); } };
    socket.once("connect", () => finish(true)); socket.once("error", () => finish(false)); socket.setTimeout(500, () => finish(false));
  });
}

function start(executable, args, { environment, input, interactive = false, timeout = 20_000 } = {}) {
  const child = spawn(executable, args, { cwd: root, env: environment, stdio: ["pipe", "pipe", "pipe"] });
  const state = { stdout: "", stderr: "", code: null, signal: null, timedOut: false, exited: false };
  let hardStop;
  const timer = setTimeout(() => { state.timedOut = true; child.kill("SIGTERM"); hardStop = setTimeout(() => child.kill("SIGKILL"), 1000); }, timeout);
  child.stdin.on("error", () => {});
  child.stdout.on("data", (chunk) => { state.stdout += chunk; }); child.stderr.on("data", (chunk) => { state.stderr += chunk; });
  const complete = new Promise((resolve) => {
    child.on("error", (error) => { state.stderr += error.message; });
    child.on("close", (code, signal) => { clearTimeout(timer); clearTimeout(hardStop); Object.assign(state, { code, signal, exited: true }); resolve(state); });
  });
  if (interactive) child.stdin.write(input ?? ""); else child.stdin.end(input);
  return { child, state, complete };
}


async function selfTest() {
  assert.deepEqual(prior([`${stem}.sql`, "20261113140000_x.sql", "20261118000000_future.sql", "notes.md"]), ["20261113140000_x.sql"]);
  assert.deepEqual(one('RESULT:[{"r":"ok"}]\n'), [{ r: "ok" }]);
  for (const value of ["", "RESULT:{}\nRESULT:{}\n", "RESULT:broken\n"]) assert.throws(() => one(value));
  const ok = { code: 0, signal: null, timedOut: false, stderr: "", stdout: "OK: x\nverdict=OK mode=positive\n" };
  assert.equal(judge(ok), true);
  for (const changes of [{ stdout: "OK: x\n" }, { stdout: "verdict=FAILED boom\n" }, { code: 1 }, { timedOut: true }, { signal: "SIGTERM" }, { stderr: "ERROR: sql failed" }, { stdout: "verdict=OK mode=x\nextra line\n" }]) assert.equal(judge({ ...ok, ...changes }), false, JSON.stringify(changes));
  for (const changes of [{ code: 1 }, { timedOut: true }, { stderr: "ERROR: SQL failed" }]) assert.throws(() => healthy({ ...ok, ...changes }));
  const source = await readFile(path.join(root, `supabase/migrations/${stem}.sql`), "utf8");
  assert.match(source, /as restrictive for select to authenticated/);
  const own = await readFile(fileURLToPath(import.meta.url), "utf8");
  for (const name of ["O0", "O1", "O2", "O3", "O4", "O5", "O6", "O7", "O8", "O9"]) assert.ok(own.includes(`"${name} `), `test ${name} is registered`);
  // The translations must stay read/write translations of the 1.0 (16) calls: every read carries user_id, as the build's reads do.
  assert.ok((own.match(/user_id='\$\{user\}'/g) ?? []).length >= 6);
  const dummy = async (code, options) => healthy(await start(process.execPath, ["-e", code], options).complete);
  await dummy("process.stdout.write('OK')");
  await assert.rejects(dummy("process.stderr.write('ERROR: synthetic');process.exit(0)"), /SQL error/);
  await assert.rejects(dummy("setTimeout(()=>{},10000)", { timeout: 20 }), /timed out/);
  console.log("OK: self-test (final verdict + exit code judge, tagged JSON shape, child failure/exit-zero SQL error/timeout, test registry)");
  console.log("NOT RUN: PostgreSQL startup, the before/after comparison, negative controls");
}

async function main(negative) {
  assert.equal(await listening(), false, `dedicated port ${port} is occupied; no existing server was touched`);
  const parent = path.join(root, ".vitest/pg"); await mkdir(parent, { recursive: true });
  const scratch = await mkdtemp(path.join(parent, "oldiphone-"));
  const data = path.join(scratch, "data");
  console.log(`CLUSTER: proposed 127.0.0.1:${port} data=${path.relative(root, data)}; only this new cluster will be started/stopped/deleted`);
  const environment = cleanEnvironment(scratch);
  const children = new Set(); let interrupted = false, startAttempted = false, cleanupPromise;
  const launch = (name, args, options = {}, cleanup = false) => {
    assert.ok(cleanup || !interrupted, "interrupted; no further test operation started");
    const handle = start(path.join(bin, name), args, { environment, ...options });
    children.add(handle); handle.complete.then(() => children.delete(handle)); return handle;
  };
  const command = async (name, args, options, cleanup) => healthy(await launch(name, args, options, cleanup).complete);
  const args = ["-X", "-w", "-q", "-A", "-t", "-h", "127.0.0.1", "-p", String(port), "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-v", "VERBOSITY=verbose"];
  const preamble = "set statement_timeout='12s'; set lock_timeout='8s';\n";
  const sql = (input) => command("psql", args, { input: preamble + input });
  const scalar = async (input) => (await sql(input)).trim();
  const file = (name) => command("psql", [...args, "-f", path.join(root, name)], { timeout: 30_000 });
  const actor = (user, query) => `begin; set local role authenticated; set local request.jwt.claim.sub=${quote(user)}; set local request.headers='{}'; ${query} commit;`;
  const rows = async (user, select) => one(await sql(actor(user, `select 'RESULT:'||coalesce(jsonb_agg(to_jsonb(q)),'[]'::jsonb)::text from (${select}) q;`)));
  const suRows = async (select) => one(await sql(`select 'RESULT:'||coalesce(jsonb_agg(to_jsonb(q)),'[]'::jsonb)::text from (${select}) q;`));
  const stop = () => { interrupted = true; for (const handle of children) handle.child.kill("SIGTERM"); };
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  const cleanup = () => (cleanupPromise ??= (async () => {
    const pending = [...children]; pending.forEach((handle) => handle.child.kill("SIGTERM"));
    await Promise.all(pending.map((handle) => handle.complete));
    if (startAttempted) {
      const status = await launch("pg_ctl", ["-D", data, "status"], { timeout: 5000 }, true).complete;
      if (status.code === 0) await command("pg_ctl", ["-D", data, "-t", "10", "-m", "fast", "stop"], { timeout: 15_000 }, true);
      else assert.equal(status.code, 3, `cannot establish whether this disposable cluster stopped: ${status.stderr}`);
    }
    assert.equal(await listening(), false, `listener remains on 127.0.0.1:${port}; dedicated data was retained`);
    const actualParent = await realpath(parent), actualScratch = await realpath(scratch);
    assert.equal(path.dirname(actualScratch), actualParent); assert.match(path.basename(actualScratch), /^oldiphone-/);
    await rm(actualScratch, { recursive: true });
    console.log(`OK: cleanup: own cluster stopped, listener=0 on 127.0.0.1:${port}, dedicated data and logs deleted`);
  })());

  // ---- the 1.0 (16) reads, as SQL (every one carries user_id = me, as the build's reads do) ----
  const listStatuses = ["ordered", "shipped", "out_for_delivery", "cancelled", "unknown"];
  const reads = async (user) => {
    const out = {};
    const first = await rows(user, `select * from public.parcels where user_id='${user}' order by id limit 1000`);
    out.all = first;
    // the next page of the build's paging (`id > last id`), with a fixed id so a hidden row does not move the page edge
    out.allAfterP2 = await rows(user, `select * from public.parcels where user_id='${user}' and id>'${P2}' order by id limit 1000`);
    out.allNotCancelled = await rows(user, `select * from public.parcels where user_id='${user}' and status<>'cancelled' order by id limit 1000`);
    for (const status of listStatuses) out[`status_${status}`] = await rows(user, `select * from public.parcels where user_id='${user}' and status='${status}' order by id limit 1000`);
    out.status_delivered = await rows(user, `select * from public.parcels where user_id='${user}' and received_at is not null and status<>'cancelled' order by id limit 1000`);
    out.itemNames = await rows(user, `select id,parcel_id,name from public.parcel_items where user_id='${user}' order by id limit 1000`);
    out.unread = await rows(user, `select count(*)::int as n from public.emails where user_id='${user}'`);
    for (const id of [P1, P2, P3, P4, P5, PM, PB1]) {
      out[`detail_${id}`] = await rows(user, `select * from public.parcels where id='${id}' and user_id='${user}'`);
      out[`items_${id}`] = await rows(user, `select * from public.parcel_items where parcel_id='${id}' and user_id='${user}' order by created_at, id`);
      out[`extractions_${id}`] = await rows(user, `select * from public.extractions where parcel_id='${id}' and user_id='${user}' order by id`);
    }
    return out;
  };
  const without = (r, id) => {
    const out = {};
    for (const [key, value] of Object.entries(r)) {
      if (key === "itemNames" || key === "unread" || key.startsWith("items_") || key.startsWith("extractions_")) out[key] = value;  // children stay readable (R17)
      else out[key] = value.filter((row) => row.id !== id);
    }
    return out;
  };
  const columns = () => suRows("select table_name,column_name,data_type,ordinal_position from information_schema.columns where table_schema='public' and table_name='parcels' order by ordinal_position");

  // ---- the 1.0 (16) writes, as SQL, each inside a transaction that is rolled back; only the shape of what comes back is kept ----
  const written = async (user, statement) => one(await sql(`begin; set local role authenticated; set local request.jwt.claim.sub=${quote(user)}; set local request.headers='{}';
    with w as (${statement}) select 'RESULT:'||jsonb_build_object('rows',(select count(*) from w),'columns',coalesce((select jsonb_agg(k order by k) from (select distinct jsonb_object_keys(to_jsonb(w)) k from w) z),'[]'::jsonb))::text; rollback;`));
  const version = async (id) => (await suRows(`select updated_at, status, received_at from public.parcels where id='${id}'`))[0];
  const writes = async (user, targets) => {
    const out = {};
    for (const [name, id, kind] of targets) {
      const v = await version(id);
      if (kind === "deliver") out[name] = await written(user, `update public.parcels set status='delivered', received_at=now() where id='${id}' and user_id='${user}' and status<>'cancelled' and received_at is null and status=${quote(v.status)} and updated_at=${quote(v.updated_at)} returning id,status,received_at,check_dismissed_at,updated_at`);
      if (kind === "restore") out[name] = await written(user, `update public.parcels set status='ordered', received_at=null, check_dismissed_at=null where id='${id}' and user_id='${user}' and status='delivered' and received_at is not null and updated_at=${quote(v.updated_at)} returning id,status,received_at,check_dismissed_at,updated_at`);
      if (kind === "notDeliveredRead") out[name] = await written(user, `select tracking_number,carrier,status,updated_at from public.parcels where id='${id}' and user_id='${user}'`);
      if (kind === "categoryRead") out[name] = await written(user, `select updated_at from public.parcels where id='${id}' and user_id='${user}'`);
      if (kind === "category") out[name] = await written(user, `update public.parcels set category='hobby', category_source='user' where id='${id}' and user_id='${user}' and updated_at=${quote(v.updated_at)} returning id,status,received_at,check_dismissed_at,updated_at`);
      if (kind === "manualEdit") out[name] = await written(user, `update public.parcels set title='edited' where id='${id}' and user_id='${user}' and source='manual' and updated_at=${quote(v.updated_at)} returning id,status,received_at,check_dismissed_at,updated_at`);
      if (kind === "manualDelete") out[name] = await written(user, `delete from public.parcels where id='${id}' and user_id='${user}' and source='manual' returning id`);
    }
    out.manualInsert = await written(user, `insert into public.parcels(user_id,shop,status,source,title,category_source,category) values ('${user}','Typed','ordered','manual','typed','user','hobby') returning id`);
    return out;
  };
  const o2Targets = [["deliver_P1", P1, "deliver"], ["notDeliveredRead_P4", P4, "notDeliveredRead"], ["categoryRead_P2", P2, "categoryRead"], ["category_P2", P2, "category"], ["manualEdit_PM", PM, "manualEdit"], ["manualDelete_PM", PM, "manualDelete"]];

  const prep = async () => {
    await sql(`delete from auth.users where id='${A}';`); await sql(`delete from auth.users where id='${B}';`);
    await sql(`insert into auth.users(id) values ('${A}'),('${B}');`);
    const mail = (n, domain) => `insert into public.emails(id,user_id,provider_email_id,from_domain,sent_at,processing_status) values ('${E(n)}','${A}','syn:e${n}','${domain}','2026-11-02T00:00:00Z','processed');`;
    await sql(`begin; select public.lock_sample_owner('${A}');
      ${mail(1, "a.example")}${mail(2, "b.example")}${mail(3, "c.example")}${mail(4, "d.example")}${mail(5, "e.example")}
      select public.lock_parcel_owner('${A}');
      insert into public.parcels(id,user_id,shop,status,ordered_at,total_amount,title,category_source,category,source,tracking_number,carrier,received_at) values
        ('${P1}','${A}','Shop One','ordered','2026-11-05T00:00:00Z',1000,'one','user','hobby','mail','TRK-SYN-1',null,null),
        ('${P2}','${A}','Shop Two','shipped','2026-11-06T00:00:00Z',2000,'two','user','hobby','mail',null,'carrier-x',null),
        ('${P3}','${A}','Shop Three','delivered','2026-11-04T00:00:00Z',300,'three','user','hobby','mail',null,null,'2026-11-10T00:00:00Z'),
        ('${P4}','${A}','Shop Four','delivered','2026-11-03T00:00:00Z',400,'four','user','hobby','mail',null,null,null),
        ('${P5}','${A}','Shop Five','cancelled','2026-11-02T00:00:00Z',50,'five','user','hobby','mail',null,null,null),
        ('${PM}','${A}','Typed in','ordered','2026-11-07T00:00:00Z',500,'typed','user','hobby','manual',null,null,null);
      insert into public.parcel_items(parcel_id,user_id,name) select p.id,'${A}','Synthetic item of '||p.title from public.parcels p where p.user_id='${A}';
      insert into public.extractions(user_id,email_id,parcel_id,model,result) values
        ('${A}','${E(1)}','${P1}','synthetic','{"relevance":"order"}'),('${A}','${E(2)}','${P2}','synthetic','{"relevance":"shipped"}'),
        ('${A}','${E(3)}','${P3}','synthetic','{"relevance":"delivered"}'),('${A}','${E(4)}','${P4}','synthetic','{"relevance":"delivered"}'),
        ('${A}','${E(5)}','${P5}','synthetic','{"relevance":"cancelled"}');
      commit;
      begin; select public.lock_sample_owner('${B}');
      insert into public.emails(id,user_id,provider_email_id,from_domain,sent_at,processing_status) values ('${E(9)}','${B}','syn:e9','b.example','2026-11-02T00:00:00Z','processed');
      select public.lock_parcel_owner('${B}');
      insert into public.parcels(id,user_id,shop,status,ordered_at,total_amount,title,category_source,category,source,tracking_number) values ('${PB1}','${B}','B Shop','ordered','2026-11-05T00:00:00Z',700,'b one','user','hobby','mail','TRK-SYN-1');
      commit;`);
  };

  const migrationFile = `supabase/migrations/${stem}.sql`, migrationFile2 = `supabase/migrations/${stem2}.sql`;
  const record = (name) => sql(`insert into supabase_migrations.schema_migrations(version,name) values(${quote(name.slice(0, 14))},${quote(name.slice(15))}) on conflict(version) do nothing;`);
  const baseline = {};
  const marksClear = () => sql("delete from public.parcel_exclusions;");
  const exclude = async (id, user = A) => assert.equal((await rows(user, `select public.exclude_parcel('${id}') as r`))[0].r, "ok");

  const checks = {
    o0: async () => assert.deepEqual(await columns(), baseline.columns, "O0: the columns of parcels are the same before and after"),
    o1: async () => { for (const [user, key] of [[A, "a"], [B, "b"]]) assert.deepEqual(await reads(user), baseline.reads[key], `O1: ${key}'s reads are the same before and after, with no mark`); },
    o2: async () => assert.deepEqual(await writes(A, o2Targets), baseline.writes, "O2: the writes answer the same (row counts and returned columns) before and after, with no mark"),
    o3: async () => {
      await marksClear(); await exclude(P1);
      assert.deepEqual(await reads(A), without(baseline.reads.a, P1), "O3: only P1 is gone from A's reads");
      assert.deepEqual(await reads(B), baseline.reads.b, "O3: B is untouched (PB1 has the same tracking number)");
      assert.equal((await rows(A, `select id from public.parcels where id='${P2}'`)).length, 1);
    },
    o4: async () => {
      await marksClear(); await exclude(P1);
      assert.equal((await rows(A, `select id from public.parcel_items where parcel_id='${P1}' and user_id='${A}'`)).length, 1, "O4: items of a marked parcel stay readable (R17)");
      assert.equal((await rows(A, `select id from public.extractions where parcel_id='${P1}' and user_id='${A}'`)).length, 1);
      // The old build joins items by the ids of the parcels it shows, so a marked parcel's item is never drawn.
      const shown = new Set((await rows(A, `select id from public.parcels where user_id='${A}'`)).map((r) => r.id));
      const itemNames = await rows(A, `select id,parcel_id,name from public.parcel_items where user_id='${A}'`);
      assert.ok(itemNames.some((r) => r.parcel_id === P1) && !shown.has(P1));
    },
    o5: async () => {
      await marksClear(); await exclude(P1);
      const stored = JSON.stringify(await suRows(`select id,status,received_at,updated_at from public.parcels where id='${P1}'`));
      const w = await writes(A, [["deliver_P1", P1, "deliver"], ["restore_P1", P1, "restore"], ["notDeliveredRead_P1", P1, "notDeliveredRead"], ["categoryRead_P1", P1, "categoryRead"], ["category_P1", P1, "category"], ["deliver_P2", P2, "deliver"]]);
      for (const k of ["deliver_P1", "restore_P1", "notDeliveredRead_P1", "categoryRead_P1", "category_P1"]) assert.equal(w[k].rows, 0, `O5: ${k} reaches 0 rows on a marked parcel`);
      assert.equal(w.deliver_P2.rows, 1, "O5: the same write on an unmarked parcel is 1 row");
      assert.equal(JSON.stringify(await suRows(`select id,status,received_at,updated_at from public.parcels where id='${P1}'`)), stored, "O5: the marked parcel's row did not change");
    },
    o6: async () => {
      await marksClear();
      await sql(`insert into public.parcel_exclusions(parcel_id,user_id,kind,from_domain,relevance,counted) values ('${P3}','${A}','rule','c.example','order',false);`);
      assert.deepEqual(await reads(A), without(baseline.reads.a, P3), "O6: an automatic mark hides exactly P3");
    },
    o7: async () => {
      await marksClear(); await exclude(P1);
      assert.equal((await rows(A, `select public.restore_parcel('${P1}') as r`))[0].r, "ok");
      await sql(`insert into public.parcel_exclusions(parcel_id,user_id,kind,from_domain,relevance,counted) values ('${P3}','${A}','rule','c.example','order',false); delete from public.parcel_exclusions where parcel_id='${P3}';`);
      assert.deepEqual(await reads(A), baseline.reads.a, "O7: after putting back, every read is as before (updated_at too: marking never writes parcels)");
    },
    o8: async () => {
      await marksClear();
      const w = await writes(A, o2Targets);
      for (const k of ["manualEdit_PM", "manualDelete_PM", "manualInsert"]) assert.equal(w[k].rows, 1, `O8: ${k} is 1 row`);
      assert.deepEqual(w, baseline.writes);
    },
  };

  const run = async () => {
    assert.match(await command("initdb", ["--version"]), /PostgreSQL\) 17\./);
    await command("initdb", ["-D", data, "-U", "postgres", "--no-sync", "-c", "dynamic_shared_memory_type=mmap", "-c", "shared_memory_type=mmap"]);
    startAttempted = true;
    await command("pg_ctl", ["-D", data, "-l", path.join(scratch, "server.log"), "-t", "10", "-o",
      `-h 127.0.0.1 -p ${port} -c unix_socket_directories= -c dynamic_shared_memory_type=mmap -c shared_memory_type=mmap -c max_connections=50`, "start"], { timeout: 15_000 });
    assert.equal(await listening(), true); assert.equal(await scalar("show data_directory;"), data);
    await file("tests/postgres/bootstrap.sql");
    await sql("create schema supabase_migrations; create table supabase_migrations.schema_migrations(version text primary key,name text,statements text[]);");
    for (const name of prior(await readdir(path.join(root, "supabase/migrations")))) {
      if (name === "20261106180000_screen_events_daily_purge.sql") {
        const source = await readFile(path.join(root, `supabase/migrations/${name}`), "utf8");
        const begin = source.indexOf("create or replace function public.is_shared_mail_domain"), end = source.indexOf("select cron.schedule");
        assert.ok(begin >= 0 && end > begin);
        await sql(source.slice(begin, end));
        await sql("create schema cron; create table cron.job(jobname text,command text,schedule text,active boolean); insert into cron.job values('otodoke-purge-old-screen-events','select public.purge_old_screen_events()','30 18 * * *',true);");
      } else {
        await file(`supabase/migrations/${name}`);
        await sql(`insert into supabase_migrations.schema_migrations(version,name) values(${quote(name.slice(0, 14))},${quote(name.slice(15, -4))}) on conflict(version) do nothing;`);
      }
    }
    // Supabase substrate (existing parcel grants and default privileges), as in run-parcel-exclusions.mjs, before the target migration.
    await sql("grant usage on schema public to authenticated,service_role; grant select,insert,update,delete on public.parcels to authenticated,service_role;");
    const owner = (await scalar("select current_user;")).replaceAll('"', '""');
    await sql(`alter default privileges for role "${owner}" in schema public grant all on tables to anon, authenticated, service_role;
      alter default privileges for role "${owner}" in schema public grant execute on functions to anon, authenticated, service_role; grant usage on schema public to anon;`);

    // ---- stage BEFORE: only the migrations earlier than 20261117100000 ----
    await prep();
    baseline.columns = await columns();
    baseline.reads = { a: await reads(A), b: await reads(B) };
    assert.equal(baseline.reads.a.all.length, 6); assert.equal(baseline.reads.b.all.length, 1); assert.equal(baseline.reads.a.status_delivered.length, 1, "P3 is the received one");
    baseline.writes = await writes(A, o2Targets);
    assert.equal(baseline.writes.deliver_P1.rows, 1, "the 1.0 (16) write really reaches a row before the migration (else O2 is vacuous)");
    for (const k of ["notDeliveredRead_P4", "categoryRead_P2", "category_P2", "manualEdit_PM", "manualDelete_PM", "manualInsert"]) assert.equal(baseline.writes[k].rows, 1, `before: ${k} is 1 row`);
    console.log("OK: before the migration: the 1.0 (16) reads and writes were taken as the baseline");

    // ---- stage AFTER the first migration ----
    await file(migrationFile); await record(stem + ".sql"); await file(migrationFile);
    const test = async (name, fn) => { await fn(); console.log(`OK: ${name}`); };
    if (!negative) {
      await test("O0 the columns of parcels are unchanged", checks.o0);
      await test("O1 with no mark, every read is the same", checks.o1);
      await test("O2 with no mark, every write answers the same", checks.o2);
      await test("O3 a mark hides only that parcel", checks.o3);
      await test("O4 the children stay readable", checks.o4);
      await test("O5 an old screen's write on a marked parcel reaches 0 rows", checks.o5);
      await test("O6 an automatic mark is the same", checks.o6);
      await test("O7 put back: every read is as before", checks.o7);
      await test("O8 typed-in parcels: add, edit and delete are as before", checks.o8);
      await file(migrationFile2); await record(stem2 + ".sql"); await file(migrationFile2);
      await test("O9 after the stage-2 migration: reads and writes are as before, a mark still hides", async () => { await checks.o8(); await checks.o1(); await checks.o3(); await checks.o7(); });
    } else {
      const red = async (label, check) => {
        let message = null;
        try { await check(); } catch (error) { message = String(error.message).split("\n")[0]; }
        assert.ok(message, `NEGATIVE CONTROL ${label} stayed green: the test cannot see this fault`);
        console.log(`NEGATIVE: ${label}: verdict=FAILED as expected (${message.slice(0, 120)})`);
      };
      const fault = async (label, make, ...fixtures) => {
        const rewrites = label.includes("writes the parcel row");
        try { await make(); for (const check of fixtures) await red(`${label}`, check); } finally { await sql("alter table public.parcels drop column if exists x;"); await file(migrationFile); await marksClear(); }
        if (!rewrites) for (const check of fixtures) await check();  // a fault that wrote parcel rows leaves new updated_at values: the baseline no longer applies
      };
      await fault("O0 with a column added to parcels", () => sql("alter table public.parcels add column x int;"), checks.o0);
      await fault("O1 with a policy that hides every row", () => sql(`drop policy "hide excluded parcels" on public.parcels; create policy "hide excluded parcels" on public.parcels as restrictive for select to authenticated using (false);`), checks.o1, checks.o2);
      await fault("O3/O5 with a permissive policy (hides nothing)", () => sql(`drop policy "hide excluded parcels" on public.parcels; create policy "hide excluded parcels" on public.parcels for select to authenticated using (not exists (select 1 from public.parcel_exclusions e where e.parcel_id = parcels.id));`), checks.o3, checks.o5);
      const real = await scalar("select pg_get_functiondef('public.exclude_parcel(uuid)'::regprocedure);");
      const touching = real.replace("  insert into public.parcel_exclusions as x", "  update public.parcels set title=title where id=p_parcel_id;\n  insert into public.parcel_exclusions as x");
      assert.notEqual(touching, real);
      await fault("O7 with an exclude_parcel that writes the parcel row", () => sql(touching), checks.o7);
      // O6 and O8 share O1/O3's guards; O4 is a property of the unchanged child tables (no fault is injected for it).
    }
  };
  try { await run(); } finally { await cleanup(); }
  console.log(`verdict=OK mode=${negative ? "negative-control" : "positive"}`);
}

const help = `Usage: node tests/postgres/run-old-iphone-view.mjs [--self-test | --negative-control]
(no flag): start a disposable PostgreSQL on 127.0.0.1:${port}, take what iPhone build 1.0 (16) reads and writes BEFORE the not-a-parcel migrations,
apply them, and compare (no mark: same; a mark: only that parcel is gone; old writes on a marked parcel reach 0 rows).
--self-test: no PostgreSQL. --negative-control: inject faults (extra column, hide-all policy, permissive policy, parcel-writing exclude_parcel) and require red.
Success is the last line "verdict=OK" together with exit code 0.`;
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const flags = process.argv.slice(2);
  if (flags.some((flag) => !["--help", "--self-test", "--negative-control"].includes(flag)) || flags.length > 1) { console.error(help); process.exitCode = 2; }
  else if (flags.includes("--help")) console.log(help);
  else (flags.includes("--self-test") ? selfTest() : main(flags.includes("--negative-control"))).then(() => { if (flags.includes("--self-test")) console.log("verdict=OK mode=self-test"); }).catch((error) => {
    console.error(`verdict=FAILED ${error.stack ?? error}`); process.exitCode = 1;
  });
}
