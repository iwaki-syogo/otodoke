"""Verify sample fencing's full local lifecycle, including the real preceding verifiers.

Only connects to loopback. --prerequisites-ref must pin an already available local Git commit;
it never fetches, merges, or writes another checkout. No app credentials or real mail are used.
The fresh test databases are retained for inspection until the dedicated test server is removed.
"""
import argparse
import hashlib
import json
import os
import tempfile
import re
import shutil
import subprocess
import uuid
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("--port", type=int, required=True)
parser.add_argument("--psql", default=shutil.which("psql"))
parser.add_argument("--user", default="postgres")
parser.add_argument("--prerequisites-ref", required=True)
args = parser.parse_args()
if not args.psql or not re.fullmatch(r"[0-9a-f]{40}", args.prerequisites_ref):
    parser.error("psql and a full local Git commit SHA are required")
root = Path(__file__).resolve().parents[1]
database = "otodoke_b5_lifecycle_" + uuid.uuid4().hex[:10]
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
phases = []
hashes = {}


def source(path, pinned=False):
    if pinned:
        result = subprocess.run(["git", "-C", str(root), "show", args.prerequisites_ref + ":" + path], capture_output=True, check=True)
        data = result.stdout
        hashes[path] = hashlib.sha256(data).hexdigest()
    else:
        data = (root / path).read_bytes()
    return data.decode()


def run(sql, *, db=None, fail=False):
    result = subprocess.run(base + ["-d", db or database], input=sql, text=True, capture_output=True, timeout=20, env=psql_environment)
    if fail:
        assert result.returncode != 0, "expected SQL rejection"
        return result.stderr
    assert result.returncode == 0, result.stderr
    return result.stdout.strip()


def result(sql, *, db=None, prefix="", suffix=""):
    # Execute every DO statement and every original check, wrapping only the final result so the
    # assertion reads named fields instead of guessing the position of a verdict column.
    matches = list(re.finditer(r"(?im)^with (?:checks|inventory) as \(", sql))
    assert matches, "verifier must have a final checks query"
    at = matches[-1].start()
    query = sql[at:].rstrip().removesuffix(";")
    output = run(prefix + sql[:at] + "select row_to_json(verified) from (" + query + ") verified;" + suffix, db=db)
    rows = output.splitlines()
    assert len(rows) == 1, "verifier must emit exactly one final result"
    return json.loads(rows[0])


def passed(name):
    checks.append(name)


def verify(sql, phase, *, db=None, expected="OK"):
    row = result(sql, db=db)
    assert row["verdict"] == expected, (phase, row)
    phases.append({"phase": phase, "result": row})
    return row


prior_names = ["20261112180000_ai_reading_consent", "20261112181000_ai_consent_auto_read", "20261113090000_claude_call_global_lock", "20261113100000_parcel_write_conflicts"]
prior_migrations = {name: source("supabase/migrations/" + name + ".sql", True) for name in prior_names}
prior_verifiers = {name: source("supabase/verify/" + name + ".sql", True) for name in prior_names}
before = source("supabase/verify/20261113110000_sample_generation.before.sql")
forward = source("supabase/migrations/20261113110000_sample_generation.sql")
after = source("supabase/verify/20261113110000_sample_generation.sql")
down = source("supabase/rollback/20261113110000_sample_generation.down.sql")

run("create database " + database, db="postgres")
run("""
do $$ begin
  if not exists(select 1 from pg_roles where rolname='anon') then create role anon; end if;
  if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated; end if;
  if not exists(select 1 from pg_roles where rolname='service_role') then create role service_role bypassrls; end if;
end $$;
create schema auth;
create table auth.users(id uuid primary key);
-- Supabase's JWT-subject behaviour, including the empty subject used by the actual verifiers.
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid
$$;
grant usage on schema auth to anon, authenticated, service_role;
""")
baseline = [
    "20261102090000_init.sql", "20261102100000_ordered_at_date.sql", "20261102110000_claude_usage_limit.sql",
    "20261103090000_expected_date_end.sql", "20261103130000_parcel_category_source.sql",
    "20261106120000_mail_encryption_keys.sql", "20261106190000_claude_usage_keeps_deleted_calls.sql", "20261112020000_claude_call_release.sql", "20261112100000_parcel_received_at.sql",
]
for name in baseline:
    run(source("supabase/migrations/" + name))
run("grant all on all tables in schema public to service_role; grant usage,select on all sequences in schema public to service_role;")
assert verify(before, "prefix 000 before", expected="FAILED")["required_store_mail_run_present"] is False


def schema_catalog(db=None):
    return json.loads(run("""select jsonb_build_object(
      'relations',(select jsonb_agg(jsonb_build_object('oid',c.oid::bigint,'name',c.relname,'kind',c.relkind,'owner',c.relowner::bigint,'acl',c.relacl::text,'rls',c.relrowsecurity) order by c.oid)
        from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public'),
      'functions',(select jsonb_agg(jsonb_build_object('oid',p.oid::bigint,'definition',pg_get_functiondef(p.oid),'acl',p.proacl::text) order by p.oid)
        from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prokind='f'),
      'attributes',(select jsonb_agg(to_jsonb(a) order by a.attrelid,a.attnum) from pg_attribute a join pg_class c on c.oid=a.attrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and a.attnum>0),
      'triggers',(select jsonb_agg(to_jsonb(t) order by t.oid) from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' or (n.nspname='auth' and c.relname='users'))
    );""", db=db))


def missing_dependencies_unchanged(label):
    snapshot = schema_catalog()
    error = run(forward, fail=True)
    assert schema_catalog() == snapshot, "failed dependency preflight must not change any public schema object"
    assert "sample_generation requires" in error, (label, "forward must explain its missing dependencies before any DDL")


missing_dependencies_unchanged("missing cost and parcel gateways")
run(prior_migrations[prior_names[0]])
verify(prior_verifiers[prior_names[0]], "180000 applied and verified")
row = verify(before, "prefix 100 before", expected="FAILED")
assert row["consent_state"] == "present" and row["auto_read_state"] == "pending_with_prior_migrations"

# Deliberately invalid ordering belongs only to this cloned scratch database.
hole_db = database + "_hole"
run("create database " + hole_db + " with template " + database, db="postgres")
run(prior_migrations[prior_names[2]], db=hole_db)
assert verify(before, "negative: prefix 101 refused", db=hole_db, expected="FAILED")["prior_prefix_ok"] is False
passed("before requires installed gateways and rejects an ordering hole")

run(prior_migrations[prior_names[1]])
verify(prior_verifiers[prior_names[1]], "181000 applied and verified")
row = verify(before, "prefix 110 before", expected="FAILED")
assert row["auto_read_state"] == "present" and row["prerequisite_state"] == "pending_with_prior_migrations"
run(prior_migrations[prior_names[2]])
verify(prior_verifiers[prior_names[2]], "13090000 applied and verified")
row = verify(before, "cost present but parcel gateway missing", expected="FAILED")
assert row["required_store_mail_run_present"] is True and row["required_parcel_gateways_present"] is False
missing_dependencies_unchanged("parcel gateway missing")
run(prior_migrations[prior_names[3]])
verify(prior_verifiers[prior_names[3]], "13100000 applied and verified")
row = verify(before, "all four prerequisites before")
assert row["prerequisite_state"] == "present" and row["required_parcel_gateways_present"] is True and row["sample_absent"] is True
passed("missing dependencies fail read-only before and forward without schema changes")

privilege_before = schema_catalog()
row = result(before,prefix="begin;set local role service_role;",suffix="rollback;")
assert row["verdict"]=="FAILED" and row["can_create_auth_delete_trigger"] is False
assert schema_catalog()==privilege_before
assert "sample_generation requires TRIGGER privilege on auth.users" in run("set role service_role;"+forward,fail=True)
assert schema_catalog()==privilege_before
phases.append({"phase":"negative: missing Auth trigger privilege", "result":row})
passed("insufficient Auth trigger privilege fails before and forward without changes or automatic grants")


# Missing parts, unknown code and extra overloads cannot be mistaken for a valid empty install.
probes = [
    ("partial preceding migration", "alter table public.emails drop column processing_run_id;"),
    ("partial consent columns", "alter table public.ai_reading_consents drop column text_version;"),
    ("wrong lease column type", "alter table public.emails alter column processing_run_id type text;"),
    ("unexpected overload", "create function public.store_mail_run(uuid) returns void language plpgsql as $$ begin return; end $$;"),
]
for name, sql in probes:
    row = result(before, prefix="begin;" + sql, suffix="rollback;")
    assert row["verdict"] == "FAILED", name
    phases.append({"phase": "negative: " + name, "result": row})
passed("before rejects partial prerequisites and extra overloads")

user, other = str(uuid.uuid4()), str(uuid.uuid4())
mail, parcel = str(uuid.uuid4()), str(uuid.uuid4())
run("""
insert into auth.users(id) values ('%s'),('%s');
insert into public.ai_reading_consents(user_id,decision,text_version) values ('%s','granted','synthetic-version');
insert into public.ai_consent_read_runs(user_id,consent_decided_at) select user_id,decided_at from public.ai_reading_consents where user_id='%s';
insert into public.emails(id,user_id,provider_email_id,processing_status,subject,text_body) values ('%s','%s','demo:synthetic/lifecycle','failed','Synthetic subject','Synthetic body');
insert into public.parcels(id,user_id,shop,title,status,total_amount) values ('%s','%s','Synthetic shop','Synthetic parcel','delivered',1234);
insert into public.parcel_items(user_id,parcel_id,name,quantity) values ('%s','%s','Synthetic item',2);
insert into public.extractions(user_id,email_id,parcel_id,model,result) values ('%s','%s','%s','synthetic','{}');
insert into public.mail_intake_notices(user_id,reason) values ('%s','user_storage_limit');
select verdict from public.claim_claude_call_v2('%s',10,2147483647);
""" % (user, other, user, user, mail, user, parcel, user, user, parcel, user, mail, parcel, user, user))


def saved_data(db=None):
    tables = ["auth.users", "public.ai_reading_consents", "public.ai_consent_read_runs", "public.emails", "public.parcels", "public.parcel_items", "public.extractions", "public.mail_intake_notices", "public.claude_usage_daily", "public.claude_call_claims"]
    return {table: json.loads(run("select coalesce(jsonb_agg(to_jsonb(r)-'sample_generation' order by (to_jsonb(r)-'sample_generation')::text),'[]') from " + table + " r;", db=db)) for table in tables}


def gateway_catalog():
    return json.loads(run("""select jsonb_object_agg(proname,jsonb_build_object('oid',oid::bigint,'body',prosrc,'owner',proowner::bigint,
      'security_definer',prosecdef,'path',proconfig,'args',proargnames,'argtypes',proargtypes::text,'result',pg_get_function_result(oid),'acl',proacl::text))
      from pg_proc where oid in (to_regprocedure('public.store_mail_run(uuid,uuid,uuid,jsonb,timestamptz,jsonb)'),to_regprocedure('public.mail_run_write(uuid,uuid,text,text,jsonb,jsonb)'),
      to_regprocedure('public.create_mail_parcel(jsonb,jsonb,jsonb,uuid,uuid)'),to_regprocedure('public.update_mail_parcel(jsonb,uuid,timestamptz,jsonb,jsonb,jsonb,uuid,uuid)'),
      to_regprocedure('public.ensure_mail_parcel_items(uuid,timestamptz,jsonb,uuid,uuid)'),to_regprocedure('public.lock_parcel_candidates()'),to_regprocedure('public.claim_ai_reading_backlog(uuid,timestamptz)'),to_regprocedure('public.release_claude_call(bigint,uuid)'),to_regprocedure('public.claim_claude_call_v2(uuid,integer,integer)'));"""))


def installed_catalog(db):
    return json.loads(run("""select jsonb_build_object(
      'functions',(select jsonb_agg(jsonb_build_object('oid',p.oid::bigint,'definition',pg_get_functiondef(p.oid),'acl',p.proacl::text) order by p.oid)
        from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in (
          'store_mail_run','mail_run_write','begin_sample_load','clear_all_parcels','receive_sample_parcels','lock_sample_owner','assert_sample_generation','fence_sample_write',
          'store_mail_run_without_sample_fence','mail_run_write_without_sample_fence',
          'create_mail_parcel','update_mail_parcel','ensure_mail_parcel_items','lock_parcel_candidates','prelock_sample_request','prelock_sample_statement','prelock_sample_owner_delete',
          'create_mail_parcel_without_sample_fence','update_mail_parcel_without_sample_fence','ensure_mail_parcel_items_without_sample_fence','claim_ai_reading_backlog','claim_ai_reading_backlog_without_sample_fence','release_claude_call','release_claude_call_without_sample_fence','claim_claude_call_v2','claim_claude_call_v2_without_sample_fence')),
      'triggers',(select jsonb_agg(to_jsonb(t) order by t.oid) from pg_trigger t where tgname in ('sample_generation_fence','sample_generation_statement_fence','parcels_candidate_write_lock','parcel_items_candidate_write_lock','sample_generation_owner_delete')),
      'column',(select jsonb_agg(to_jsonb(a) order by a.attnum) from pg_attribute a where a.attrelid=to_regclass('public.emails') and a.attname='sample_generation' and not a.attisdropped),
      'generations',(select jsonb_agg(to_jsonb(g) order by g.user_id) from public.sample_generations g),
      'mail_metadata',(select jsonb_agg(jsonb_build_object('id',id,'generation',sample_generation) order by id) from public.emails)
    );""", db=db))


saved = saved_data()
catalog = gateway_catalog()
# Preserve the known implementation and ABI while changing only the ACL. Legitimate custom
# ACLs require a reviewed gate update; neither migration may silently discard or retain them.
acl_role="sample_acl_probe_"+uuid.uuid4().hex[:12]
run("create role "+acl_role+" nologin;",db="postgres")
acl_probes=[("grant_option","grant execute on function public.store_mail_run(uuid,uuid,uuid,jsonb,timestamptz,jsonb) to service_role with grant option;"),
    ("custom_role","grant execute on function public.store_mail_run(uuid,uuid,uuid,jsonb,timestamptz,jsonb) to "+acl_role+";")]
for label,grant in acl_probes:
    acl_db=database+"_before_acl_"+label
    run("create database "+acl_db+" with template "+database,db="postgres")
    run(grant,db=acl_db)
    acl_catalog,acl_data=schema_catalog(acl_db),saved_data(acl_db)
    row=verify(before,"negative: before ACL "+label,db=acl_db,expected="FAILED")
    assert row["expected_function_acls_ok"] is False
    assert schema_catalog(acl_db)==acl_catalog and saved_data(acl_db)==acl_data
    assert "nonstandard function ACL" in run(forward,db=acl_db,fail=True)
    assert schema_catalog(acl_db)==acl_catalog and saved_data(acl_db)==acl_data
passed("nonstandard grant-option and custom-role ACLs fail before and forward without catalog/data changes")
run(forward)
verify(after, "sample applied")
for name, sql in prior_verifiers.items():
    verify(sql, "after first sample apply: " + name)
assert verify(before, "negative: already installed is not a fresh before", expected="FAILED")["sample_absent"] is False
assert saved_data() == saved
passed("forward retains all representative saved data")

# An external SQL dependency is not ours to remove. DROP RESTRICT must abort the entire down.
dependency_db = database + "_dependency"
run("create database " + dependency_db + " with template " + database, db="postgres")
run("create view public.synthetic_sample_dependency as select public.begin_sample_load(null::uuid) as generation;", db=dependency_db)
dependency_catalog = installed_catalog(dependency_db)
dependency_data = saved_data(dependency_db)
assert "2BP01" in run(down, db=dependency_db, fail=True)
assert installed_catalog(dependency_db) == dependency_catalog and saved_data(dependency_db) == dependency_data
passed("unknown dependency refuses rollback and retains every B5/core/data object")

# A missing proconfig must be false, not a NULL which bool_and silently skips.
path_db=database+"_missing_path"
run("create database "+path_db+" with template "+database,db="postgres")
run("alter function public.store_mail_run(uuid,uuid,uuid,jsonb,timestamptz,jsonb) reset search_path;",db=path_db)
path_catalog,path_data=schema_catalog(path_db),saved_data(path_db)
assert verify(after,"negative: missing gateway search_path",db=path_db,expected="FAILED")["secure_gateways"] is False
assert schema_catalog(path_db)==path_catalog and saved_data(path_db)==path_data
passed("after verifier refuses a NULL gateway search_path without changing catalog or saved data")

# Keep the real ABI but replace only the public body, modelling a later integration migration.
for rpc, returned in [("store_mail_run", "return;"), ("mail_run_write", "return '[]'::jsonb;"), ("create_mail_parcel", "return;"), ("update_mail_parcel", "return;"), ("ensure_mail_parcel_items", "return;"), ("claim_ai_reading_backlog", "return false;"), ("release_claude_call", "return 0;"), ("claim_claude_call_v2", "return;")]:
    changed_db = database + "_new_" + rpc
    run("create database " + changed_db + " with template " + database, db="postgres")
    definition = re.search(r"create or replace function public\." + rpc + r"\([\s\S]*?\bas \$\$[\s\S]*?\$\$;", forward)
    assert definition
    replaced = re.sub(r"\bas \$\$[\s\S]*?\$\$;", lambda _: "as $$ begin " + returned + " end $$;", definition.group(0))
    run(replaced, db=changed_db)
    changed_catalog, changed_data = installed_catalog(changed_db), saved_data(changed_db)
    assert "public sample wrapper changed" in run(down, db=changed_db, fail=True)
    assert installed_catalog(changed_db) == changed_catalog and saved_data(changed_db) == changed_data
passed("all eight unknown public wrappers refuse rollback without losing newer definitions or data")

# Test public wrappers, private cores/helpers, the candidate lock and the consent setter.
# Effective EXECUTE alone cannot distinguish these ACL mutations from the baseline.
for label,target,grant in [
    ("grant_option","public.store_mail_run(uuid,uuid,uuid,jsonb,timestamptz,jsonb)","service_role with grant option"),
    ("custom_core","public.store_mail_run_without_sample_fence(uuid,uuid,uuid,jsonb,timestamptz,jsonb)",acl_role),
    ("custom_helper","public.lock_sample_owner(uuid)",acl_role),
    ("custom_only","public.store_mail_run_without_sample_fence(uuid,uuid,uuid,jsonb,timestamptz,jsonb)",acl_role),
    ("custom_candidate","public.lock_parcel_candidates()",acl_role),
    ("custom_setter","public.set_ai_reading(text,text)",acl_role),
]:
    acl_db=database+"_down_acl_"+label
    run("create database "+acl_db+" with template "+database,db="postgres")
    run("grant execute on function "+target+" to "+grant+";",db=acl_db)
    if label=="custom_only":
        # Retain exactly one ACL row, matching the private baseline count. Membership must
        # reject this row explicitly; bool_and must never ignore a NULL comparison.
        run("revoke execute on function "+target+" from current_user;",db=acl_db)
        assert run("select count(*) from pg_proc p cross join lateral aclexplode(p.proacl) a where p.oid='"+target+"'::regprocedure;",db=acl_db)=="1"
    acl_catalog,acl_data=schema_catalog(acl_db),saved_data(acl_db)
    if label=="custom_only":
        assert "nonstandard function ACL" in run(forward,db=acl_db,fail=True)
        assert schema_catalog(acl_db)==acl_catalog and saved_data(acl_db)==acl_data
    assert "nonstandard function ACL" in run(down,db=acl_db,fail=True)
    assert schema_catalog(acl_db)==acl_catalog and saved_data(acl_db)==acl_data
passed("nonstandard ACLs on wrappers, cores, helpers, candidate lock and setter refuse rollback atomically")

# Keep the helper count and its standard ACL, breaking only its required signature.
helper_db=database+"_helper_signature"
run("create database "+helper_db+" with template "+database,db="postgres")
run("drop function public.begin_sample_load(uuid); create function public.begin_sample_load(text) returns uuid language plpgsql security definer set search_path='' as $$ begin return null; end $$; revoke all on function public.begin_sample_load(text) from public,anon,authenticated,service_role; grant execute on function public.begin_sample_load(text) to service_role;",db=helper_db)
helper_catalog,helper_data=schema_catalog(helper_db),saved_data(helper_db)
assert "required helper signature is missing" in run(down,db=helper_db,fail=True)
assert schema_catalog(helper_db)==helper_catalog and saved_data(helper_db)==helper_data
passed("same-count helper signature substitution with standard ACL refuses rollback atomically")

# A partial core rename must fail without deleting anything else, using the actual down file.
partial_db = database + "_partial"
run("create database " + partial_db + " with template " + database, db="postgres")
run("alter function public.mail_run_write_without_sample_fence(uuid,uuid,text,text,jsonb,jsonb) rename to synthetic_partial_core;", db=partial_db)
assert "partial core gateways" in run(down, db=partial_db, fail=True)
assert run("select count(*) from public.emails;", db=partial_db) == str(len(saved["public.emails"]))
passed("partial rollback refuses before any destructive cleanup")

run(down)
assert gateway_catalog() == catalog, "rollback must restore the original gateway OIDs, bodies, ABI, owner, settings and ACLs"
assert saved_data() == saved, "rollback must retain every representative saved row"
for name, sql in prior_verifiers.items():
    verify(sql, "after rollback: " + name)
row = verify(before, "after rollback before")
assert row["prerequisite_state"] == "present" and row["sample_absent"] is True
passed("rollback restores exact core catalogs and preserves saved data")
passed("all four preceding real verifiers remain OK after rollback")

# Old sample reservations and the older application's two-DELETE clear path work again. The
# probes are rolled back, so this lifecycle check itself never consumes the representative data.
legacy = """begin; set local role service_role;
select verdict from public.store_mail_run('%s',gen_random_uuid(),gen_random_uuid(),
  '{"provider_email_id":"demo:synthetic/legacy-probe","processing_status":"pending"}',null,
  '{"user_count":1000,"global_count":10000,"user_bytes":1000000,"global_bytes":10000000}');
delete from public.parcels where user_id='%s'; delete from public.emails where user_id='%s';
select (select count(*) from public.parcels where user_id='%s')+(select count(*) from public.emails where user_id='%s'); rollback;""" % (user,user,user,user,user)
assert run(legacy).splitlines() == ["ok", "0"]
assert saved_data() == saved
passed("old headerless sample reservation and two-DELETE clear restored without removing saved rows")

# A rollback which silently removes the previous owned-writer guard is caught by both the new
# before gate and the real prior verifier. This is a temporary function replacement, rolled back.
original = prior_migrations[prior_names[3]]
match = re.search(r"create or replace function public\.mail_run_write\([\s\S]*?\bas \$\$[\s\S]*?\$\$;", original)
assert match
unguarded = re.sub(r"\bas \$\$[\s\S]*?\$\$;", "as $$ begin return '[]'::jsonb; end $$;", match.group(0))
for label, sql in [("before", before), ("prior runtime verifier", prior_verifiers[prior_names[2]])]:
    row = result(sql, prefix="begin;" + unguarded, suffix="rollback;")
    assert row["verdict"] == "FAILED"
    phases.append({"phase": "negative: owned-write guard removed / " + label, "result": row})
assert gateway_catalog() == catalog and saved_data() == saved
passed("negative control: losing the preceding owned-write guard fails both verifiers")

run(down)
assert gateway_catalog() == catalog and saved_data() == saved
for name, sql in prior_verifiers.items():
    verify(sql, "after second rollback: " + name)
row = verify(before, "second rollback before")
assert row["prerequisite_state"] == "present" and row["sample_absent"] is True
passed("second rollback leaves prior RPCs and data intact")
passed("all four preceding real verifiers remain OK after the second rollback")
run(forward)
verify(after, "reapplied sample")
for name, sql in prior_verifiers.items():
    verify(sql, "after reapply: " + name)
assert saved_data() == saved
passed("reapplication and all five verifiers succeed with unchanged saved data")
print(json.dumps({"prerequisites_ref": args.prerequisites_ref, "sha256": hashes, "checks": checks, "phases": phases}, ensure_ascii=False))
