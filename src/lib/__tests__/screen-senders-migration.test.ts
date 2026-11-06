import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SHARED_MAIL_DOMAINS } from "@/lib/screen-senders";

/**
 * supabase/migrations/20261106180000 clears, once, the marks made on shared mail domains before
 * the code refused them, and its verify files count what is left. Their copies of the domain list
 * must be src/lib/screen-senders.ts's: a domain missing from the SQL would keep its old marks (and
 * their subjects) for good, ignored by the pipeline but never removed.
 *
 * If SHARED_MAIL_DOMAINS gains a domain later, marks on it made before need clearing too: write a
 * new migration for that, and list it here with its own copy.
 *
 * The SQL itself was run on a local Postgres 17 (pg_cron stubbed) on 2026-11-06: purge, schedule,
 * the one-off changes, and the verify files with their negative controls.
 */

const root = path.resolve(__dirname, "../../..");
const FILES = [
  "supabase/migrations/20261106180000_screen_events_daily_purge.sql",
  "supabase/verify/20261106180000_screen_events_daily_purge.before.sql",
  "supabase/verify/20261106180000_screen_events_daily_purge.sql",
];

/** The quoted domains between the markers, each copy of the list in the file. */
function sqlLists(sql: string): string[][] {
  const lists: string[][] = [];
  const re = /-- shared-mail-domains:start([\s\S]*?)-- shared-mail-domains:end/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql))) lists.push([...m[1].matchAll(/'([^']*)'/g)].map((x) => x[1]));
  return lists;
}

function sameDomains(list: string[]): boolean {
  return list.length === SHARED_MAIL_DOMAINS.length && [...list].sort().join(",") === [...SHARED_MAIL_DOMAINS].sort().join(",");
}

describe("the SQL copies of SHARED_MAIL_DOMAINS", () => {
  for (const file of FILES) {
    it(`${file} lists exactly the shared domains`, () => {
      const lists = sqlLists(readFileSync(path.join(root, file), "utf8"));
      expect(lists.length).toBeGreaterThanOrEqual(1);
      for (const list of lists) {
        expect([...list].sort()).toEqual([...SHARED_MAIL_DOMAINS].sort());
        expect(sameDomains(list)).toBe(true);
      }
    });
  }

  it("negative control: a copy missing a domain, or with one more, is caught", () => {
    expect(sameDomains(SHARED_MAIL_DOMAINS.slice(1))).toBe(false);
    expect(sameDomains([...SHARED_MAIL_DOMAINS.slice(1), "shop.example.test"])).toBe(false);
    expect(sqlLists("-- shared-mail-domains:start\n'gmail.com'\n-- shared-mail-domains:end")).toEqual([["gmail.com"]]);
  });

  it("the purge keeps marked rows and uses the same 14 days as the pipeline", () => {
    const sql = readFileSync(path.join(root, FILES[0]), "utf8");
    const purge = sql.slice(sql.indexOf("create or replace function public.purge_old_screen_events"), sql.indexOf("$$;"));
    expect(purge).toMatch(/created_at < now\(\) - interval '14 days'/);
    expect(purge).toMatch(/and flagged_at is null/);
    const pipeline = readFileSync(path.join(root, "src/lib/pipeline.ts"), "utf8");
    expect(pipeline).toContain("14 * 86_400_000");
  });
});
