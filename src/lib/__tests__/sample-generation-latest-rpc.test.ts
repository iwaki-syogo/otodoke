import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The real SQL concurrency checks live in scripts/test-sample-generation.py. This source guard
 * only catches a later migration replacing a public gateway without its generation boundary.
 * It is not a proof that a function, its branches, permissions or transactions work at runtime.
 */
type Migration = { name: string; sql: string };
type Definition = { migration: string; header: string; body: string; sql: string };
const RPCS = ["store_mail_run", "mail_run_write", "create_mail_parcel", "update_mail_parcel", "ensure_mail_parcel_items", "receive_sample_parcels", "clear_all_parcels", "claim_ai_reading_backlog", "release_claude_call", "claim_claude_call", "claim_claude_call_v2"] as const;
type Rpc = typeof RPCS[number];

function latestDefinitions(migrations: Migration[]): Map<string, Definition> {
  const definitions = new Map<string, Definition>();
  for (const migration of [...migrations].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
    const sql = migration.sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");
    const pattern = /create\s+(?:or\s+replace\s+)?function\s+public\.(\w+)\s*(\([\s\S]*?\bas\s+(\$[\w]*\$))([\s\S]*?)\3\s*;/gi;
    const creates = [...sql.matchAll(pattern)];
    const renames = [...sql.matchAll(/alter\s+function\s+public\.(\w+)\s*\([^;]*?\)\s+rename\s+to\s+(\w+)\s*;/gi)]
      .filter((rename) => !creates.some((create) => rename.index! >= create.index! && rename.index! < create.index! + create[0].length));
    // DO-block renames execute during a migration; renames inside a function body do not.
    const events = [...creates.map((match) => ({ kind: "create" as const, match })),
      ...renames.map((match) => ({ kind: "rename" as const, match }))].sort((a, b) => a.match.index! - b.match.index!);
    for (const { kind, match } of events) {
      if (kind === "create") definitions.set(match[1].toLowerCase(), {
        migration: migration.name, header: match[2].toLowerCase().replace(/\s+/g, " "),
        body: match[4].toLowerCase().replace(/\s+/g, " "), sql: match[0],
      });
      else {
        const oldName = match[1].toLowerCase(), newName = match[2].toLowerCase();
        const previous = definitions.get(oldName);
        if (previous) {
          definitions.delete(oldName);
          definitions.set(newName, { ...previous, migration: migration.name,
            sql: previous.sql.replace(new RegExp(`(function\\s+public\\.)${oldName}\\b`, "i"), `$1${newName}`) });
        }
      }
    }
  }
  return definitions;
}

const secure = (definition: Definition | undefined) => Boolean(definition && /language plpgsql security definer set search_path\s*=\s*''/.test(definition.header));

function orderedIn(body: string, ...patterns: RegExp[]) {
  let next = 0;
  for (const pattern of patterns) {
    const match = body.slice(next).match(pattern);
    if (!match || match.index === undefined) return false;
    next += match.index + match[0].length;
  }
  return true;
}

function consentClaimPrefix(definitions: Map<string, Definition>, name: "claim_claude_call" | "claim_claude_call_v2"): boolean {
  const definition = definitions.get(name), owner = definitions.get("lock_sample_owner"), consent = definitions.get("assert_claude_claim_consent");
  const preserved = definitions.get(`${name}_before_consent_guard`);
  if (!secure(definition) || !secure(owner) || !secure(consent) || !secure(preserved)) return false;
  const ownerPrefix = orderedIn(owner!.body,
    /perform id from auth\.users where id\s*=\s*p_user_id for key share/,
    /insert into public\.sample_generations\(user_id\)/,
    /perform generation from public\.sample_generations where user_id\s*=\s*p_user_id for update/,
  );
  const lockedConsent = orderedIn(consent!.body,
    /select c\.decision into v_decision from public\.ai_reading_consents c where c\.user_id\s*=\s*p_user_id for share/,
    /if not found or v_decision is distinct from 'granted'/,
    /raise exception 'ai_consent_required' using errcode\s*=\s*'42501'/,
  );
  const entry = orderedIn(definition!.body,
    /perform public\.lock_sample_owner\(p_user_id\)/,
    /perform public\.assert_claude_claim_consent\(p_user_id\)/,
    new RegExp(`return (?:query select \\* from )?public\\.${name}_before_consent_guard\\(`),
  );
  if (!ownerPrefix || !lockedConsent || !entry) return false;
  if (name === "claim_claude_call") return orderedIn(preserved!.body,
    /perform pg_catalog\.pg_advisory_xact_lock\(62801,/,
    /select coalesce\(calls, 0\)/,
    /insert into public\.claude_usage_daily/,
  );
  const core = definitions.get("claim_claude_call_v2_without_sample_fence");
  return secure(core) && orderedIn(preserved!.body,
    /perform id from auth\.users where id\s*=\s*p_user_id for key share/,
    /return query select \* from public\.claim_claude_call_v2_without_sample_fence\(/,
  ) && orderedIn(core!.body,
    /v_verdict\s*:=\s*public\.claim_claude_call\(/,
    /insert into public\.claude_call_claims/,
  ) && consentClaimPrefix(definitions, "claim_claude_call");
}

function violations(definitions: Map<string, Definition>, rpc: Rpc): string[] {
  const definition = definitions.get(rpc);
  if (!definition) return [`${rpc}: missing definition`];
  const bad: string[] = [];
  const require = (test: boolean, message: string) => { if (!test) bad.push(`${rpc}: ${message} (${definition.migration})`); };
  const body = definition.body;
  require(/language plpgsql security definer set search_path\s*=\s*''/.test(definition.header), "private search path and definer boundary");
  const ordered = (...patterns: RegExp[]) => orderedIn(body, ...patterns);
  if (rpc === "store_mail_run") {
    require(ordered(
      /perform public\.lock_sample_owner\(p_user_id\)/,
      /perform public\.assert_sample_generation\(p_user_id,\s*coalesce\(p_columns\s*->>\s*'provider_email_id'\s+like\s+'demo:%',\s*false\)\)/,
      /public\.store_mail_run_without_sample_fence\(/,
    ), "generation lock and sample fence before the intake gateway");
  } else if (["mail_run_write", "create_mail_parcel", "update_mail_parcel", "ensure_mail_parcel_items"].includes(rpc)) {
    require(ordered(
      /select user_id,\s*coalesce\(provider_email_id like 'demo:%',\s*false\) into v_user_id,\s*v_sample from public\.emails where id\s*=\s*p_email_id/,
      /perform public\.lock_sample_owner\(v_user_id\)/,
      /perform public\.assert_sample_generation\(v_user_id,\s*coalesce\(v_sample,\s*false\)\)/,
      new RegExp(`public\\.${rpc}_without_sample_fence\\(`),
    ), "owner lookup then generation lock and fence before the mail gateway");
  } else if (rpc === "claim_ai_reading_backlog") {
    require(ordered(
      /perform id from auth\.users where id\s*=\s*p_user_id for key share/,
      /perform user_id from public\.ai_reading_consents where user_id\s*=\s*p_user_id for update/,
      /public\.claim_ai_reading_backlog_without_sample_fence\(/,
    ), "auth parent then consent lock before the preserved automatic claim");
  } else if (rpc === "claim_claude_call") {
    require(consentClaimPrefix(definitions, rpc), "auth/generation and consent before the preserved cost gateway");
  } else if (rpc === "claim_claude_call_v2" && body.includes("_before_consent_guard(")) {
    require(consentClaimPrefix(definitions, rpc), "auth/generation and consent before the preserved cost gateway and nested v1 re-entry");
  } else if (rpc === "release_claude_call" || rpc === "claim_claude_call_v2") {
    require(ordered(
      /perform id from auth\.users where id\s*=\s*p_user_id for key share/,
      new RegExp(`return (?:query select \\* from )?public\\.${rpc}_without_sample_fence\\(`),
    ), "auth parent lock before the preserved cost gateway");
  } else if (rpc === "receive_sample_parcels") {
    require(ordered(
      /perform public\.lock_sample_owner\(p_user_id\)/,
      /perform public\.assert_sample_generation\(p_user_id,\s*true\)/,
      /update public\.parcels p set received_at\s*=\s*p_received_at/,
    ), "generation lock and required fence before the parcel update");
    require(/p\.user_id\s*=\s*p_user_id/.test(body) && /e\.provider_email_id like 'demo:%'/.test(body), "only this user's linked sample parcels");
  } else {
    require(ordered(
      /select generation into v_generation from public\.sample_generations where user_id\s*=\s*p_user_id for update/,
      /update public\.sample_generations set generation\s*=\s*gen_random_uuid\(\) where user_id\s*=\s*p_user_id/,
      /perform id from public\.emails where user_id\s*=\s*p_user_id order by id for update/,
      /delete from public\.parcels where user_id\s*=\s*p_user_id/,
      /delete from public\.emails where user_id\s*=\s*p_user_id/,
      /return v_generation/,
    ), "one function locks, invalidates, deletes both tables, and then returns");
    require(!/\b(?:commit|rollback)\s*;/.test(body), "no transaction split inside clear");
  }
  return bad;
}

const directory = new URL("../../../supabase/migrations/", import.meta.url);
const migrations: Migration[] = readdirSync(directory).filter((name) => name.endsWith(".sql"))
  .map((name) => ({ name, sql: readFileSync(new URL(name, directory), "utf8") }));
const current = latestDefinitions(migrations);

function unguardedReplacement(rpc: Rpc): string {
  const returned = rpc === "claim_ai_reading_backlog" ? "return false;" : rpc === "release_claude_call" ? "return 0;" : rpc === "claim_claude_call" ? "return 'ok';"
    : rpc === "store_mail_run" || rpc === "receive_sample_parcels" || rpc === "claim_claude_call_v2" || ["create_mail_parcel", "update_mail_parcel", "ensure_mail_parcel_items"].includes(rpc) ? "return;"
    : rpc === "mail_run_write" ? "return '[]'::jsonb;" : "return gen_random_uuid();";
  // Preserve the real signature: a zero-argument function would be an overload, not a replacement.
  return current.get(rpc)!.sql.replace(/\bas\s+(\$[\w]*\$)[\s\S]*?\1\s*;$/i,
    () => `as $replacement$ begin ${returned} end $replacement$;`);
}

describe("latest public RPC definitions keep the sample generation boundary", () => {
  it.each(RPCS)("the latest %s definition retains the required integration contract", (rpc) => {
    expect(violations(current, rpc)).toEqual([]);
  });

  it.each(RPCS)("negative control: a later unguarded %s replacement is caught", (rpc) => {
    // Deliberately unsafe fixture, never executed against a database.
    const replacement = unguardedReplacement(rpc);
    const changed = latestDefinitions([...migrations, { name: "99999999999999_unfenced_gateway.sql", sql: replacement }]);
    expect(changed.get(rpc)?.migration).toBe("99999999999999_unfenced_gateway.sql");
    expect(violations(changed, rpc).some((message) => /before|one function/.test(message))).toBe(true);
  });

  it.each(RPCS)("positive control: a later guarded %s definition is accepted", (rpc) => {
    const definition = current.get(rpc)!;
    const guarded = definition.sql.replace(/\$\$/g, "$guarded$").replace(/\bperform\b/gi, "\n  PERFORM\n");
    const changed = latestDefinitions([{ name: "99999999999999_guarded_gateway.sql", sql: guarded }, ...migrations]);
    expect(changed.get(rpc)?.migration).toBe("99999999999999_guarded_gateway.sql");
    expect(violations(changed, rpc)).toEqual([]);
  });

  it("uses the final definition within a later migration, even when an earlier one is guarded", () => {
    const guarded = current.get("clear_all_parcels")!.sql;
    const unsafe = unguardedReplacement("clear_all_parcels");
    const changed = latestDefinitions([...migrations, { name: "99999999999999_replaced_twice.sql", sql: `${guarded}\n${unsafe}` }]);
    expect(violations(changed, "clear_all_parcels")).not.toEqual([]);
  });

  it("preserves the real old v2 wrapper/core when later migrations rename them", () => {
    const before = latestDefinitions(migrations.filter((migration) => migration.name < "20261113121000"));
    expect(current.get("claim_claude_call_v2_before_consent_guard")?.body).toBe(before.get("claim_claude_call_v2")?.body);
    expect(current.get("claim_claude_call_v2_without_sample_fence")?.body).toContain("v_verdict := public.claim_claude_call(");
  });

  it("keeps the legacy direct Auth-prefix route when the consent wrappers are not installed", () => {
    const previous = latestDefinitions(migrations.filter((migration) => migration.name < "20261113121000"));
    expect(violations(previous, "claim_claude_call_v2")).toEqual([]);
  });

  it.each(["lock_sample_owner", "claim_claude_call_v2_before_consent_guard", "claim_claude_call_v2_without_sample_fence"])("negative control: an unguarded nested %s is caught", (name) => {
    const definition = current.get(name)!;
    const replacement = name === "lock_sample_owner"
      ? definition.sql.replace(/perform id from auth\.users where id\s*=\s*p_user_id for key share\s*;/i, "")
      : definition.sql.replace(/\bas\s+(\$[\w]*\$)[\s\S]*?\1\s*;$/i, "as $replacement$ begin return; end $replacement$;");
    const changed = latestDefinitions([...migrations, { name: "99999999999999_unguarded_nested.sql", sql: replacement }]);
    expect(violations(changed, "claim_claude_call_v2")).not.toEqual([]);
  });
});
