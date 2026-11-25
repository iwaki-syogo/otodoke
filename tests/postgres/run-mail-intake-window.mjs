import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, readdir } from "node:fs/promises";
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
//   node tests/postgres/run-mail-intake-window.mjs --negative-control-delivery
//                                                 (claim_mail_intake swapped for a version that counts every call of the
//                                                  same delivery must be CAUGHT; verdict=OK means it was caught)

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
const A = uuid(1), B = uuid(2), C = uuid(3), D = uuid(4), E = uuid(5), F = uuid(6), G = uuid(7), H = uuid(8);
const LIMITS = { user_count: 3, user_bytes: 1000, global_count: 5, global_bytes: 100000 };
const lim = (o = LIMITS) => `${quote(JSON.stringify(o))}::jsonb`;
// The shapes of the before and after rows (verdict first, then t/f checks, then counts).
const BEFORE_COLUMNS = 6, BEFORE_BOOLEANS = [1, 2, 3, 4];
const VERIFY_COLUMNS = 12, VERIFY_BOOLEANS = [1, 2, 3, 4, 5, 6, 7, 8];

/** The race a careless version would have: read the totals without locking the row, wait, then add. */
export const brokenClaim = `create or replace function public.claim_mail_intake(p_user_id uuid, p_kind text, p_bytes bigint, p_limits jsonb, p_delivery_key text)
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

/** The version before review R1: locked, but every call counts, so a retry of a delivery that was not stored is counted again. */
export const keylessClaim = `create or replace function public.claim_mail_intake(p_user_id uuid, p_kind text, p_bytes bigint, p_limits jsonb, p_delivery_key text)
returns text language plpgsql security definer set search_path = '' as $$
declare v_day date := (pg_catalog.clock_timestamp() at time zone 'Asia/Tokyo')::date; v_count integer; v_bytes bigint;
begin
  perform id from auth.users where id = p_user_id for key share;
  insert into public.mail_intake_user_counts(user_id, kind, day) values (p_user_id, p_kind, v_day) on conflict do nothing;
  select count, bytes into v_count, v_bytes from public.mail_intake_user_counts where user_id = p_user_id and kind = p_kind and day = v_day for update;
  if v_count + 1 > (p_limits->>'user_count')::bigint or v_bytes + p_bytes > (p_limits->>'user_bytes')::bigint then return 'user_intake_limit'; end if;
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
  assert.match(migration, /grant execute on function public\.claim_mail_intake\(uuid, text, bigint, jsonb, text\), public\.log_screen_event\(uuid, jsonb, jsonb\) to service_role;/);
  // The real claim records the delivery; the keyless control does not.
  assert.match(migration, /from public\.mail_intake_claims where user_id = p_user_id and kind = p_kind and delivery_digest = v_digest/);
  assert.doesNotMatch(keylessClaim, /mail_intake_claims/);
  // The after check runs both functions as their owner.
  const verify = await readFile(path.join(root, files.verify), "utf8");
  assert.match(verify, /perform public\.claim_mail_intake\(v_probe,/);
  assert.match(verify, /perform public\.log_screen_event\(v_probe,/);
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
  console.log("OK: self-test (locks and the delivery record in the real claim, none in the controls, ACL line, the owner probe, rollback drops the column, verify parser, child errors)");
  console.log("NOT RUN: PostgreSQL startup, migrations, SQL behaviour, the owner shapes and the negative controls");
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
  const claim = (user, kind, bytes, limits = LIMITS, key = null) => scalar(asRole("service_role", `select public.claim_mail_intake('${user}','${kind}',${bytes},${lim(limits)},${key === null ? "null" : quote(key)});`));
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
    // The pid file says whether this cluster is running (pg_ctl status is not used: it prints the start arguments).
    if (startAttempted && await access(path.join(data, "postmaster.pid")).then(() => true, () => false)) {
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
    const results = await together(8, `select public.claim_mail_intake('${F}','forwarding_confirmation',1,${lim({ ...LIMITS, global_count: 1000 })},null);`);
    const granted = results.filter((r) => r === "ok").length;
    const stored = await counts(F, "forwarding_confirmation");
    assert.equal(granted, 3, `8 simultaneous claims with room for 3 granted ${granted} (${results.join(",")}); stored ${stored}`);
    assert.equal(stored, "3/3", "the stored count is the granted count");
    console.log("OK: 8 claims at once for one user with room for 3: exactly 3 granted, stored 3");
    // The global counts of this check are not part of the cases below.
    await sql("delete from public.mail_intake_global_counts;");
  };

  /**
   * Review R1: the same delivery claimed again (a retry after a failure before it was stored, or an answer that was lost)
   * takes one place only, and keeps it even once the day's allowance is used. The keyless control must fail here.
   */
  const deliveryCheck = async () => {
    const two = { ...LIMITS, user_count: 2, global_count: 1000 };
    for (let i = 0; i < 5; i++) assert.equal(await claim(G, "forwarding_confirmation", 10, two, "<retry@google.test>"), "ok", `retry ${i + 1}`);
    assert.equal(await counts(G, "forwarding_confirmation"), "1/10", "five calls for one delivery are counted once");
    assert.equal(await claim(G, "forwarding_confirmation", 10, two, "<other@google.test>"), "ok", "another delivery");
    assert.equal(await claim(G, "forwarding_confirmation", 10, two, "<third@google.test>"), "user_intake_limit", "a new delivery over the allowance");
    assert.equal(await claim(G, "forwarding_confirmation", 10, two, "<retry@google.test>"), "ok", "the earlier delivery keeps its place");
    assert.equal(await counts(G, "forwarding_confirmation"), "2/20");
    assert.equal(await claim(H, "forwarding_confirmation", 10, two, "<retry@google.test>"), "ok", "the same key for another user is theirs");
    const raced = await together(6, `select public.claim_mail_intake('${H}','forwarding_confirmation',1,${lim(two)},'<race@google.test>');`);
    assert.deepEqual(raced, Array(6).fill("ok"), `six at once for one delivery: ${raced.join(",")}`);
    assert.equal(await counts(H, "forwarding_confirmation"), "2/11", "six at once for one delivery are counted once");
    console.log("OK: one delivery claimed again (retries, six at once) takes one place and keeps it after the allowance is used");
    // Yesterday's claim still counts as taken; older ones go with the next claim, and the delivery would count again.
    await sql(`update public.mail_intake_claims set day = day - 1 where user_id='${G}';`);
    assert.equal(await claim(G, "forwarding_confirmation", 10, { ...two, user_count: 3 }, "<retry@google.test>"), "ok");
    assert.equal(await counts(G, "forwarding_confirmation"), "2/20", "yesterday's claim is not counted again");
    await sql(`update public.mail_intake_claims set day = day - 3 where user_id='${G}';`);
    assert.equal(await claim(G, "forwarding_confirmation", 10, { ...two, user_count: 3 }, "<fresh@google.test>"), "ok");
    assert.equal(await scalar(`select count(*) from public.mail_intake_claims where user_id='${G}';`), "1", "claims older than yesterday are removed");
    assert.equal(await scalar(`select count(*) from public.mail_intake_claims where position('retry' in encode(delivery_digest,'escape')) > 0;`), "0", "the key is kept only as a digest");
    await sql(`delete from auth.users where id='${H}';`);
    assert.equal(await scalar(`select count(*) from public.mail_intake_claims where user_id='${H}';`), "0", "deleting the account removes its claims");
    console.log("OK: yesterday's claim still counts as taken, older claims go, only digests are kept, deleting the account removes them");
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
      `select public.claim_mail_intake('${A}','forwarding_confirmation',-1,${lim()},null);`,
      `select public.claim_mail_intake('${A}','other_kind',1,${lim()},null);`,
      `select public.claim_mail_intake(null,'forwarding_confirmation',1,${lim()},null);`,
      `select public.claim_mail_intake('${A}','forwarding_confirmation',1,${lim({ ...LIMITS, user_count: 0 })},null);`,
      `select public.claim_mail_intake('${A}','forwarding_confirmation',1,${lim({ user_count: 3, user_bytes: 1000, global_count: 5 })},null);`,
      `select public.claim_mail_intake('${A}','forwarding_confirmation',1,'{"user_count":1.5,"user_bytes":1,"global_count":1,"global_bytes":1}'::jsonb,null);`,
      `select public.claim_mail_intake('${A}','forwarding_confirmation',1,'{"user_count":"3","user_bytes":1,"global_count":1,"global_bytes":1}'::jsonb,null);`,
      `select public.log_screen_event('${A}','{"decision":"kept"}'::jsonb,${lim()});`,
    ]) await assert.rejects(sql(asRole("service_role", bad)), /bad argument|limits must be/, bad);
    await assert.rejects(sql(asRole("service_role", `select public.claim_mail_intake('${uuid(999)}','forwarding_confirmation',1,${lim()},null);`)), /no longer exists/);
    for (const role of ["anon", "authenticated"]) {
      await assert.rejects(sql(asRole(role, `select public.claim_mail_intake('${A}','forwarding_confirmation',1,${lim()},null);`)), /permission denied/, `${role} claim`);
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

  /**
   * The role that applies the migration in production is not a superuser. Its functions run as that owner, so the owner
   * itself must be able to lock auth.users rows (schema USAGE, SELECT(id), UPDATE on a column). The before check, the
   * migration's own gate and the after check must each stop when it cannot; column grants and inherited grants pass.
   * (Review R2: before and after answered OK, and every claim then failed with "permission denied for table users".)
   */
  const ownerShapes = async () => {
    const text = async (name) => readFile(path.join(root, name), "utf8");
    const asOwner = (input) => sql(`set role intake_owner; ${input}`, 60_000);
    const verdictOf = (output) => output.trim().split(/\r?\n/).at(-1).split("|")[0];
    const ownerVerify = async (name, columns, booleans) => {
      const output = await asOwner(await text(name));
      const cells = requireVerdict(output, `${name} as intake_owner`, columns, booleans);
      console.log(`OK: ${name} as intake_owner -> ${cells.join("|")}`);
    };
    const nothingApplied = async (label) => assert.equal(await scalar(`select (to_regclass('public.mail_intake_user_counts') is null
      and to_regclass('public.mail_intake_claims') is null and not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname in ('claim_mail_intake', 'log_screen_event')))::text;`), "true", `${label}: nothing was applied`);
    const roomy = { ...LIMITS, user_count: 1000, user_bytes: 1_000_000, global_count: 100_000, global_bytes: 100_000_000 };

    await file(files.down);
    await sql(`create role intake_owner nologin; create role intake_weak nologin; create role auth_row_lockers nologin;
      grant usage, create on schema public to intake_owner;
      grant usage on schema auth to intake_owner;
      grant select(id), references(id) on auth.users to intake_owner;
      alter table public.screen_events owner to intake_owner;`);

    // N1: the owner of screen_events has USAGE, SELECT(id) and REFERENCES(id) but no UPDATE: before FAILED, the gate stops.
    assert.equal(verdictOf(await asOwner(await text(files.before))), "FAILED", "before must be FAILED when the applying role cannot lock auth.users rows");
    await assert.rejects(asOwner(await text(files.migration)), /cannot lock auth\.users rows/, "the migration's gate must stop");
    await nothingApplied("the gate stopped before any change");
    console.log("OK: an owner without UPDATE on auth.users: before FAILED, the migration stopped before any change");

    // P1: the smallest working shape, column grants only (UPDATE on id): before OK, apply, after OK, real claims work.
    await sql("grant update(id) on auth.users to intake_owner;");
    await ownerVerify(files.before, BEFORE_COLUMNS, BEFORE_BOOLEANS);
    await asOwner(await text(files.migration));
    await ownerVerify(files.verify, VERIFY_COLUMNS, VERIFY_BOOLEANS);
    assert.equal(await scalar(`select string_agg(distinct pg_get_userbyid(proowner), ',') from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname in ('claim_mail_intake', 'log_screen_event');`), "intake_owner", "the new functions belong to the applying role");
    assert.equal(await claim(A, "forwarding_confirmation", 1, roomy, "<owner-shape@google.test>"), "ok", "service_role's claim runs as the owner");
    assert.equal(await log(A, { decision: "dropped", from_domain: "shop.example", subject: "s", reason: "ad", delivery_key: "<owner-shape@shop.example>" }, roomy), "logged");
    console.log("OK: column grants only (USAGE, SELECT(id), UPDATE(id), REFERENCES(id)): before OK, applied, after OK, claim and log work");

    // N2: the owner loses UPDATE after apply: the after check must fail (its probe runs the real function as its owner).
    await sql("revoke update(id) on auth.users from intake_owner;");
    await assert.rejects(asOwner(await text(files.verify)), /row-lock probe failed/, "after must stop when the DEFINER cannot lock");
    await assert.rejects(claim(A, "forwarding_confirmation", 1, roomy, "<owner-shape-2@google.test>"), /permission denied/, "what the Web would meet");
    await sql("grant update(id) on auth.users to intake_owner;");
    console.log("OK: an owner that lost UPDATE after apply: the after check stops (the claim would be refused)");

    // N3: reapply over an existing function owned by a role that cannot lock: the gate and the after check stop.
    await sql("alter function public.claim_mail_intake(uuid, text, bigint, jsonb, text) owner to intake_weak;");
    await assert.rejects(asOwner(await text(files.migration)), /owned by another role/, "the gate must stop a reapply over another owner");
    await assert.rejects(asOwner(await text(files.verify)), /row-lock probe failed|permission denied/, "after must stop");
    await sql("alter function public.claim_mail_intake(uuid, text, bigint, jsonb, text) owner to intake_owner;");
    await ownerVerify(files.verify, VERIFY_COLUMNS, VERIFY_BOOLEANS);
    await asOwner(await text(files.migration));
    await ownerVerify(files.verify, VERIFY_COLUMNS, VERIFY_BOOLEANS);
    console.log("OK: a reapply over a function owned by a role that cannot lock stops; back with its owner, the reapply and after are OK");

    // P2: table-level grants held through membership in another role: before OK, apply, after OK, claim works.
    await file(files.down);
    await sql(`revoke select(id), references(id), update(id) on auth.users from intake_owner; revoke usage on schema auth from intake_owner;
      grant usage on schema auth to auth_row_lockers; grant select, update, references on auth.users to auth_row_lockers;
      grant auth_row_lockers to intake_owner;`);
    await ownerVerify(files.before, BEFORE_COLUMNS, BEFORE_BOOLEANS);
    await asOwner(await text(files.migration));
    await ownerVerify(files.verify, VERIFY_COLUMNS, VERIFY_BOOLEANS);
    assert.equal(await claim(A, "forwarding_confirmation", 1, roomy, "<owner-shape-3@google.test>"), "ok");
    console.log("OK: grants inherited through a role: before OK, applied, after OK, claim works");
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
    await sql(`insert into auth.users(id) values ${[A, B, C, D, E, F, G, H].map((u) => `('${u}')`).join(",")};`);
    // An existing log row from before this migration stays through apply and rollback.
    await sql(`insert into public.screen_events(user_id,from_domain,subject,decision,reason) values ('${A}','old.example','old','dropped','ad');`);

    await verifyFile(files.before, BEFORE_COLUMNS, BEFORE_BOOLEANS);
    await file(files.migration);
    await file(files.migration);
    await verifyFile(files.verify, VERIFY_COLUMNS, VERIFY_BOOLEANS);
    assert.equal(await events(A), "1", "the earlier row is kept");

    if (negative === "delivery") {
      await sql(keylessClaim);
      let caught = null;
      try { await deliveryCheck(); } catch (error) { caught = error; }
      assert.ok(caught, "NEGATIVE CONTROL NOT CAUGHT: a claim that counts every call of one delivery passed the delivery check");
      assert.match(String(caught.message), /retry [0-9]|counted once/, `the control failed for another reason: ${caught.message}`);
      console.log(`OK: NEGATIVE CONTROL, the keyless claim was caught: ${String(caught.message).split("\n")[0]}`);
    } else if (negative) {
      await sql(brokenClaim);
      let caught = null;
      try { await raceCheck(); } catch (error) { caught = error; }
      assert.ok(caught, "NEGATIVE CONTROL NOT CAUGHT: a claim without row locks passed the concurrency check");
      assert.match(String(caught.message), /simultaneous claims with room for 3 granted/, `the control failed for another reason: ${caught.message}`);
      console.log(`OK: NEGATIVE CONTROL, the unlocked claim was caught: ${String(caught.message).split("\n")[0]}`);
    } else {
      await raceCheck();
      await deliveryCheck();
      await behaviour();
      await file(files.down);
      await file(files.down);
      await verifyFile(files.rolledBack, 2, []);
      await verifyFile(files.before, BEFORE_COLUMNS, BEFORE_BOOLEANS);
      assert.equal(await events(A), "1", "rollback keeps the earlier log rows");
      console.log("OK: rollback twice: functions, tables, column and index gone, the before verify is OK again, earlier rows kept");
      await file(files.migration);
      await verifyFile(files.verify, VERIFY_COLUMNS, VERIFY_BOOLEANS);
      await ownerShapes();
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
  if (args.length > 1 || args.some((arg) => !["--self-test", "--negative-control", "--negative-control-delivery"].includes(arg))) {
    console.error("Usage: node tests/postgres/run-mail-intake-window.mjs [--self-test|--negative-control|--negative-control-delivery]");
    process.exitCode = 2;
  } else {
    (args[0] === "--self-test" ? selfTest() : main(args[0] === "--negative-control-delivery" ? "delivery" : args[0] === "--negative-control")).catch((error) => {
      console.error(`verdict=FAILED: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    });
  }
}
