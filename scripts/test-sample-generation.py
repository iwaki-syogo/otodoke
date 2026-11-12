"""Exercise the real migrations in a fresh database of an explicitly local test server.

Run with --port and optionally --psql. Does not start servers, use app credentials, call APIs,
or connect outside loopback. Keeps its generated test database for inspection.
"""
import argparse
import json
import os
import tempfile
import re
import select
import shutil
import subprocess
import time
import uuid
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("--port", type=int, required=True)
parser.add_argument("--psql", default=shutil.which("psql"))
parser.add_argument("--user", default="postgres")
parser.add_argument("--negative-parent-prefix", action="store_true", help="In the scratch database only, remove the writer auth-row prefix; the deletion regression must fail with 40P01")
parser.add_argument("--negative-claim-prefix", action="store_true", help="In the scratch database only, remove the backlog claim auth-row prefix; its deletion regression must fail with 40P01")
parser.add_argument("--negative-release-prefix", action="store_true", help="In the scratch database only, remove the release auth-row prefix; its deletion regression must fail with 40P01")
parser.add_argument("--negative-cost-prefix", action="store_true", help="In the scratch database only, remove the v2 claim auth-row prefix; its deletion regression must fail with 40P01")
args = parser.parse_args()
if not args.psql:
    parser.error("psql is required")
root = Path(__file__).resolve().parents[1]
database = "otodoke_b5_" + uuid.uuid4().hex[:12]
base = [args.psql, "-X", "-w", "-qAt", "-h", "127.0.0.1", "-p", str(args.port), "-U", args.user, "-v", "ON_ERROR_STOP=1", "-v", "VERBOSITY=verbose"]

# libpq's PGHOSTADDR can override -h; strip all inherited PG settings without printing
# their values, and prevent implicit home/system password or service-file reads.
scratch_parent=root / ".vitest" / "pg"
scratch_parent.mkdir(parents=True,exist_ok=True)
client_scratch=Path(tempfile.mkdtemp(prefix="sample-python-",dir=scratch_parent))
psql_environment={key:value for key,value in os.environ.items() if not key.upper().startswith("PG")}
psql_environment.update({"LC_ALL":"C","LANG":"C",
    "PGPASSFILE":str(client_scratch / "no-password-file"),
    "PGSERVICEFILE":str(client_scratch / "no-service-file"),
    "PGSYSCONFDIR":str(client_scratch / "no-system-config")})
checks = []


def psql_process(command, **options):
    return subprocess.Popen(command, env=psql_environment, **options)


def run(sql, *, db=None, fail=False, app=None):
    command = base + ["-d", db or database]
    if app:
        sql = "set application_name = '" + app + "';\n" + sql
    result = subprocess.run(command, input=sql, text=True, capture_output=True, timeout=15, env=psql_environment)
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
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
grant usage on schema auth to anon, authenticated, service_role;
""")
baseline = [
    "20261102090000_init.sql", "20261102100000_ordered_at_date.sql", "20261102110000_claude_usage_limit.sql",
    "20261103090000_expected_date_end.sql", "20261103130000_parcel_category_source.sql",
    "20261106120000_mail_encryption_keys.sql", "20261106190000_claude_usage_keeps_deleted_calls.sql", "20261112020000_claude_call_release.sql",
    "20261112100000_parcel_received_at.sql", "20261112180000_ai_reading_consent.sql", "20261112181000_ai_consent_auto_read.sql", "20261113090000_claude_call_global_lock.sql", "20261113100000_parcel_write_conflicts.sql",
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
verify = (root / "supabase/verify/20261113110000_sample_generation.sql").read_text().rstrip().removesuffix(";")
query_at=verify.index("with checks as (")
verdicts = json.loads(run(verify[:query_at]+"select row_to_json(checked) from (" + verify[query_at:] + ") checked;"))
assert verdicts.pop("verdict") == "OK" and len(verdicts) == 8 and all(value is True for value in verdicts.values()), verdicts
passed("all eight post-application checks and the real-owner lock probe pass with final verdict OK")
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

# The generation header also fences real mail. A cached reread never allocates another row;
# a request starting after clear can acquire the new generation and store a new arrival.
real_user,real_email,real_lease=str(uuid.uuid4()),str(uuid.uuid4()),str(uuid.uuid4())
run("insert into auth.users(id) values ('%s');" % real_user)
real_generation=run(as_service("select public.begin_sample_load('%s');" % real_user))
assert run(as_service(store(real_user,real_email,real_lease,"synthetic-real-generation"),real_user,real_generation))=="ok"
listed_stamp=scalar("select created_at from public.emails where id='%s'" % real_email)
run(as_service("select public.clear_all_parcels('%s');" % real_user))
late=store(real_user,str(uuid.uuid4()),str(uuid.uuid4()),"synthetic-real-delayed")
assert "55000" in run(as_service(late,real_user,real_generation),fail=True)
owned_error=run(as_service(owned(real_email,real_lease,"parcels","insert",{"user_id":real_user,"shop":"Synthetic real stale"}),real_user,real_generation),fail=True)
assert "55000" in owned_error and "sample generation or owner is missing" in owned_error
assert scalar("select count(*) from public.emails where user_id='%s'" % real_user)=="0"
assert scalar("select count(*) from public.parcels where user_id='%s'" % real_user)=="0"
passed("real-mail captured generation rejects delayed reservation and owned writes after clear")
reread=store(real_user,real_email,real_lease,"synthetic-real-generation").replace(",null,",",'%s'," % listed_stamp,1)
assert run(as_service(reread))=="busy"
assert scalar("select count(*) from public.emails where user_id='%s'" % real_user)=="0"
passed("a pinned reread version returns busy after its row was cleared instead of inserting")
real_next=run(as_service("select public.begin_sample_load('%s');" % real_user))
assert real_next!=real_generation
fresh_real,fresh_run=str(uuid.uuid4()),str(uuid.uuid4())
assert run(as_service(store(real_user,fresh_real,fresh_run,"synthetic-real-new-arrival"),real_user,real_next))=="ok"
assert len(json.loads(run(as_service(owned(fresh_real,fresh_run,"parcels","insert",{"user_id":real_user,"shop":"Synthetic real fresh"}),real_user,real_next))))==1
passed("a new real arrival with the post-clear generation stores and files successfully")

email, lease = str(uuid.uuid4()), str(uuid.uuid4())
assert "55000" in run(as_service(store(user, email, lease, "demo:synthetic/one")), fail=True)
passed("old headerless sample reservation rejected")
assert "55000" in run(as_service(store(user, email, lease, "demo:synthetic/one"), other, generation), fail=True)
passed("sample header owner spoof rejected")

# Statement triggers fire even for an RLS-filtered zero-row UPDATE. Reject another user's
# header before creating/locking that owner's private generation state.
run("grant select,insert,update,delete on public.emails,public.parcels,public.extractions,public.parcel_items to authenticated;")
state_before = scalar("select coalesce(jsonb_agg(to_jsonb(g) order by user_id),'[]') from public.sample_generations g")
for table in ["emails", "parcels", "extractions", "parcel_items"]:
    forged = "set role authenticated; set request.jwt.claim.sub='%s'; set request.headers=%s; update public.%s set user_id=user_id where false;" % (
        user, literal({"x-otodoke-sample-user": other, "x-otodoke-sample-generation": generation}).removesuffix("::jsonb"), table)
    error = run(forged, fail=True)
    assert "42501" in error and "sample owner must match authenticated user" in error, table
assert scalar("select coalesce(jsonb_agg(to_jsonb(g) order by user_id),'[]') from public.sample_generations g") == state_before
passed("authenticated forged sample owner reaches the statement guard and fails before any generation change on all four tables")
for headers in [{}, {"x-otodoke-sample-user": user, "x-otodoke-sample-generation": generation}]:
    auth_control = "begin; set local role authenticated; set local request.jwt.claim.sub='%s'; set local request.headers=%s;" % (user,literal(headers).removesuffix("::jsonb"))
    auth_control += "insert into public.parcels(user_id,shop,title) values ('%s','Synthetic authenticated','Before') returning title;" % user
    auth_control += "update public.parcels set title='After' where user_id='%s' and shop='Synthetic authenticated' returning title;" % user
    auth_control += "update public.parcels set status='delivered' where user_id='%s' and shop='Synthetic authenticated' returning current_user,received_at is not null; rollback;" % user
    assert run(auth_control).splitlines() == ["Before", "After", "authenticated|t"]
passed("legitimate authenticated parcel insert and update succeed both headerless and with their own current sample header")
service_control = "begin;" + as_service("insert into public.parcels(user_id,shop,status) values ('%s','Synthetic server delivered','ordered'); update public.parcels set status='delivered' where user_id='%s' and shop='Synthetic server delivered' returning current_user,received_at is null; rollback;" % (user,user))
assert run(service_control).splitlines()==["service_role|t"]
passed("statement definer prelock preserves role semantics: authenticated delivery marks received, service mail delivery does not")


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
def read_sql_gate(process, observed_chunks=None):
    # Do not mix TextIOWrapper.readline() with OS readiness: readline may retain the marker
    # after consuming a preceding void-SELECT newline while select sees an empty OS pipe.
    pending=b""
    deadline=time.monotonic()+5
    while time.monotonic()<deadline:
        ready,_,_=select.select([process.stdout],[],[],0.1)
        if ready:
            chunk=os.read(process.stdout.fileno(),65536)
            if observed_chunks is not None:
                observed_chunks.append(chunk)
            pending+=chunk
            while b"\n" in pending:
                line,pending=pending.split(b"\n",1)
                if line.strip()==b"B5_GATE":
                    return
            if not chunk:
                break
        if process.poll() is not None and not ready:
            break
    error=process.stderr.read() if process.poll() is not None else ""
    raise AssertionError("SQL gate did not arrive: "+error)


def hold(sql):
    process = psql_process(base + ["-d", database], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, bufsize=1)
    process.stdin.write("begin;\n" + sql + "\nselect 'B5_GATE';\n")
    process.stdin.flush()
    read_sql_gate(process)
    return process


# Wait for this tiny real psql output to finish so its blank row and marker are already in
# the same OS pipe chunk. A buffered-readline/readiness loop loses the second line here.
marker_probe=psql_process(base+["-d",database,"-c","copy (select marker from (values (1,''),(2,'B5_GATE')) t(n,marker) order by n) to stdout;"],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
marker_probe.wait(timeout=5)
marker_chunks=[]
read_sql_gate(marker_probe,marker_chunks)
_,marker_error=marker_probe.communicate(timeout=5)
assert marker_probe.returncode==0,marker_error
assert any(b"\nB5_GATE\n" in chunk for chunk in marker_chunks)
passed("real psql blank row and SQL marker in one pipe chunk are consumed without buffered-readiness loss")


def wait_for_lock(application):
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        if scalar("select count(*) from pg_stat_activity where datname=current_database() and application_name='%s' and wait_event_type='Lock'" % application) == "1":
            return
        time.sleep(0.02)
    raise AssertionError("the expected process did not reach its database-local lock gate")


def commit(process):
    out, error = process.communicate("commit;\n", timeout=10)
    assert process.returncode == 0, error


# Pause the real initial backlog claim before its first journal INSERT's FK check. The
# synthetic advisory gate is released before observing the production auth/consent cycle.
if args.negative_claim_prefix:
    claim_wrapper = re.search(r"create or replace function public\.claim_ai_reading_backlog\([\s\S]*?\bas \$\$[\s\S]*?\$\$;",migration).group(0)
    unprefixed_claim = re.sub(r"  perform id from auth.users[^;]+;\n  if not found then return false; end if;\n", "", claim_wrapper)
    assert unprefixed_claim!=claim_wrapper
    run(unprefixed_claim)
claim_user = str(uuid.uuid4())
run("insert into auth.users(id) values ('%s'); select public.begin_sample_load('%s');" % (claim_user,claim_user))
claim_stamp = run("set role authenticated; set request.jwt.claim.sub='%s'; select decided_at from public.set_ai_reading('granted','synthetic-claim-version');" % claim_user)
assert scalar("select count(*) from public.ai_consent_read_runs where user_id='%s'" % claim_user)=="0"
run("create function public.b5_pause_claim_journal() returns trigger language plpgsql as $$ begin if new.user_id='%s'::uuid then perform pg_catalog.pg_advisory_xact_lock(62899,62898); end if; return new; end $$; create trigger b5_pause_claim_journal before insert on public.ai_consent_read_runs for each row execute function public.b5_pause_claim_journal();" % claim_user)
claim_gate = hold("select pg_catalog.pg_advisory_xact_lock(62899,62898);")
claiming = psql_process(base+["-d",database,"-c","set application_name='b5_claim_journal_gate';"+as_service("select public.claim_ai_reading_backlog('%s','%s');" % (claim_user,claim_stamp))],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
wait_for_lock("b5_claim_journal_gate")
claim_deleting = psql_process(base+["-d",database,"-c","set application_name='b5_claim_delete_wait'; delete from auth.users where id='%s';" % claim_user],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
wait_for_lock("b5_claim_delete_wait")
commit(claim_gate)
claim_out,claim_error = claiming.communicate(timeout=10)
_,claim_delete_error = claim_deleting.communicate(timeout=10)
assert claiming.returncode==0 and claim_deleting.returncode==0,(claim_error,claim_delete_error)
assert claim_out.strip()=="t"
for table in ["auth.users","public.ai_reading_consents","public.ai_consent_read_runs","public.sample_generations"]:
    column="id" if table=="auth.users" else "user_id"
    assert scalar("select count(*) from %s where %s='%s'" % (table,column,claim_user))=="0",table
run("drop trigger b5_pause_claim_journal on public.ai_consent_read_runs; drop function public.b5_pause_claim_journal();")
passed("initial automatic backlog claim and auth deletion complete without auth-parent/consent deadlock or orphaned consent journal")

# Standalone v2 also appends an auth-owned ledger row after updating existing usage.
# The owned pipeline already takes the parent prefix; exercise this public service entry too.
if args.negative_cost_prefix:
    cost_wrapper=re.search(r"create or replace function public\.claim_claude_call_v2\([\s\S]*?\bas \$\$[\s\S]*?\$\$;",migration).group(0)
    unsafe_cost=re.sub(r"  perform id from auth.users[^;]+;\n", "",cost_wrapper)
    assert unsafe_cost!=cost_wrapper
    run(unsafe_cost)
cost_user=str(uuid.uuid4())
run("insert into auth.users(id) values ('%s'); select public.begin_sample_load('%s');" % (cost_user,cost_user))
assert run(as_service("select public.claim_claude_call('%s',100,2147483647);" % cost_user))=="ok"
run("create function public.b5_pause_cost_ledger() returns trigger language plpgsql as $$ begin if new.user_id='%s'::uuid then perform pg_catalog.pg_advisory_xact_lock(62899,62896); end if; return new; end $$; create trigger b5_pause_cost_ledger before insert on public.claude_call_claims for each row execute function public.b5_pause_cost_ledger();" % cost_user)
cost_gate=hold("select pg_catalog.pg_advisory_xact_lock(62899,62896);")
cost_claiming=psql_process(base+["-d",database,"-c","set application_name='b5_cost_ledger_gate';"+as_service("select verdict from public.claim_claude_call_v2('%s',100,2147483647);" % cost_user)],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
wait_for_lock("b5_cost_ledger_gate")
cost_deleting=psql_process(base+["-d",database,"-c","set application_name='b5_cost_delete_wait'; delete from auth.users where id='%s';" % cost_user],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
wait_for_lock("b5_cost_delete_wait")
commit(cost_gate)
cost_out,cost_error=cost_claiming.communicate(timeout=10)
_,cost_delete_error=cost_deleting.communicate(timeout=10)
assert cost_claiming.returncode==0 and cost_deleting.returncode==0,(cost_error,cost_delete_error)
assert cost_out.strip()=="ok"
assert scalar("select count(*) from auth.users where id='%s'" % cost_user)=="0"
run("drop trigger b5_pause_cost_ledger on public.claude_call_claims; drop function public.b5_pause_cost_ledger();")
passed("standalone v2 claim with existing usage and auth deletion avoid usage/auth-ledger deadlock")

# Release locks the claim before updating usage. A parent delete used to take those rows
# in the opposite order. Pause only for synchronization; release the gate before the cycle.
if args.negative_release_prefix:
    release_wrapper=re.search(r"create or replace function public\.release_claude_call\([\s\S]*?\bas \$\$[\s\S]*?\$\$;",migration).group(0)
    unsafe_release=re.sub(r"  perform id from auth.users[^;]+;\n  if not found then return 0; end if;\n", "",release_wrapper)
    assert unsafe_release!=release_wrapper
    run(unsafe_release)
release_user=str(uuid.uuid4())
run("insert into auth.users(id) values ('%s'); select public.begin_sample_load('%s');" % (release_user,release_user))
release_id=run(as_service("select claim_id from public.claim_claude_call_v2('%s',100,2147483647);" % release_user))
release_total=int(scalar("select sum(calls) from public.claude_usage_daily"))
run("create function public.b5_pause_release_claim() returns trigger language plpgsql as $$ begin if new.user_id='%s'::uuid then perform pg_catalog.pg_advisory_xact_lock(62899,62897); end if; return new; end $$; create trigger b5_pause_release_claim after update on public.claude_call_claims for each row execute function public.b5_pause_release_claim();" % release_user)
release_gate=hold("select pg_catalog.pg_advisory_xact_lock(62899,62897);")
releasing=psql_process(base+["-d",database,"-c","set application_name='b5_release_gate';"+as_service("select public.release_claude_call(%s,'%s');" % (release_id,release_user))],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
wait_for_lock("b5_release_gate")
release_deleting=psql_process(base+["-d",database,"-c","set application_name='b5_release_delete_wait'; delete from auth.users where id='%s';" % release_user],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
wait_for_lock("b5_release_delete_wait")
commit(release_gate)
release_out,release_error=releasing.communicate(timeout=10)
_,release_delete_error=release_deleting.communicate(timeout=10)
assert releasing.returncode==0 and release_deleting.returncode==0,(release_error,release_delete_error)
assert release_out.strip()=="1"
assert int(scalar("select sum(calls) from public.claude_usage_daily"))==release_total-1
assert run(as_service("select public.release_claude_call(%s,'%s');" % (release_id,release_user)))=="0"
assert "22023" in run(as_service("select public.release_claude_call(null,'%s');" % release_user),fail=True)
run("drop trigger b5_pause_release_claim on public.claude_call_claims; drop function public.b5_pause_release_claim();")
passed("release and auth deletion avoid claim/usage deadlock, decrement once, and preserve missing-owner zero versus null-input 22023")

# V1 has no ledger INSERT after updating an existing usage row. Deletion simply waits
# until the real call commits, then anonymizes its accumulated count.
v1_user=str(uuid.uuid4())
run("insert into auth.users(id) values ('%s');" % v1_user)
assert run(as_service("select public.claim_claude_call('%s',100,2147483647);" % v1_user))=="ok"
v1_total=int(scalar("select sum(calls) from public.claude_usage_daily"))
# This trigger sorts before the RI_ConstraintTrigger FK check: the test pauses the actual
# function before any pending unchanged-key FK trigger could request its auth parent.
run("create function public.b5_pause_existing_usage() returns trigger language plpgsql as $$ begin if new.user_id='%s'::uuid then perform pg_catalog.pg_advisory_xact_lock(62899,62894); end if; return new; end $$; create trigger \"AAA_b5_pause_existing_usage\" after update on public.claude_usage_daily for each row execute function public.b5_pause_existing_usage();" % v1_user)
v1_existing_gate=hold("select pg_catalog.pg_advisory_xact_lock(62899,62894);")
v1_writer=psql_process(base+["-d",database,"-c","set application_name='b5_v1_existing_update_gate';"+as_service("select public.claim_claude_call('%s',100,2147483647);" % v1_user)],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
wait_for_lock("b5_v1_existing_update_gate")
v1_delete=psql_process(base+["-d",database,"-c","set application_name='b5_v1_existing_delete_wait'; delete from auth.users where id='%s';" % v1_user],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
wait_for_lock("b5_v1_existing_delete_wait")
commit(v1_existing_gate)
v1_out,v1_writer_error=v1_writer.communicate(timeout=10)
assert v1_writer.returncode==0 and v1_out.strip()=="ok",v1_writer_error
_,v1_error=v1_delete.communicate(timeout=10)
assert v1_delete.returncode==0,v1_error
assert int(scalar("select sum(calls) from public.claude_usage_daily"))==v1_total+1
run('drop trigger "AAA_b5_pause_existing_usage" on public.claude_usage_daily; drop function public.b5_pause_existing_usage();')
passed("standalone v1 existing-usage update completes before auth deletion and retains its calls without a backward auth FK request")

# On V1's very first usage insert, a deleting parent can win before the child exists. The
# actual FK then rejects a vanished owner with 23503, never waits in a usage/auth cycle.
v1_first=str(uuid.uuid4())
run("insert into auth.users(id) values ('%s'); create function public.b5_pause_first_usage() returns trigger language plpgsql as $$ begin if new.user_id='%s'::uuid then perform pg_catalog.pg_advisory_xact_lock(62899,62895); end if; return new; end $$; create trigger b5_pause_first_usage before insert on public.claude_usage_daily for each row execute function public.b5_pause_first_usage();" % (v1_first,v1_first))
v1_gate=hold("select pg_catalog.pg_advisory_xact_lock(62899,62895);")
v1_inserting=psql_process(base+["-d",database,"-c","set application_name='b5_v1_first_insert_gate';"+as_service("select public.claim_claude_call('%s',100,2147483647);" % v1_first)],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
wait_for_lock("b5_v1_first_insert_gate")
run("delete from auth.users where id='%s';" % v1_first)
commit(v1_gate)
_,v1_first_error=v1_inserting.communicate(timeout=10)
assert v1_inserting.returncode!=0 and "23503" in v1_first_error and "40P01" not in v1_first_error,v1_first_error
assert scalar("select count(*) from public.claude_usage_daily where user_id='%s'" % v1_first)=="0"
run("drop trigger b5_pause_first_usage on public.claude_usage_daily; drop function public.b5_pause_first_usage();")
passed("standalone v1 first insert after auth deletion fails atomically with the original foreign-key error instead of deadlocking")

# A generation owner must also lock its auth parent before deletion can lock that parent.
# These are two real connections: no fake mutex or extra advisory lock models the cycle.
if args.negative_parent_prefix:
    original_helper = re.search(r"create or replace function public\.lock_sample_owner\([\s\S]*?\bas \$\$[\s\S]*?\$\$;", migration).group(0)
    unprefixed = re.sub(r"  perform id from auth.users[^;]+;\n  if not found then raise exception 'sample owner no longer exists'[^;]+; end if;\n", "", original_helper)
    assert unprefixed != original_helper
    run(unprefixed)
deleting_user = str(uuid.uuid4())
run("insert into auth.users(id) values ('%s'); select public.begin_sample_load('%s'); select verdict from public.claim_claude_call_v2('%s',100,2147483647); select verdict from public.claim_claude_call_v2('%s',100,2147483647);" % (deleting_user,deleting_user,deleting_user,other))
total_calls_before = int(scalar("select coalesce(sum(calls),0) from public.claude_usage_daily"))
null_calls_before = int(scalar("select coalesce(sum(calls),0) from public.claude_usage_daily where user_id is null"))
deleted_calls = int(scalar("select coalesce(sum(calls),0) from public.claude_usage_daily where user_id='%s'" % deleting_user))
assert deleted_calls>0
deleting_mail,deleting_parcel = str(uuid.uuid4()),str(uuid.uuid4())
run("insert into public.emails(id,user_id,provider_email_id) values ('%s','%s','synthetic-cascade-seed'); insert into public.parcels(id,user_id,shop) values ('%s','%s','Synthetic cascade seed'); insert into public.parcel_items(parcel_id,user_id,name) values ('%s','%s','Synthetic cascade item'); insert into public.extractions(user_id,email_id,parcel_id,model,result) values ('%s','%s','%s','synthetic','{}');" % (deleting_mail,deleting_user,deleting_parcel,deleting_user,deleting_parcel,deleting_user,deleting_user,deleting_mail,deleting_parcel))
for table in ["emails","parcels","extractions","parcel_items","sample_generations","claude_usage_daily","claude_call_claims"]:
    assert int(scalar("select count(*) from public.%s where user_id='%s'" % (table,deleting_user)))>0, table
other_costs = scalar("select jsonb_agg(to_jsonb(c) order by day) from public.claude_usage_daily c where user_id='%s'" % other)
parent_writer = hold("select public.lock_sample_owner('%s');" % deleting_user)
parent_delete = psql_process(base + ["-d",database,"-c", "set application_name='b5_parent_delete_wait'; delete from auth.users where id='%s';" % deleting_user], stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
wait_for_lock("b5_parent_delete_wait")
writer_out, writer_error = parent_writer.communicate(as_service(store(deleting_user,str(uuid.uuid4()),str(uuid.uuid4()),"synthetic-delete-race")) + "commit;",timeout=10)
delete_out, delete_error = parent_delete.communicate(timeout=10)
assert parent_writer.returncode==0 and parent_delete.returncode==0, (writer_error,delete_error)
assert writer_out.strip()=="ok", writer_out
assert scalar("select count(*) from auth.users where id='%s'" % deleting_user)=="0"
for table in ["emails","parcels","extractions","parcel_items","sample_generations","claude_usage_daily","claude_call_claims"]:
    assert scalar("select count(*) from public.%s where user_id='%s'" % (table,deleting_user))=="0", table
assert scalar("select jsonb_agg(to_jsonb(c) order by day) from public.claude_usage_daily c where user_id='%s'" % other)==other_costs
assert int(scalar("select coalesce(sum(calls),0) from public.claude_usage_daily"))==total_calls_before
assert int(scalar("select coalesce(sum(calls),0) from public.claude_usage_daily where user_id is null"))==null_calls_before+deleted_calls
passed("auth deletion and a generation-first writer complete without deadlock, atomically cascade target data and retain deleted calls anonymously without changing the global total or another user's count")

run(as_service("update public.parcels set received_at=null where id='%s';" % new_parcel, user, new_generation))
receiving = hold(as_service(receive, user, new_generation))
receive_clear = psql_process(base + ["-d", database, "-c", "set application_name='b5_receive_clear_wait';" + as_service("select public.clear_all_parcels('%s');" % user)], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
wait_for_lock("b5_receive_clear_wait")
commit(receiving)
receive_clear_out, receive_clear_error = receive_clear.communicate(timeout=10)
assert receive_clear.returncode == 0, receive_clear_error
assert scalar("select count(*) from public.parcels where user_id='%s'" % user) == "0"
new_generation = receive_clear_out.strip().splitlines()[-1]
passed("receive RPC and clear use generation then parcel order without deadlock")

held_parcel = str(uuid.uuid4())
writer = hold(as_service("insert into public.parcels(id,user_id,shop) values ('%s','%s','In-flight sample');" % (held_parcel, user), user, new_generation))
clear = psql_process(base + ["-d", database, "-c", "set application_name='b5_clear_wait';" + as_service("select public.clear_all_parcels('%s');" % user)], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
wait_for_lock("b5_clear_wait")
commit(writer)
clear_out, clear_error = clear.communicate(timeout=10)
assert clear.returncode == 0, clear_error
assert scalar("select count(*) from public.parcels where user_id='%s'" % user) == "0"
passed("clear waits for an in-flight write and then deletes it")
latest = clear_out.strip().splitlines()[-1]
clearing = hold(as_service("select public.clear_all_parcels('%s');" % user))
late = psql_process(base + ["-d", database, "-c", "set application_name='b5_write_wait';" + as_service("insert into public.parcels(user_id,shop) values ('%s','Delayed sample');" % user, user, latest)], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
wait_for_lock("b5_write_wait")
commit(clearing)
late_out, late_error = late.communicate(timeout=10)
assert late.returncode != 0 and "55000" in late_error, late_error
assert scalar("select count(*) from public.parcels where user_id='%s'" % user) == "0"
passed("write waiting behind clear sees the new generation and cannot insert")

real_email, real_lease = str(uuid.uuid4()), str(uuid.uuid4())
assert run(as_service(store(user, real_email, real_lease, "synthetic-real-in-flight"))) == "ok"
real_writer = hold(as_service(owned(real_email, real_lease, "parcels", "insert", {"user_id": user, "shop": "In-flight real-mail control"})))
real_clear = psql_process(base + ["-d", database, "-c", "set application_name='b5_real_clear_wait';" + as_service("select public.clear_all_parcels('%s');" % user)], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
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
