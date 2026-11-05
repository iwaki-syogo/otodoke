import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/env", () => ({ env: () => ({}) }));

/**
 * inbox_addresses.local_part has a CHECK (migration 20261106110000) that must accept everything
 * src/lib/inbox.ts generates and nothing else. The pattern is written twice (SQL and TS), so
 * this compares them and runs the generator against the SQL pattern.
 */
const root = path.resolve(__dirname, "../../..");
const migration = readFileSync(path.join(root, "supabase/migrations/20261106110000_inbox_local_part_format.sql"), "utf8");
const verify = readFileSync(path.join(root, "supabase/verify/20261106110000_inbox_local_part_format.sql"), "utf8");

function sqlPattern(sql: string): string {
  const m = sql.match(/local_part ~ '([^']+)'/);
  if (!m) throw new Error("no local_part pattern in the migration");
  return m[1];
}

describe("inbox local_part format", () => {
  it("the CHECK is exactly the generator's alphabet and length", async () => {
    const { LOCAL_PART_ALPHABET, LOCAL_PART_LENGTH } = await import("../inbox");
    expect(sqlPattern(migration)).toBe(`^[${LOCAL_PART_ALPHABET}]{${LOCAL_PART_LENGTH}}$`);
  });

  it("the verify query uses the same pattern in every place", () => {
    const patterns = [...verify.matchAll(/local_part !~ '([^']+)'/g)].map((m) => m[1]);
    expect(patterns.length).toBeGreaterThanOrEqual(2);
    for (const p of patterns) expect(p).toBe(sqlPattern(migration));
    // Read only: nothing in it changes data.
    expect(verify).not.toMatch(/\b(insert|update|delete|alter|drop|create|truncate|grant|revoke)\b/i);
  });

  it("every generated local part passes the CHECK", async () => {
    const { randomLocalPart } = await import("../inbox");
    // Postgres ARE and JS agree on this pattern (a plain bracket list, no ranges or classes).
    const re = new RegExp(sqlPattern(migration));
    for (let i = 0; i < 2000; i++) {
      const value = randomLocalPart();
      expect(re.test(value), value).toBe(true);
    }
  });

  it("rejects names a user could try to claim", () => {
    const re = new RegExp(sqlPattern(migration));
    for (const value of ["support", "info", "postmaster", "abcdefghij0", "ABCDEFGHJK", "abcdefghjk ", "abcdefghik", "abcdefgh1j", "a.bcdefghj"]) {
      expect(re.test(value), value).toBe(false);
    }
  });
});
