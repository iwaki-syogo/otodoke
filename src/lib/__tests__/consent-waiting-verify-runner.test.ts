import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const runner = new URL("../../../tests/postgres/run-consent-waiting-storage.mjs", import.meta.url);
const source = readFileSync(runner, "utf8");

describe("consent storage runner respects each verify result layout", () => {
  it("executes child stdout through the same file-aware boundary without PostgreSQL", () => {
    const output = execFileSync(process.execPath, [fileURLToPath(runner), "--self-test"], { encoding: "utf8", timeout: 15_000 });
    expect(output).toContain("OK: self-test (per-file verdict columns through child stdout and the real verifyFile path");
    expect(output).toContain("malformed/FAILED/error rejection");
    expect(output).toContain("NOT RUN: PostgreSQL startup");
    expect(output).not.toContain("verdict=FAILED");
  });

  it("uses that parser on the real before, rollback verification and reapply paths", () => {
    const main = source.slice(source.indexOf("async function main(mode)"));
    expect(main).toMatch(/const verify\s*=\s*async\s*\(name\)\s*=>\s*\{\s*await verifyFile\(name, file\)/);
    expect(main).toContain('await verify(`supabase/verify/${target}.before.sql`)');
    expect(main).toContain('await verify("supabase/verify/20261113110000_sample_generation.sql")');
    expect(main).toContain('await verify(`supabase/verify/${target}.sql`)');
    expect(main).not.toContain("requireVerdict(");
    const wrapper = source.match(/export async function verifyFile\(name, execute\)\s*\{([^}]+)\}/)?.[1];
    expect(wrapper).toContain("requireStorageVerifyVerdict(await execute(name), name)");
  });
});
