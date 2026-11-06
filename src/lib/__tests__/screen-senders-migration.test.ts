import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SHARED_MAIL_DOMAINS, SHARED_MAIL_DOMAIN_SUFFIXES } from "@/lib/screen-senders";

/**
 * supabase/migrations/20261106180000 holds the shared-domain rule of src/lib/screen-senders.ts in
 * public.is_shared_mail_domain(): the daily purge treats a mark on such a domain as no mark
 * (review R3-4), and the migration clears those marks once. Its before-verify counts them with its
 * own copy (the function does not exist yet then). The copies must be screen-senders.ts's lists:
 * a domain missing from the SQL would keep its marks (and their subjects) for good, ignored by the
 * pipeline but never removed.
 *
 * If a list gains a domain later, marks on it made before need clearing too: the function changes
 * in a new migration, and that file is listed here.
 *
 * The SQL itself was run on a local Postgres 17 (pg_cron stubbed) on 2026-11-06: the rule on
 * made-up domains, the purge, the schedule, the one-off changes, the verify files and the rollback.
 */

const root = path.resolve(__dirname, "../../..");
const MIGRATION = "supabase/migrations/20261106180000_screen_events_daily_purge.sql";
const FILES = [MIGRATION, "supabase/verify/20261106180000_screen_events_daily_purge.before.sql"];

/** The quoted domains between the markers named `kind`, each copy in the file. */
function sqlLists(sql: string, kind: "shared-mail-domains" | "shared-mail-domain-suffixes"): string[][] {
  const lists: string[][] = [];
  const re = new RegExp(`-- ${kind}:start([\\s\\S]*?)-- ${kind}:end`, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql))) lists.push([...m[1].matchAll(/'([^']*)'/g)].map((x) => x[1]));
  return lists;
}

const same = (list: string[], expected: readonly string[]) => list.length === expected.length && [...list].sort().join(",") === [...expected].sort().join(",");

describe("the SQL copies of the shared-domain lists", () => {
  for (const file of FILES) {
    it(`${file}: exactly SHARED_MAIL_DOMAINS and SHARED_MAIL_DOMAIN_SUFFIXES`, () => {
      const sql = readFileSync(path.join(root, file), "utf8");
      const exact = sqlLists(sql, "shared-mail-domains");
      const suffixes = sqlLists(sql, "shared-mail-domain-suffixes");
      expect(exact).toHaveLength(1);
      expect(suffixes).toHaveLength(1);
      expect([...exact[0]].sort()).toEqual([...SHARED_MAIL_DOMAINS].sort());
      expect([...suffixes[0]].sort()).toEqual([...SHARED_MAIL_DOMAIN_SUFFIXES].sort());
    });
  }

  it("the after-verify reads the function, not a copy", () => {
    const sql = readFileSync(path.join(root, "supabase/verify/20261106180000_screen_events_daily_purge.sql"), "utf8");
    expect(sqlLists(sql, "shared-mail-domains")).toEqual([]);
    expect(sql).toContain("public.is_shared_mail_domain(from_domain)");
  });

  it("negative control: a copy missing a domain, or with one more, is caught", () => {
    expect(same(SHARED_MAIL_DOMAINS.slice(1), SHARED_MAIL_DOMAINS)).toBe(false);
    expect(same([...SHARED_MAIL_DOMAIN_SUFFIXES, "shop.example.test"], SHARED_MAIL_DOMAIN_SUFFIXES)).toBe(false);
    expect(sqlLists("-- shared-mail-domains:start\n'gmail.com'\n-- shared-mail-domains:end", "shared-mail-domains")).toEqual([["gmail.com"]]);
  });

  it("the purge removes a mark on a shared domain like no mark, and uses the same 14 days as the pipeline", () => {
    const sql = readFileSync(path.join(root, MIGRATION), "utf8");
    const purge = sql.slice(sql.indexOf("create or replace function public.purge_old_screen_events"));
    expect(purge.slice(0, purge.indexOf("$$;"))).toMatch(/created_at < now\(\) - interval '14 days'\s+and \(flagged_at is null or public\.is_shared_mail_domain\(from_domain\)\)/);
    expect(sql).toMatch(/where flagged_at is not null\s+and public\.is_shared_mail_domain\(from_domain\);/);
    expect(sql).toContain("Apply after the G2 code");
    const pipeline = readFileSync(path.join(root, "src/lib/pipeline.ts"), "utf8");
    expect(pipeline).toContain("14 * 86_400_000");
  });

  it("the rule in SQL matches its rule in TypeScript (exact for free mail, any subdomain for the providers)", () => {
    const fn = readFileSync(path.join(root, MIGRATION), "utf8");
    expect(fn).toContain("where d = s or right(d, length(s) + 1) = '.' || s");
    expect(fn).toContain("lower(rtrim(trim(coalesce(p_domain, '')), '.'))");
  });
});
