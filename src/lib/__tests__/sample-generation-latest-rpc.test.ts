import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The real SQL concurrency checks live in scripts/test-sample-generation.py. This source guard
 * only catches a later migration replacing a public gateway without its generation boundary.
 * It is not a proof that a function, its branches, permissions or transactions work at runtime.
 */
type Migration = { name: string; sql: string };
type Definition = { migration: string; header: string; body: string; sql: string };
const RPCS = ["store_mail_run", "mail_run_write", "create_mail_parcel", "update_mail_parcel", "ensure_mail_parcel_items", "receive_sample_parcels", "clear_all_parcels", "claim_ai_reading_backlog", "release_claude_call", "claim_claude_call_v2"] as const;
type Rpc = typeof RPCS[number];

function latestDefinitions(migrations: Migration[]): Map<string, Definition> {
  const definitions = new Map<string, Definition>();
  for (const migration of [...migrations].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
    const sql = migration.sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");
    const pattern = /create\s+(?:or\s+replace\s+)?function\s+public\.(\w+)\s*(\([\s\S]*?\bas\s+(\$[\w]*\$))([\s\S]*?)\3\s*;/gi;
    for (const match of sql.matchAll(pattern)) definitions.set(match[1].toLowerCase(), {
      migration: migration.name, header: match[2].toLowerCase().replace(/\s+/g, " "),
      body: match[4].toLowerCase().replace(/\s+/g, " "), sql: match[0],
    });
  }
  return definitions;
}

function violations(definitions: Map<string, Definition>, rpc: Rpc): string[] {
  const definition = definitions.get(rpc);
  if (!definition) return [`${rpc}: missing definition`];
  const bad: string[] = [];
  const require = (test: boolean, message: string) => { if (!test) bad.push(`${rpc}: ${message} (${definition.migration})`); };
  const body = definition.body;
  require(/language plpgsql security definer set search_path\s*=\s*''/.test(definition.header), "private search path and definer boundary");
  const ordered = (...patterns: RegExp[]) => {
    let next = 0;
    for (const pattern of patterns) {
      const match = body.slice(next).match(pattern);
      if (!match || match.index === undefined) return false;
      next += match.index + match[0].length;
    }
    return true;
  };
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
  const returned = rpc === "claim_ai_reading_backlog" ? "return false;" : rpc === "release_claude_call" ? "return 0;"
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
});
