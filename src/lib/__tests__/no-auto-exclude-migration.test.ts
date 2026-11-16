import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { NO_AUTO_EXCLUDE_DOMAINS } from "@/lib/screen-senders";

/**
 * The domains the app never takes a parcel out from by itself live in two places: NO_AUTO_EXCLUDE_DOMAINS
 * in src/lib/screen-senders.ts (the ingestion's decision) and public.auto_exclusion_would_start() in the
 * database (what the "next time it is automatic" toast asks). If they differ, the toast says something the
 * ingestion does not do (or the other way round). The SQL is between the never-auto-domains markers.
 */
const root = path.resolve(__dirname, "../../..");
const MIGRATION = "supabase/migrations/20261117110000_parcel_exclusions_auto.sql";

/** The quoted domains between the markers, each copy in the file. */
function sqlLists(sql: string): string[][] {
  const lists: string[][] = [];
  const re = /-- never-auto-domains:start([\s\S]*?)-- never-auto-domains:end/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql))) lists.push([...m[1].matchAll(/'([^']*)'/g)].map((x) => x[1]));
  return lists;
}

describe("the SQL copy of the never-automatic domain list", () => {
  it("is exactly NO_AUTO_EXCLUDE_DOMAINS, once", () => {
    const lists = sqlLists(readFileSync(path.join(root, MIGRATION), "utf8"));
    expect(lists).toHaveLength(1);
    expect([...lists[0]].sort()).toEqual([...NO_AUTO_EXCLUDE_DOMAINS].sort());
  });

  it("negative control: a copy with another domain, or none, is caught", () => {
    const text = (domains: string[]) => `-- never-auto-domains:start\narray[${domains.map((d) => `'${d}'`).join(",")}]\n-- never-auto-domains:end`;
    expect([...sqlLists(text(["mail.yahoo.co.jp", "shop.example.test"]))[0]].sort()).not.toEqual([...NO_AUTO_EXCLUDE_DOMAINS].sort());
    expect(sqlLists(text([]))[0]).not.toEqual([...NO_AUTO_EXCLUDE_DOMAINS]);
    expect(sqlLists("nothing")).toEqual([]);
  });
});
