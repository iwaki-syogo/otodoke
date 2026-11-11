"""Exercise the real migrations in a fresh database of an explicitly local test server.

Run with --port and optionally --psql. Does not start servers, use app credentials, call APIs,
or connect outside loopback. Keeps its generated test database for inspection.
"""
import argparse
import json
import select
import shutil
import subprocess
import time
import uuid
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("--port", type=int, required=True)
parser.add_argument("--psql", default=shutil.which("psql"))
args = parser.parse_args()
if not args.psql:
    parser.error("psql is required")
root = Path(__file__).resolve().parents[1]
database = "otodoke_b5_" + uuid.uuid4().hex[:12]
base = [args.psql, "-X", "-qAt", "-h", "127.0.0.1", "-p", str(args.port), "-v", "ON_ERROR_STOP=1", "-v", "VERBOSITY=verbose"]
checks = []


def run(sql, *, db=None, fail=False, app=None):
    command = base + ["-d", db or database]
    if app:
        sql = "set application_name = '" + app + "';\n" + sql
    result = subprocess.run(command, input=sql, text=True, capture_output=True, timeout=15)
    if fail:
        assert result.returncode != 0, "expected the SQL operation to be rejected"
        return result.stderr
    assert result.returncode == 0, result.stderr
    return result.stdout.strip()


def passed(name):
    checks.append(name)


def as_service(sql, user=None, generation=None):
    headers = {} if generation is None else {"x-otodoke-sample-user": user, "x-otodoke-sample-generation": generation}
    return "set role service_role; set request.headers = '" + json.dumps(headers) + "';\n" + sql


def literal(data):
    return "'" + json.dumps(data).replace("'", "''") + "'::jsonb"


def store(user, email, lease, provider):
    return "select verdict from public.store_mail_run('%s','%s','%s',%s,null,%s);" % (
        user, email, lease, literal({"provider_email_id": provider, "message_id": provider, "processing_status": "pending", "subject": "Synthetic notice", "text_body": "Synthetic order"}),
        literal({"user_count": 1000, "global_count": 10000, "user_bytes": 1000000, "global_bytes": 10000000}),
    )


def owned(email, lease, table, operation, values, filters=None):
    return "select public.mail_run_write('%s','%s','%s','%s',%s,%s);" % (
        email, lease, table, operation, literal(values), literal(filters or []),
    )


def scalar(sql):
    return run(sql).splitlines()[-1]


run("create database " + database, db="postgres")
run("""
do $$ begin
  if not exists(select 1 from pg_roles where rolname='anon') then create role anon; end if;
  if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated; end if;
  if not exists(select 1 from pg_roles where rolname='service_role') then create role service_role bypassrls; end if;
end $$;
create schema auth;
create table auth.users(id uuid primary key);
create function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;
grant usage on schema auth to anon, authenticated, service_role;
""")
baseline = [
    "20261102090000_init.sql", "20261102100000_ordered_at_date.sql", "20261102110000_claude_usage_limit.sql",
    "20261103090000_expected_date_end.sql", "20261103130000_parcel_category_source.sql",
    "20261106120000_mail_encryption_keys.sql", "20261112020000_claude_call_release.sql",
    "20261112100000_parcel_received_at.sql", "20261113090000_claude_call_global_lock.sql",
]
for name in baseline:
    run((root / "supabase/migrations" / name).read_text())
run("grant all on all tables in schema public to service_role; grant usage,select on all sequences in schema public to service_role;")
user, other = str(uuid.uuid4()), str(uuid.uuid4())
run("insert into auth.users values ('%s'),('%s');" % (user, other))
run("insert into public.emails(user_id,provider_email_id) values ('%s','demo:synthetic/legacy');" % user)
migration = (root / "supabase/migrations/20261113110000_sample_generation.sql").read_text()
run(migration)
assert scalar("select count(*) from public.emails where provider_email_id like 'demo:%%' and sample_generation is null") == "0"
passed("existing sample metadata backfilled")
run(migration)
passed("migration applied twice")
verdicts = run((root / "supabase/verify/20261113110000_sample_generation.sql").read_text()).splitlines()
assert len(verdicts) == 6 and all(line.endswith("|t") for line in verdicts), verdicts
passed("six post-application schema and permission verdicts")
for role in ["anon", "authenticated"]:
    for function in ["begin_sample_load", "clear_all_parcels"]:
        assert "42501" in run("set role %s; select public.%s('%s');" % (role, function, user), fail=True)
    assert "42501" in run("set role %s; select public.receive_sample_parcels('%s',array[]::uuid[],now());" % (role, user), fail=True)
passed("anon and authenticated cannot get or change generations")
assert "42501" in run(as_service("select public.lock_sample_owner('%s');" % user), fail=True)
passed("service role cannot invoke the private locking helper directly")
generation = run(as_service("select public.begin_sample_load('%s');" % user))
assert generation == run(as_service("select public.begin_sample_load('%s');" % user))
passed("retry after client failure needs no lease recovery")
email, lease = str(uuid.uuid4()), str(uuid.uuid4())
assert "55000" in run(as_service(store(user, email, lease, "demo:synthetic/one")), fail=True)
passed("old headerless sample reservation rejected")
assert "55000" in run(as_service(store(user, email, lease, "demo:synthetic/one"), other, generation), fail=True)
passed("sample header owner spoof rejected")
assert run(as_service(store(user, email, lease, "demo:synthetic/one"), user, generation)) == "ok"
assert scalar("select sample_generation::text = '%s' from public.emails where id='%s'" % (generation, email)) == "t"
passed("sample reservation records its generation")
assert "55000" in run(as_service(owned(email, lease, "parcels", "insert", {"user_id": user, "shop": "Synthetic shop"})), fail=True)
passed("old headerless owned sample write rejected")
parcel = json.loads(run(as_service(owned(email, lease, "parcels", "insert", {"user_id": user, "shop": "Synthetic shop", "status": "delivered"}), user, generation)))[0]["id"]
run(as_service("update public.parcels set title='Changed' where id='%s';" % parcel, user, generation))
assert scalar("select title from public.parcels where id='%s'" % parcel) == "Changed"
passed("valid BEFORE UPDATE writes NEW")
other_generation = run(as_service("select public.begin_sample_load('%s');" % other))
other_parcel = str(uuid.uuid4())
run(as_service("insert into public.parcels(id,user_id,shop) values ('%s','%s','Other synthetic shop');" % (other_parcel, other), other, other_generation))
assert "55000" in run(as_service("update public.parcels set title='Wrong owner' where id='%s';" % other_parcel, user, generation), fail=True)
passed("cross-owner direct write rejected")
new_generation = run(as_service("select public.clear_all_parcels('%s');" % user))
assert new_generation != generation
assert scalar("select (select count(*) from public.emails where user_id='%s')+(select count(*) from public.parcels where user_id='%s')" % (user, user)) == "0"
assert scalar("select count(*) from public.parcels where user_id='%s'" % other) == "1"
passed("clear invalidates and deletes atomically without touching another user")
assert "55000" in run(as_service(store(user, str(uuid.uuid4()), str(uuid.uuid4()), "demo:synthetic/late"), user, generation), fail=True)
assert "55000" in run(as_service(owned(email, lease, "parcels", "insert", {"user_id": user, "shop": "Old sample"}), user, generation), fail=True)
passed("late reservation and owned lease cannot restore cleared sample")
fresh_email, fresh_lease = str(uuid.uuid4()), str(uuid.uuid4())
assert run(as_service(store(user, fresh_email, fresh_lease, "demo:synthetic/fresh"), user, new_generation)) == "ok"
new_parcel = json.loads(run(as_service(owned(fresh_email, fresh_lease, "parcels", "insert", {"user_id": user, "shop": "New sample", "status": "delivered"}), user, new_generation)))[0]["id"]
run(as_service(owned(fresh_email, fresh_lease, "extractions", "insert", {"user_id": user, "email_id": fresh_email, "parcel_id": new_parcel, "model": "synthetic-test", "result": {}}), user, new_generation))
real_parcel = str(uuid.uuid4())
run(as_service("insert into public.parcels(id,user_id,shop,status) values ('%s','%s','Synthetic real parcel','delivered');" % (real_parcel, user)))
run(as_service("update public.parcels set status='delivered' where id='%s';" % other_parcel, other, other_generation))
receive = "select public.receive_sample_parcels('%s',array['%s','%s','%s']::uuid[],'2026-11-12T00:00:00Z');" % (user, new_parcel, real_parcel, other_parcel)
run(as_service(receive, user, new_generation))
assert scalar("select received_at = '2026-11-12T00:00:00Z' from public.parcels where id='%s'" % new_parcel) == "t"
assert scalar("select count(*) from public.parcels where id in ('%s','%s') and received_at is not null" % (real_parcel, other_parcel)) == "0"
passed("receive RPC marks only its current-generation sample, not real or other-user parcels")
assert "55000" in run(as_service(receive, user, generation), fail=True)
passed("receive RPC rejects an old generation even when no update would match")
assert "55000" in run(as_service("update public.parcels set received_at=now() where id='%s'" % new_parcel, user, generation), fail=True)
passed("stale received-at postprocessing fenced; new load succeeds")
for table, columns in [
    ("extractions", "user_id,email_id,parcel_id,model,result"),
    ("parcel_items", "user_id,parcel_id,name"),
]:
    values = "'%s','%s','%s','test','{}'" % (user, fresh_email, new_parcel) if table == "extractions" else "'%s','%s','Synthetic item'" % (user, new_parcel)
    assert "55000" in run(as_service("insert into public.%s(%s) values (%s);" % (table, columns, values), user, generation), fail=True)
passed("extraction and item writes carry the same fence")
real_email, real_lease = str(uuid.uuid4()), str(uuid.uuid4())
assert run(as_service(store(user, real_email, real_lease, "synthetic-real-mail"))) == "ok"
run(as_service(owned(real_email, real_lease, "parcels", "insert", {"user_id": user, "shop": "Real-mail synthetic control"})))
passed("ordinary mail reservation and owned write remain usable without sample headers")

# Two independent psql processes prove both sides of the check/write boundary. Gates are SQL
# markers and pg_stat_activity lock waits, not an assumption about how long a query takes.
def hold(sql):
    process = subprocess.Popen(base + ["-d", database], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, bufsize=1)
    process.stdin.write("begin;\n" + sql + "\nselect 'B5_GATE';\n")
    process.stdin.flush()
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        ready, _, _ = select.select([process.stdout], [], [], 0.1)
        if ready and process.stdout.readline().strip() == "B5_GATE":
            return process
        if process.poll() is not None:
            raise AssertionError(process.stderr.read())
    raise AssertionError("SQL gate did not arrive")


def wait_for_lock(application):
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        if scalar("select count(*) from pg_stat_activity where application_name='%s' and wait_event_type='Lock'" % application) == "1":
            return
        time.sleep(0.02)
    raise AssertionError("second process did not wait on the generation lock")


def commit(process):
    out, error = process.communicate("commit;\n", timeout=10)
    assert process.returncode == 0, error


run(as_service("update public.parcels set received_at=null where id='%s';" % new_parcel, user, new_generation))
receiving = hold(as_service(receive, user, new_generation))
receive_clear = subprocess.Popen(base + ["-d", database, "-c", "set application_name='b5_receive_clear_wait';" + as_service("select public.clear_all_parcels('%s');" % user)], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
wait_for_lock("b5_receive_clear_wait")
commit(receiving)
receive_clear_out, receive_clear_error = receive_clear.communicate(timeout=10)
assert receive_clear.returncode == 0, receive_clear_error
assert scalar("select count(*) from public.parcels where user_id='%s'" % user) == "0"
new_generation = receive_clear_out.strip().splitlines()[-1]
passed("receive RPC and clear use generation then parcel order without deadlock")

held_parcel = str(uuid.uuid4())
writer = hold(as_service("insert into public.parcels(id,user_id,shop) values ('%s','%s','In-flight sample');" % (held_parcel, user), user, new_generation))
clear = subprocess.Popen(base + ["-d", database, "-c", "set application_name='b5_clear_wait';" + as_service("select public.clear_all_parcels('%s');" % user)], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
wait_for_lock("b5_clear_wait")
commit(writer)
clear_out, clear_error = clear.communicate(timeout=10)
assert clear.returncode == 0, clear_error
assert scalar("select count(*) from public.parcels where user_id='%s'" % user) == "0"
passed("clear waits for an in-flight write and then deletes it")
latest = clear_out.strip().splitlines()[-1]
clearing = hold(as_service("select public.clear_all_parcels('%s');" % user))
late = subprocess.Popen(base + ["-d", database, "-c", "set application_name='b5_write_wait';" + as_service("insert into public.parcels(user_id,shop) values ('%s','Delayed sample');" % user, user, latest)], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
wait_for_lock("b5_write_wait")
commit(clearing)
late_out, late_error = late.communicate(timeout=10)
assert late.returncode != 0 and "55000" in late_error, late_error
assert scalar("select count(*) from public.parcels where user_id='%s'" % user) == "0"
passed("write waiting behind clear sees the new generation and cannot insert")

real_email, real_lease = str(uuid.uuid4()), str(uuid.uuid4())
assert run(as_service(store(user, real_email, real_lease, "synthetic-real-in-flight"))) == "ok"
real_writer = hold(as_service(owned(real_email, real_lease, "parcels", "insert", {"user_id": user, "shop": "In-flight real-mail control"})))
real_clear = subprocess.Popen(base + ["-d", database, "-c", "set application_name='b5_real_clear_wait';" + as_service("select public.clear_all_parcels('%s');" % user)], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
wait_for_lock("b5_real_clear_wait")
commit(real_writer)
_, real_clear_error = real_clear.communicate(timeout=10)
assert real_clear.returncode == 0, real_clear_error
assert scalar("select count(*) from public.parcels where user_id='%s'" % user) == "0"
passed("clear orders an in-flight real owned write before deleting its parcel")
assert "42501" in run(as_service(owned(real_email, real_lease, "parcels", "insert", {"user_id": user, "shop": "Late old real-mail control"})), fail=True)
assert run(as_service(store(user, str(uuid.uuid4()), str(uuid.uuid4()), "synthetic-real-after-clear"))) == "ok"
passed("cleared real lease cannot leave an orphan; newly arriving real mail is retained")

latest = run(as_service("select public.begin_sample_load('%s');" % user))
run(as_service("insert into public.emails(user_id,provider_email_id) values ('%s','demo:synthetic/rollback'); insert into public.parcels(user_id,shop) values ('%s','Rollback control');" % (user, user), user, latest))
run("create function public.b5_refuse_delete() returns trigger language plpgsql as $$ begin raise exception 'synthetic clear failure'; end $$; create trigger b5_refuse_delete before delete on public.emails for each row execute function public.b5_refuse_delete();")
assert "synthetic clear failure" in run(as_service("select public.clear_all_parcels('%s');" % user), fail=True)
assert scalar("select generation from public.sample_generations where user_id='%s'" % user) == latest
assert scalar("select count(*) from public.parcels where user_id='%s'" % user) == "1"
passed("failed clear rolls back generation and earlier deletes")
print(json.dumps({"checks": len(checks), "passed": checks}, ensure_ascii=False))
