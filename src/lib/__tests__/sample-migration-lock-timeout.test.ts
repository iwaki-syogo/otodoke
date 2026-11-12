import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("bounds sample-generation DDL lock waits at the start of its transaction", () => {
  const sql = readFileSync(new URL("../../../supabase/migrations/20261113110000_sample_generation.sql", import.meta.url), "utf8")
    .replace(/--[^\n]*/g, " ").trim();
  expect(sql).toMatch(/^begin;\s*set local lock_timeout\s*=\s*'5s';/i);
});
